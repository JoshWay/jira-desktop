// Security boundary (spec R2): window prefs, navigation / redirect / window.open policy,
// permissions and <webview>. Everything runs offline through the harness interceptor;
// shell.openExternal is the harness recorder, so nothing ever reaches the OS.
import type { ElectronApplication, Page } from '@playwright/test'
import { resolve } from 'node:path'
import { E2E_SITE_URL, expect, test } from './helpers/app'
import type { LaunchedApp } from './helpers/app'
import { DIALOG_PAGE, closeVia, openDialog } from './helpers/dialog'

interface NavigationRecord {
  event: 'will-navigate' | 'will-redirect'
  url: string
  prevented: boolean
}

declare global {
  // Installed by watchNavigations in the Electron main process
  var __securityE2E: { navigations: NavigationRecord[] } | undefined
}

// The site every launch here is configured for (written to settings.json by the fixture)
const START_URL = E2E_SITE_URL

// Records every main-frame navigation/redirect on every contents (current and future), after the
// app's own policy listener has run, so `prevented` is the policy's verdict.
async function watchNavigations(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(({ app: electronApp, webContents }) => {
    const state = (globalThis.__securityE2E = { navigations: [] as NavigationRecord[] })
    const attach = (contents: Electron.WebContents): void => {
      for (const name of ['will-navigate', 'will-redirect'] as const) {
        contents.on(name as 'will-navigate', (event) => {
          if (event.isMainFrame) state.navigations.push({ event: name, url: event.url, prevented: event.defaultPrevented })
        })
      }
    }
    webContents.getAllWebContents().forEach(attach)
    electronApp.on('web-contents-created', (_, contents) => attach(contents))
  })
}

async function navigations(app: LaunchedApp): Promise<NavigationRecord[]> {
  return app.electronApp.evaluate(() => globalThis.__securityE2E!.navigations)
}

// Starts a renderer-initiated navigation and waits until the policy has ruled on it
async function navigate(app: LaunchedApp, page: Page, url: string): Promise<NavigationRecord> {
  await page.evaluate((target) => { window.location.href = target }, url)
  await expect.poll(async () => (await navigations(app)).some((n) => n.url === url)).toBe(true)
  return (await navigations(app)).find((n) => n.url === url)!
}

async function prefsOf(electronApp: ElectronApplication, url: string) {
  // Playwright reports a popup once its page has the URL; the main process's webContents.getURL()
  // can catch up a moment later on a loaded machine, so wait for main to see the window first
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL() === target), url)).toBe(true)
  return electronApp.evaluate(({ BrowserWindow, session }, target) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === target)
    if (!win) throw new Error(`no window at ${target}`)
    // Electron 44 leaves `preload` out of getLastWebPreferences; _getPreloadScript has it
    const contents = win.webContents as Electron.WebContents & {
      getLastWebPreferences(): Electron.WebPreferences
      _getPreloadScript?: () => unknown
    }
    if (typeof contents._getPreloadScript !== 'function') throw new Error('Electron no longer has webContents._getPreloadScript')
    const p = contents.getLastWebPreferences()
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      webSecurity: p.webSecurity,
      preload: contents._getPreloadScript(),
      isDefaultSession: contents.session === session.defaultSession
    }
  }, url)
}

const SECURE_PREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: null }

async function pageGlobals(page: Page) {
  return page.evaluate(() => ({
    electronAPI: typeof (window as unknown as Record<string, unknown>).electronAPI,
    require: typeof (window as unknown as Record<string, unknown>).require,
    process: typeof (window as unknown as Record<string, unknown>).process
  }))
}

const NO_BRIDGE = { electronAPI: 'undefined', require: 'undefined', process: 'undefined' }

test('main window is sandboxed, isolated, has no preload, no bridge and no remote IPC handlers', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)

  expect(await prefsOf(app.electronApp, START_URL)).toMatchObject({ ...SECURE_PREFS, isDefaultSession: true })
  expect(await pageGlobals(page)).toEqual(NO_BRIDGE)
  expect(await app.electronApp.evaluate(({ session }) => session.defaultSession.getPreloadScripts().length)).toBe(0)

  // The old remote API's handlers are gone: registering them again succeeds
  const stillRegistered = await app.electronApp.evaluate(({ ipcMain }) =>
    ['get-theme', 'set-jira-url', 'show-context-menu'].filter((channel) => {
      try {
        ipcMain.handle(channel, () => null)
        ipcMain.removeHandler(channel)
        return false
      } catch {
        return true
      }
    })
  )
  expect(stillRegistered).toEqual([])
})

test('a WindowManager window shares the default session and is equally locked down', async ({ launchApp }) => {
  const app = await launchApp()
  await app.electronApp.firstWindow()
  const target = 'https://team.atlassian.net/wiki/spaces/X'

  // Through the New Atlassian Window dialog
  const dialog = await openDialog(app, 'New Atlassian Window...')
  const windowOpened = app.electronApp.waitForEvent('window', { predicate: (p) => p.url() === target })
  await dialog.locator('#url').fill(target)
  await dialog.locator('#background').check()
  await closeVia(dialog, () => dialog.locator('#submit').click())
  const extra = await windowOpened

  expect(await prefsOf(app.electronApp, target)).toMatchObject({ ...SECURE_PREFS, isDefaultSession: true })
  expect(await pageGlobals(extra)).toEqual(NO_BRIDGE)
  expect(await app.requests()).toContainEqual({ url: target, method: 'GET', session: 'default', servedWith: 'stub-page' })
})

test('navigation to a look-alike host is blocked and handed to the browser; non-safe schemes are blocked and never opened', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  for (const url of ['smb://x/y', 'ms-msdt:/id', 'vscode://file/etc/passwd']) {
    expect(await navigate(app, page, url)).toMatchObject({ prevented: true })
  }
  expect(page.url()).toBe(START_URL)
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
  // Stopped before Chromium's own OS hand-off was even asked for (the harness refuses it anyway)
  expect(await app.stubCalls('permission', 'openExternal')).toEqual([])

  const lookAlike = 'https://atlassian.net.evil.test/'
  expect(await navigate(app, page, lookAlike)).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([[lookAlike]])
  expect(page.url()).toBe(START_URL)
  expect((await app.requests()).map((r) => r.url)).not.toContain(lookAlike)

  // Three more external opens back to back: let the app-wide budget (a burst of 3, refilled at
  // about one a second) fill up again first. Time passing is all this needs, so load cannot break it.
  await page.waitForTimeout(1_100)
  for (const url of ['https://evilatlassian.net/', 'http://team.atlassian.net/', 'mailto:a@b.test']) {
    expect(await navigate(app, page, url)).toMatchObject({ prevented: true })
  }
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([
    [lookAlike],
    ['https://evilatlassian.net/'],
    ['http://team.atlassian.net/'],
    ['mailto:a@b.test']
  ])
  expect(page.url()).toBe(START_URL)
})

test('navigation within the app and to auth hosts is allowed; redirects are governed too', async ({ launchApp }) => {
  const app = await launchApp({
    routes: [
      { url: 'https://team.atlassian.net/out', response: { status: 302, headers: { location: 'https://evil.test/landing' }, body: '' } },
      { url: 'https://team.atlassian.net/sso', response: { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2' }, body: '' } }
    ]
  })
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  expect(await navigate(app, page, 'https://team.atlassian.net/jira')).toMatchObject({ prevented: false })
  await expect(page).toHaveURL('https://team.atlassian.net/jira')

  expect(await navigate(app, page, 'https://team.atlassian.net/sso')).toMatchObject({ prevented: false })
  await expect(page).toHaveURL('https://accounts.google.com/o/oauth2')

  expect(await navigate(app, page, 'https://team.atlassian.net/out')).toMatchObject({ prevented: false })
  await expect.poll(async () => (await navigations(app)).find((n) => n.url === 'https://evil.test/landing')).toEqual({
    event: 'will-redirect',
    url: 'https://evil.test/landing',
    prevented: true
  })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://evil.test/landing']])
  expect(page.url()).toBe('https://accounts.google.com/o/oauth2')
  expect((await app.requests()).map((r) => r.url)).not.toContain('https://evil.test/landing')
})

test('an in-app window.open that redirects off-site is governed even though main loads it', async ({ launchApp }) => {
  const app = await launchApp({
    routes: [{ url: 'https://team.atlassian.net/out', response: { status: 302, headers: { location: 'https://evil.test/opener' }, body: 'moved' } }]
  })
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  // load-in-opener is a main-initiated loadURL (no will-navigate); the redirect must still be caught
  expect(await page.evaluate(() => window.open('https://team.atlassian.net/out') === null)).toBe(true)
  await expect.poll(async () => (await navigations(app)).find((n) => n.url === 'https://evil.test/opener')).toEqual({
    event: 'will-redirect',
    url: 'https://evil.test/opener',
    prevented: true
  })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://evil.test/opener']])
  expect(page.url()).toBe(START_URL)
  expect((await app.requests()).map((r) => r.url)).not.toContain('https://evil.test/opener')
})

test('window.open: auth opens a sandboxed child under the same policy; smb: creates nothing and calls nothing', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)
  const windowCount = () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  expect(await windowCount()).toBe(1)

  const authUrl = 'https://accounts.google.com/x'
  const childOpened = app.electronApp.waitForEvent('window')
  await page.evaluate((url) => { window.open(url) }, authUrl)
  const child = await childOpened
  await expect(child).toHaveURL(authUrl)
  expect(await prefsOf(app.electronApp, authUrl)).toMatchObject({ ...SECURE_PREFS, isDefaultSession: true })
  expect(await pageGlobals(child)).toEqual(NO_BRIDGE)
  // The child is governed by the same policy (web-contents-created covers it)
  expect(await navigate(app, child, 'https://atlassian.net.evil.test/popup')).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://atlassian.net.evil.test/popup']])
  expect(child.url()).toBe(authUrl)
  expect(await windowCount()).toBe(2)

  // Hostile window features cannot loosen the popup's prefs
  const hostileUrl = 'https://login.microsoftonline.com/common'
  const hostileOpened = app.electronApp.waitForEvent('window', { predicate: (p) => p.url() === hostileUrl })
  await page.evaluate((url) => { window.open(url, '', 'nodeIntegration=yes,sandbox=no,contextIsolation=no,webSecurity=no,preload=/tmp/x.js') }, hostileUrl)
  const hostile = await hostileOpened
  expect(await prefsOf(app.electronApp, hostileUrl)).toMatchObject({ ...SECURE_PREFS, isDefaultSession: true })
  expect(await pageGlobals(hostile)).toEqual(NO_BRIDGE)
  await hostile.close()
  await expect.poll(windowCount).toBe(2)

  // Non-safe schemes: no window, no OS hand-off. The external sentinel proves the handler ran after them.
  const results = await page.evaluate(() => [window.open('smb://x/y') === null, window.open('file:///etc/passwd') === null])
  expect(results).toEqual([true, true])
  await page.evaluate(() => { window.open('https://example.com/sentinel') })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([
    ['https://atlassian.net.evil.test/popup'],
    ['https://example.com/sentinel']
  ])
  expect(await windowCount()).toBe(2)
  expect(await app.stubCalls('permission', 'openExternal')).toEqual([])

  // In-app: denied as a window, loaded in the opener instead (existing UX)
  expect(await page.evaluate(() => window.open('https://team.atlassian.net/browse/X-1') === null)).toBe(true)
  await expect(page).toHaveURL('https://team.atlassian.net/browse/X-1')
  expect(await windowCount()).toBe(2)
})

// Electron has no popup blocker, so a page on a suffix-matched IdP tenant could loop window.open.
// The cap is app-wide and counts popups opened by popups; a closed popup frees its slot.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts -g "auth popups are capped"
test('window.open: live auth popups are capped app-wide, chained popups included', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  const windowCount = () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const CAP = 3

  const opened = await page.evaluate(() =>
    Array.from({ length: 20 }, (_, i) => window.open(`https://evil.us.auth0.com/flood/${i}`) !== null)
  )
  // window.open runs the handler synchronously, so this is final: the first CAP got windows
  expect(opened).toEqual(Array.from({ length: 20 }, (_, i) => i < CAP))
  expect(await windowCount()).toBe(1 + CAP)

  // A popup is governed by the same, shared cap: it cannot open more
  const popup = app.electronApp.windows().find((p) => p.url().startsWith('https://evil.us.auth0.com/flood/'))
    ?? (await app.electronApp.waitForEvent('window', { predicate: (p) => p.url().startsWith('https://evil.us.auth0.com/flood/') }))
  await expect(popup).toHaveURL(/^https:\/\/evil\.us\.auth0\.com\/flood\//)
  expect(await popup.evaluate(() => Array.from({ length: 5 }, () => window.open('https://login.microsoftonline.com/chain') !== null))).toEqual(
    [false, false, false, false, false]
  )
  expect(await windowCount()).toBe(1 + CAP)

  // Closing one frees exactly one slot
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('https://evil.us.auth0.com/flood/'))!.destroy()
  })
  await expect.poll(windowCount).toBe(CAP)
  await expect.poll(() => page.evaluate(() => window.open('https://accounts.google.com/again') !== null)).toBe(true)
  expect(await page.evaluate(() => window.open('https://accounts.google.com/over') !== null)).toBe(false)
  expect(await windowCount()).toBe(1 + CAP)
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
})

// The external-open flood (window.open or navigation loops to the browser or mail client) is
// limited by one app-wide token bucket: a burst of 3, then about one a second. The bound allows
// for whatever refilled while the loop ran, so a slow machine cannot make it flaky.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts -g "external opens are rate limited"
test('window.open: external opens are rate limited app-wide', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  const BURST = 3

  const started = await app.electronApp.evaluate(() => Date.now())
  const results = await page.evaluate(() => Array.from({ length: 20 }, (_, i) => window.open(`https://example.com/flood/${i}`) === null))
  const elapsedMs = (await app.electronApp.evaluate(() => Date.now())) - started
  expect(results.every(Boolean)).toBe(true)

  // The handler ran synchronously for every call, so the recorder is final
  const calls = await app.stubCalls('shell', 'openExternal')
  expect(calls.length).toBeGreaterThanOrEqual(BURST)
  expect(calls.length).toBeLessThanOrEqual(BURST + Math.floor(elapsedMs / 1000))
  // In order, from the start of the loop
  expect(calls.slice(0, BURST)).toEqual([['https://example.com/flood/0'], ['https://example.com/flood/1'], ['https://example.com/flood/2']])
  expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

  // The budget refills: after a pause, opens get through again
  await expect.poll(async () => {
    await page.evaluate(() => { window.open('https://example.com/later') })
    return (await app.stubCalls('shell', 'openExternal')).some(([url]) => url === 'https://example.com/later')
  }, { timeout: 10_000, intervals: [500] }).toBe(true)
})

test('permissions: in-app content gets notifications but not media; other origins get nothing', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)

  expect(await page.evaluate(() => Notification.requestPermission())).toBe('granted')
  expect(await page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('granted')
  expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e: Error) => e.name))).toBe('NotAllowedError')
  expect(await page.evaluate(() => navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state))).toBe('denied')

  // Auth hosts are allowed to load, not to hold permissions
  await page.evaluate(() => { window.location.href = 'https://accounts.google.com/signin' })
  await expect(page).toHaveURL('https://accounts.google.com/signin')
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
  expect(await page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('denied')
})

// The wiring must judge a frame by its own origin (requestingUrl / requestingOrigin), not by the
// page that embeds it. Only notifications tell the two apart: Electron does not apply Chrome's
// cross-origin-iframe notification block, and Permissions Policy does not cover them.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts -g "third-party frame"
test('permissions: a third-party frame inside an in-app page is judged by its own origin', async ({ launchApp }) => {
  const host = 'https://e2e.atlassian.net/jira'
  const app = await launchApp({
    routes: [{ url: host, response: { body: '<!doctype html><title>host</title><iframe src="https://evil.test/frame"></iframe>' } }]
  })
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await page.evaluate((url) => { window.location.href = url }, host)
  await expect(page).toHaveURL(host)
  await expect.poll(() => page.frames().find((f) => f.url() === 'https://evil.test/frame')?.evaluate(() => document.readyState)).toBe('complete')
  const frame = page.frames().find((f) => f.url() === 'https://evil.test/frame')!

  // Request handler (requestPermission) and check handler (permissions.query) both deny the frame...
  expect(await frame.evaluate(() => Notification.requestPermission())).toBe('denied')
  expect(await frame.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('denied')
  // ...while the in-app page around it still gets them
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('granted')
  expect(await page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('granted')
})

// Sessions other than the default one (partitions created later) get the same permission policy
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts -g "partition session"
test('permissions: a partition session created after startup gets the same policy', async ({ launchApp }) => {
  const app = await launchApp()
  await app.electronApp.firstWindow()
  const probeUrl = 'https://evil.test/probe'
  const opened = app.electronApp.waitForEvent('window', { predicate: (p) => p.url() === probeUrl })
  await app.electronApp.evaluate(({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:probe', sandbox: true, contextIsolation: true } })
    void win.loadURL(url)
  }, probeUrl)
  const probe = await opened
  expect(await probe.evaluate(() => Notification.requestPermission())).toBe('denied')
  expect(await probe.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('denied')
  expect(await app.requests()).toContainEqual({ url: probeUrl, method: 'GET', session: 'persist:probe', servedWith: 'stub-page' })
})

test('permissions: a subframe navigating to an unsafe scheme is refused by the app itself', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)

  // Subframe navigations skip the main-frame guard, so only the app's openExternal permission
  // denial stands between them and the OS. The frame is in-app, so an allow-list slip would grant.
  await page.evaluate(() => new Promise<void>((done) => {
    const frame = document.createElement('iframe')
    frame.src = 'https://id.atlassian.com/frame'
    frame.onload = () => done()
    document.body.append(frame)
  }))
  await page.evaluate(() => { document.querySelector('iframe')!.contentWindow!.location.href = 'smb://x/y' })
  await expect.poll(() => app.stubCalls('permission', 'openExternal')).toEqual([['smb://x/y', false]])
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
  expect(page.url()).toBe(START_URL)
})

test('<webview> attachment is always prevented', async ({ launchApp }) => {
  const app = await launchApp()
  await app.electronApp.firstWindow()
  const prevented = await app.electronApp.evaluate(({ BrowserWindow }) => {
    let wasPrevented = false
    const event = { preventDefault: () => { wasPrevented = true } }
    BrowserWindow.getAllWindows()[0].webContents.emit('will-attach-webview', event, {}, { src: 'https://team.atlassian.net/' })
    return wasPrevented
  })
  expect(prevented).toBe(true)
})

test('the Set URL dialog is confined to local pages, and the site it sets becomes in-app', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  const dialog = await openDialog(app, 'Set Jira URL...')
  const dialogUrl = dialog.url()
  expect(dialogUrl).toMatch(DIALOG_PAGE)

  // The dialog has a preload, so it is confined: even an in-app URL goes to the browser
  expect(await navigate(app, dialog, 'https://team.atlassian.net/')).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/']])
  expect(dialog.url()).toBe(dialogUrl)

  // ...but it can still load its own registered local page
  const again = `${dialogUrl}?again`
  expect(await navigate(app, dialog, again)).toMatchObject({ prevented: false })
  await expect(dialog).toHaveURL(again)
  await expect(dialog.locator('#url')).toHaveValue(START_URL)

  await dialog.locator('#url').fill('https://jira.corp.test/')
  await closeVia(dialog, () => dialog.locator('#submit').click())
  await expect(page).toHaveURL('https://jira.corp.test/')

  // The configured self-hosted site is in-app: navigation stays in the window and permissions apply
  expect(await navigate(app, page, 'https://jira.corp.test/browse/X-1')).toMatchObject({ prevented: false })
  await expect(page).toHaveURL('https://jira.corp.test/browse/X-1')
  expect(await page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('granted')
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/']])
})

// A do-nothing preload, so these tests never hand the app's real dialog bridge to remote content
const NOOP_PRELOAD = resolve(__dirname, 'fixtures/noop-preload.js')

test('a contents with a preload is confined even when it is not showing a local page', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  // Main may load what it likes; the policy governs what the page does next. Not registered as
  // privileged: only the preload itself (seen through _getPreloadScript) confines it.
  const preloaded = app.electronApp.waitForEvent('window', { predicate: (p) => p.url() === 'https://team.atlassian.net/start' })
  await app.electronApp.evaluate(({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } })
    void win.loadURL('https://team.atlassian.net/start')
  }, NOOP_PRELOAD)
  const other = await preloaded
  expect(await navigate(app, other, 'https://team.atlassian.net/next')).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/next']])
  expect(other.url()).toBe('https://team.atlassian.net/start')
  // The same kind of navigation from the main window (no preload) stays in-app
  expect(await navigate(app, page, 'https://team.atlassian.net/main-next')).toMatchObject({ prevented: false })
})

test('the dialog stays confined by the privileged registry even when Electron reports no preload', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  const dialog = await openDialog(app, 'Set Jira URL...')
  await watchNavigations(app)

  // Main loads remote content into the dialog and its internals are made to look unprivileged, so
  // neither its URL nor its prefs/preload confine it any more: only the registry does
  await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'))!
    const contents = win.webContents as unknown as Record<string, unknown>
    const plain = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false }
    contents.getLastWebPreferences = () => plain
    contents._getPreloadScript = () => null
    await win.loadURL('https://team.atlassian.net/in-dialog')
  })
  await expect(dialog).toHaveURL('https://team.atlassian.net/in-dialog')
  expect(await navigate(app, dialog, 'https://team.atlassian.net/next')).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/next']])
  expect(dialog.url()).toBe('https://team.atlassian.net/in-dialog')

  // Its bridge still exists on the remote page, but the sender check refuses it (navigated URL)
  expect(await dialog.evaluate(() => (window as unknown as { dialogAPI: { getInit(): Promise<unknown> } }).dialogAPI
    .getInit().then(() => 'answered', () => 'rejected'))).toBe('rejected')
})

test('a contents whose Electron internals throw is confined, without a main-process exception', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  const breakInternal = (name: '_getPreloadScript' | 'getLastWebPreferences' | null) =>
    app.electronApp.evaluate(({ BrowserWindow }, method) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as Record<string, unknown>
      delete contents._getPreloadScript
      delete contents.getLastWebPreferences
      if (method) contents[method] = () => { throw new Error('internals changed') }
    }, name)

  await breakInternal('_getPreloadScript')
  // Navigation and window.open both treat it as confined: in-app URLs go to the browser
  expect(await navigate(app, page, 'https://team.atlassian.net/a')).toMatchObject({ prevented: true })
  expect(await page.evaluate(() => window.open('https://team.atlassian.net/b') === null)).toBe(true)
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/a'], ['https://team.atlassian.net/b']])

  await breakInternal('getLastWebPreferences')
  expect(await navigate(app, page, 'https://team.atlassian.net/c')).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toHaveLength(3)
  expect(page.url()).toBe(START_URL)

  // Restored: the same contents is unconfined again, so the throws were the only cause
  await breakInternal(null)
  expect(await navigate(app, page, 'https://team.atlassian.net/d')).toMatchObject({ prevented: false })
  // An exception in a policy listener would have reached Electron's default handler (showErrorBox)
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([])
})
