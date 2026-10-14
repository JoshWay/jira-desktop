// Startup and recovery (spec R3): first-run setup, the saved site and its re-validation, the
// load-error view with Retry / Change URL, the persisted theme and window bounds, and the
// single-instance lock. Offline through the harness; unit coverage for the pure rules is in
// tests/unit/mainWindowRules.test.ts and tests/unit/windowBounds.test.ts.
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { E2E_SITE_URL, expect, runAnotherInstance, test } from './helpers/app'
import type { LaunchedApp } from './helpers/app'
import { DIALOG_PAGE, PLACEHOLDER_PAGE, clickMenu, closeVia, waitForDialog } from './helpers/dialog'

const PLACEHOLDER_CSP = "default-src 'none'; style-src 'unsafe-inline'"

async function savedSettings(userDataDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf-8')) as Record<string, unknown>
}

async function windowCount(app: LaunchedApp): Promise<number> {
  return app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

// The app's main window: the first window, never the dialog
async function mainPage(app: LaunchedApp): Promise<Page> {
  const page = await app.electronApp.firstWindow()
  expect(page.url()).not.toMatch(DIALOG_PAGE)
  return page
}

test('first run shows the welcome view and dialog; the URL it sets is saved, loaded and kept for the next launch', async ({ launchApp }) => {
  // Jira redirects its site root; leaving the placeholder must not leave the window confined
  const routes = [{ url: 'https://acme.atlassian.net/jira', response: { status: 302, headers: { location: 'https://acme.atlassian.net/jira/your-work' }, body: '' } }]
  const app = await launchApp({ settings: null, routes })
  const page = await mainPage(app)
  await expect(page).toHaveURL(PLACEHOLDER_PAGE)

  // The placeholder is static and script-free, under its own strict CSP, and the main window still
  // has no preload and no bridge
  expect(await page.evaluate(() => ({
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    scripts: document.scripts.length,
    bridge: typeof (window as unknown as Record<string, unknown>).dialogAPI
  }))).toEqual({ csp: PLACEHOLDER_CSP, scripts: 0, bridge: 'undefined' })
  expect(await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__inlineRan = true'
    document.head.append(script)
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false
  })).toBe(false)
  expect(await app.electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => /placeholder\.html$/.test(w.webContents.getURL()))!
    return (main.webContents as Electron.WebContents & { _getPreloadScript(): unknown })._getPreloadScript()
  })).toBeNull()

  const dialog = await waitForDialog(app)
  await expect(dialog.locator('#heading')).toHaveText('Welcome to Jira Desktop')
  await expect(dialog.locator('#url')).toHaveValue('')
  await expect(dialog.locator('#change-url')).toBeHidden()
  // Nothing remote was loaded: in particular no login or marketing page
  expect(await app.requests()).toEqual([])

  // Atlassian's own login / marketing pages are refused inline
  await dialog.locator('#url').fill('atlassian.net')
  await dialog.locator('#submit').click()
  await expect(dialog.locator('#error')).toHaveText("That is Atlassian's own page. Enter your Jira site, such as your-team.atlassian.net.")
  expect(await app.requests()).toEqual([])

  await dialog.locator('#url').fill('acme.atlassian.net')
  await closeVia(dialog, () => dialog.locator('#submit').click())
  await expect(page).toHaveURL('https://acme.atlassian.net/jira/your-work')
  // Persisted at once, not only on quit
  expect((await savedSettings(app.userDataDir)).jiraUrl).toBe('https://acme.atlassian.net/jira')
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
  await app.close()

  // Next launch: straight to the saved site, no setup
  const again = await launchApp({ userDataDir: app.userDataDir, routes })
  const next = await mainPage(again)
  await expect(next).toHaveURL('https://acme.atlassian.net/jira/your-work')
  expect((await again.requests())[0]).toMatchObject({ url: 'https://acme.atlassian.net/jira', servedWith: 'route' })
  expect(await windowCount(again)).toBe(1)
})

test('a poisoned saved URL is never loaded: setup runs instead; a hand-edited one is normalized', async ({ launchApp }) => {
  // The last: what the app used to start on, which is never a site
  for (const jiraUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'https://id.atlassian.com/login']) {
    const app = await launchApp({ settings: { jiraUrl } })
    const page = await mainPage(app)
    await expect(page).toHaveURL(PLACEHOLDER_PAGE)
    const dialog = await waitForDialog(app)
    await expect(dialog.locator('#heading')).toHaveText('Welcome to Jira Desktop')
    expect(await app.requests()).toEqual([])
    await app.close()
  }

  const app = await launchApp({ settings: { jiraUrl: 'Acme.Atlassian.net' } })
  await expect(await mainPage(app)).toHaveURL('https://acme.atlassian.net/jira')
})

test('a failed load shows the error view with the URL as text; Retry reloads it, IPC answers only the dialog', async ({ launchApp }) => {
  const app = await launchApp({ routes: [{ url: E2E_SITE_URL, response: { kind: 'network-error' } }] })
  const page = await mainPage(app)
  await expect(page).toHaveURL(PLACEHOLDER_PAGE)

  const dialog = await waitForDialog(app)
  await expect(dialog.locator('#heading')).toHaveText('Couldn’t load Jira')
  await expect(dialog.locator('#failed-url')).toHaveText(E2E_SITE_URL)
  await expect(dialog.locator('#message')).toContainText('ERR_FAILED')
  await expect(dialog.locator('#url')).toBeHidden()
  await expect(dialog.locator('#change-url')).toBeVisible()
  await expect(dialog.locator('#submit')).toHaveText('Retry')
  expect(await dialog.evaluate(() => document.querySelector('#failed-url')!.children.length)).toBe(0)

  // Per-sender validation: the main window (now showing a local page itself) and a fake frame are
  // refused; the dialog's own main frame is answered
  const answers = await app.electronApp.evaluate(async ({ BrowserWindow, ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const all = BrowserWindow.getAllWindows()
    const dialogWindow = all.find((w) => /dialog\.html$/.test(w.webContents.getURL()))!
    const main = all.find((w) => /placeholder\.html$/.test(w.webContents.getURL()))!
    const call = async (sender: Electron.WebContents, frame: Electron.WebFrameMain, ...args: unknown[]) => {
      try {
        return await handlers.get(args.length ? 'dialog:submit' : 'dialog:get-init')!({ sender, senderFrame: frame }, ...args)
      } catch (error) {
        return `rejected: ${(error as Error).message}`
      }
    }
    return {
      fromMain: await call(main.webContents, main.webContents.mainFrame, { action: 'retry' }),
      mainFrameOfDialog: await call(main.webContents, dialogWindow.webContents.mainFrame),
      fromDialog: await call(dialogWindow.webContents, dialogWindow.webContents.mainFrame)
    }
  })
  expect(answers).toEqual({
    fromMain: 'rejected: dialog:submit: sender is not the expected local page',
    mainFrameOfDialog: 'rejected: dialog:get-init: sender is not the expected local page',
    fromDialog: { mode: 'load-error', failedUrl: E2E_SITE_URL, errorDescription: 'ERR_FAILED' }
  })
  // A payload the page cannot produce is rejected outright; the dialog stays open
  expect(await dialog.evaluate(() => (window as unknown as { dialogAPI: { submit(p: unknown): Promise<unknown> } }).dialogAPI
    .submit({ action: 'explode', url: 'https://evil.test/' }).then(() => 'resolved', () => 'rejected'))).toBe('rejected')
  expect(dialog.isClosed()).toBe(false)
  expect(page.url()).toMatch(PLACEHOLDER_PAGE)

  // The site is back (and redirects, as Jira does): Retry loads it in the main window
  await app.setRoutes([{ url: E2E_SITE_URL, response: { status: 302, headers: { location: `${E2E_SITE_URL}/your-work` }, body: '' } }])
  await closeVia(dialog, () => dialog.locator('#submit').click())
  await expect(page).toHaveURL(`${E2E_SITE_URL}/your-work`)
  await expect(page).toHaveTitle('E2E stub')
  await expect.poll(() => windowCount(app)).toBe(1)
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([])
})

test('a failed in-app navigation offers Change URL; aborted loads show no error view', async ({ launchApp }) => {
  const failing = `${E2E_SITE_URL}/browse/X-1`
  const app = await launchApp({
    routes: [
      { url: failing, response: { kind: 'network-error' } },
      { url: `${E2E_SITE_URL}/out`, response: { status: 302, headers: { location: 'https://evil.test/landing' }, body: '' } }
    ]
  })
  const page = await mainPage(app)
  await expect(page).toHaveURL(E2E_SITE_URL)

  // A redirect the policy prevents aborts the load (-3): handed to the browser, no error view
  await page.evaluate((url) => { window.location.href = url }, `${E2E_SITE_URL}/out`)
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://evil.test/landing']])
  await page.waitForTimeout(500)
  expect(await windowCount(app)).toBe(1)
  expect(page.url()).toBe(E2E_SITE_URL)

  await page.evaluate((url) => { window.location.href = url }, failing)
  const dialog = await waitForDialog(app)
  await expect(page).toHaveURL(PLACEHOLDER_PAGE)
  await expect(dialog.locator('#failed-url')).toHaveText(failing)

  // Change URL swaps the error view for the set-url dialog
  const opened = app.electronApp.waitForEvent('window')
  await closeVia(dialog, () => dialog.locator('#change-url').click())
  const setUrl = await opened
  await expect(setUrl).toHaveURL(DIALOG_PAGE)
  await expect(setUrl.locator('#heading')).toHaveText('Set Jira URL')
  await expect(setUrl.locator('#url')).toHaveValue(E2E_SITE_URL)
  await setUrl.locator('#url').fill('team.atlassian.net')
  await closeVia(setUrl, () => setUrl.locator('#submit').click())
  await expect(page).toHaveURL('https://team.atlassian.net/jira')
  expect((await savedSettings(app.userDataDir)).jiraUrl).toBe('https://team.atlassian.net/jira')
})

test('the Appearance radio sets the theme and persists across a relaunch', async ({ launchApp }) => {
  const app = await launchApp()
  await mainPage(app)
  const themeState = (launched: LaunchedApp) => launched.electronApp.evaluate(({ Menu, nativeTheme }) => {
    const view = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!
    const appearance = view.submenu!.items.find((i) => i.label === 'Appearance')!
    const all = Menu.getApplicationMenu()!.items.flatMap((i) => i.submenu?.items ?? [])
    return {
      themeSource: nativeTheme.themeSource,
      items: appearance.submenu!.items.map((i) => ({ label: i.label, type: i.type, checked: i.checked })),
      toggle: all.some((i) => i.label === 'Toggle Dark Mode')
    }
  })
  const radios = (checked: string) => ['System', 'Light', 'Dark'].map((label) => ({ label, type: 'radio', checked: label === checked }))

  expect(await themeState(app)).toEqual({ themeSource: 'system', items: radios('System'), toggle: false })
  await clickMenu(app, ['View', 'Appearance', 'Dark'])
  expect(await themeState(app)).toEqual({ themeSource: 'dark', items: radios('Dark'), toggle: false })
  expect(await app.electronApp.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(true)
  await app.close()
  expect((await savedSettings(app.userDataDir)).themeSource).toBe('dark')

  const again = await launchApp({ userDataDir: app.userDataDir })
  await mainPage(again)
  expect(await themeState(again)).toEqual({ themeSource: 'dark', items: radios('Dark'), toggle: false })
  await clickMenu(again, ['View', 'Appearance', 'Light'])
  expect(await themeState(again)).toEqual({ themeSource: 'light', items: radios('Light'), toggle: false })
})

test('main window bounds persist across a relaunch; off-screen bounds fall back to the default', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await mainPage(app)
  await expect(page).toHaveURL(E2E_SITE_URL)
  // Shown first: the harness parks a window off-screen whenever it is shown
  const mainWindow = await app.electronApp.browserWindow(page)
  await expect.poll(() => mainWindow.evaluate((win) => win.isVisible())).toBe(true)

  // Somewhere fully on the primary display (the harness only ever moves windows, never resizes)
  const target = await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    const bounds = {
      x: area.x + 40,
      y: area.y + 30,
      width: Math.max(800, Math.min(1000, area.width - 80)),
      height: Math.max(600, Math.min(700, area.height - 60))
    }
    BrowserWindow.getAllWindows()[0].setBounds(bounds)
    return bounds
  })
  await app.close()
  expect((await savedSettings(app.userDataDir)).mainWindow).toEqual({ bounds: target, isMaximized: false })

  const again = await launchApp({ userDataDir: app.userDataDir })
  await expect(await mainPage(again)).toHaveURL(E2E_SITE_URL)
  const restored = await again.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return { created: globalThis.__jiraDesktopE2E!.createdBounds[win.id], size: win.getSize() }
  })
  expect(restored).toEqual({ created: target, size: [target.width, target.height] })
  await again.close()

  // Saved somewhere no display shows (an unplugged monitor): the default size, not the saved one
  const offScreen = { bounds: { x: -40000, y: 40000, width: 900, height: 650 }, isMaximized: false }
  const moved = await launchApp({ settings: { jiraUrl: E2E_SITE_URL, mainWindow: offScreen } })
  await expect(await mainPage(moved)).toHaveURL(E2E_SITE_URL)
  const size = await moved.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  expect(size).not.toEqual([900, 650])
})

test('a second launch on the same profile exits and hands over to the first; other profiles run side by side', async ({ launchApp, escapeSink }) => {
  const app = await launchApp()
  await expect(await mainPage(app)).toHaveURL(E2E_SITE_URL)
  await app.electronApp.evaluate(({ app: electronApp }) => {
    const record = globalThis as unknown as { __secondInstances: number }
    record.__secondInstances = 0
    electronApp.on('second-instance', () => { record.__secondInstances++ })
  })

  expect(await runAnotherInstance(escapeSink, app.userDataDir)).toEqual({ code: 0, signal: null, killed: false })
  await expect.poll(() => app.electronApp.evaluate(() => (globalThis as unknown as { __secondInstances: number }).__secondInstances)).toBe(1)
  // The first instance kept its one window (restored and focused: a no-op under the harness)
  expect(await windowCount(app)).toBe(1)

  // The lock is per profile: an instance on another userData dir starts normally alongside
  const other = await launchApp()
  await expect(await mainPage(other)).toHaveURL(E2E_SITE_URL)
  expect(await windowCount(app)).toBe(1)
})
