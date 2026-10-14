// Security boundary (spec R2): window prefs, navigation / redirect / window.open policy,
// permissions and <webview>. Everything runs offline through the harness interceptor;
// shell.openExternal is the harness recorder, so nothing ever reaches the OS.
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './helpers/app'
import type { LaunchedApp } from './helpers/app'
import { DIALOG_PAGE, openDialog } from './helpers/dialog'

interface NavigationRecord {
  event: 'will-navigate' | 'will-redirect'
  url: string
  prevented: boolean
}

declare global {
  // Installed by watchNavigations in the Electron main process
  var __securityE2E: { navigations: NavigationRecord[] } | undefined
}

const START_URL = 'https://id.atlassian.com/login'

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
  return electronApp.evaluate(({ BrowserWindow, session }, target) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === target)
    if (!win) throw new Error(`no window at ${target}`)
    // Electron 44 leaves `preload` out of getLastWebPreferences; _getPreloadScript has it
    const contents = win.webContents as Electron.WebContents & {
      getLastWebPreferences(): Electron.WebPreferences
      _getPreloadScript(): { filePath: string } | null
    }
    const p = contents.getLastWebPreferences()
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      webSecurity: p.webSecurity,
      preload: contents._getPreloadScript()?.filePath ?? null,
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
  await dialog.locator('#submit').click()
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
  await dialog.locator('#submit').click()
  await expect(page).toHaveURL('https://jira.corp.test/')

  // The configured self-hosted site is in-app: navigation stays in the window and permissions apply
  expect(await navigate(app, page, 'https://jira.corp.test/browse/X-1')).toMatchObject({ prevented: false })
  await expect(page).toHaveURL('https://jira.corp.test/browse/X-1')
  expect(await page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((s) => s.state))).toBe('granted')
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/']])
})

test('a contents with a preload is confined even when it is not showing a local page', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  await watchNavigations(app)

  // Main may load what it likes; the policy governs what the page does next
  const preloaded = app.electronApp.waitForEvent('window', { predicate: (p) => p.url() === 'https://team.atlassian.net/start' })
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: `${process.cwd()}/dist/preload/dialog.js`, sandbox: true, contextIsolation: true }
    })
    void win.loadURL('https://team.atlassian.net/start')
  })
  const other = await preloaded
  expect(await navigate(app, other, 'https://team.atlassian.net/next')).toMatchObject({ prevented: true })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://team.atlassian.net/next']])
  expect(other.url()).toBe('https://team.atlassian.net/start')
  // The same kind of navigation from the main window (no preload) stays in-app
  expect(await navigate(app, page, 'https://team.atlassian.net/main-next')).toMatchObject({ prevented: false })
})
