// Proves the e2e harness itself works, so later specs can trust it.
import { expect, test } from './helpers/app'

test('serves configured routes and forced network errors', async ({ launchApp }) => {
  const app = await launchApp({
    routes: [{ url: 'https://id.atlassian.com/*', response: { body: '<title>Configured login</title>' } }]
  })
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveTitle('Configured login')

  await app.setRoutes([{ url: 'https://broken.atlassian.net/', response: { kind: 'network-error' } }])
  const loadError = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    try {
      await BrowserWindow.getAllWindows()[0].loadURL('https://broken.atlassian.net/')
      return null
    } catch (error) {
      return (error as Error).message
    }
  })
  expect(loadError).toContain('ERR_FAILED')
  expect(await app.requests()).toContainEqual(expect.objectContaining({ url: 'https://broken.atlassian.net/', servedWith: 'network-error' }))
})

test('intercepts partition sessions created after startup', async ({ launchApp }) => {
  const app = await launchApp()
  await app.electronApp.firstWindow()
  const status = await app.electronApp.evaluate(async ({ session }) => {
    const response = await session.fromPartition('persist:atlassian-shared').fetch('http://example.atlassian.net/')
    return response.status
  })
  expect(status).toBe(200)
  expect(await app.requests()).toContainEqual({
    url: 'http://example.atlassian.net/',
    method: 'GET',
    session: 'persist:atlassian-shared',
    servedWith: 'stub-page'
  })
})

test('records requests that bypass the interceptor as escaped', async ({ launchApp, escapeSink }) => {
  const app = await launchApp()
  await app.electronApp.firstWindow()
  const outcome = await app.electronApp.evaluate(async ({ session }) => {
    try {
      await session.defaultSession.fetch('https://escape-probe.invalid/', { bypassCustomProtocolHandlers: true })
      return 'reached'
    } catch {
      return 'failed'
    }
  })
  expect(outcome).toBe('failed')
  // Drain so the fixture's zero-escape check passes for this deliberate escape
  expect(escapeSink.drain()).toEqual([expect.objectContaining({ requestLine: expect.stringMatching(/^CONNECT escape-probe\.invalid:443 /) })])
})

test('replaces OS hand-offs and blocking dialogs with recorders by default', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()

  // A renderer-initiated navigation off Atlassian is handed to the OS browser by the app;
  // no stub was installed by the test, so this hits the default recorder, not the real browser
  await page.evaluate(() => { window.location.href = 'https://example.com/elsewhere' })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://example.com/elsewhere']])

  // Would otherwise open a file / block the main process on a modal
  const results = await app.electronApp.evaluate(async ({ dialog, shell }) => {
    dialog.showErrorBox('E2E title', 'E2E content')
    return { openPath: await shell.openPath('/nonexistent') }
  })
  expect(results).toEqual({ openPath: '' })
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([['E2E title', 'E2E content']])
  expect(await app.stubCalls('shell', 'openPath')).toEqual([['/nonexistent']])
})

test('refuses and records Chromium\'s own OS protocol hand-off, whatever handler the app sets', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL('https://id.atlassian.com/login')
  // Simulate a broken app: no navigation guard, and a permission handler that grants everything.
  // The probe scheme is unregistered, so even a harness failure here opens nothing.
  await app.electronApp.evaluate(({ BrowserWindow, session }) => {
    BrowserWindow.getAllWindows()[0].webContents.removeAllListeners('will-navigate')
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true))
  })
  await page.evaluate(() => { window.location.href = 'jira-desktop-e2e-probe://x/y' })
  await expect.poll(() => app.stubCalls('permission', 'openExternal')).toEqual([['jira-desktop-e2e-probe://x/y']])
  // Other permissions still reach the app's handler
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('granted')
})

test('applies launch-time stubs before the app starts, and stubs after launch', async ({ launchApp }) => {
  const app = await launchApp({
    stubs: [
      // The app calls this inside its own whenReady callback, so a recorded call proves the stub
      // was in place before any app startup code ran
      { module: 'Menu', method: 'setApplicationMenu' },
      { module: 'dialog', method: 'showMessageBox', returnValue: { response: 2, checkboxChecked: false }, async: true }
    ]
  })
  await app.electronApp.firstWindow()
  // Electron's default-menu setup may call it too; look for the app's own 'Jira Desktop' menu
  const appMenuLabels = await app.electronApp.evaluate(() =>
    globalThis.__jiraDesktopE2E!.calls['Menu.setApplicationMenu'].map(([menu]) => (menu as Electron.Menu | null)?.items[0]?.label ?? null)
  )
  expect(appMenuLabels).toContain('Jira Desktop')

  const launchTimeResponse = await app.electronApp.evaluate(({ dialog }) => dialog.showMessageBox({ message: 'E2E' }))
  expect(launchTimeResponse).toEqual({ response: 2, checkboxChecked: false })

  await app.stubMain({ module: 'dialog', method: 'showMessageBox', returnValue: { response: 0, checkboxChecked: true }, async: true })
  const lateResponse = await app.electronApp.evaluate(({ dialog }) => dialog.showMessageBox({ message: 'E2E again' }))
  expect(lateResponse).toEqual({ response: 0, checkboxChecked: true })
  expect(await app.stubCalls('dialog', 'showMessageBox')).toEqual([[{ message: 'E2E again' }]])
})

test('relaunches against the same userData dir', async ({ launchApp }) => {
  const first = await launchApp()
  await first.electronApp.firstWindow()
  await first.electronApp.evaluate(async ({ session }) => {
    const cookies = session.defaultSession.cookies
    await cookies.set({ url: 'https://id.atlassian.com/', name: 'e2e', value: 'kept', expirationDate: Date.now() / 1000 + 3600 })
    await cookies.flushStore()
  })
  await first.close()

  const second = await launchApp({ userDataDir: first.userDataDir })
  await second.electronApp.firstWindow()
  expect(await second.electronApp.evaluate(({ app }) => app.getPath('userData'))).toBe(first.userDataDir)
  const cookies = await second.electronApp.evaluate(({ session }) => session.defaultSession.cookies.get({ name: 'e2e' }))
  expect(cookies.map((cookie) => cookie.value)).toEqual(['kept'])
})

test('keeps windows off the user\'s screen and out of focus', async ({ launchApp }) => {
  test.skip(process.env.JIRA_DESKTOP_E2E_HEADED === '1', 'headed runs show real windows')
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  const mainWindow = await app.electronApp.browserWindow(page)
  await expect.poll(() => mainWindow.evaluate((win) => win.isVisible())).toBe(true)

  // The app (or a test) asking for focus/front must not get it
  const state = await app.electronApp.evaluate(({ BrowserWindow, app: electronApp }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.show()
    win.focus()
    win.moveTop()
    return {
      focused: win.isFocused(),
      focusedWindow: BrowserWindow.getFocusedWindow() !== null,
      opacity: process.platform === 'linux' ? 0 : win.getOpacity(),
      x: win.getPosition()[0],
      dockVisible: process.platform === 'darwin' ? electronApp.dock?.isVisible() : false
    }
  })
  expect(state).toEqual({ focused: false, focusedWindow: false, opacity: 0, x: expect.any(Number), dockVisible: false })
  expect(state.x).toBeLessThan(0)
  // Rendering is not throttled: timers in the page keep firing at full rate
  const ticks = await page.evaluate(() => new Promise<number>((done) => {
    let count = 0
    const id = setInterval(() => count++, 10)
    setTimeout(() => { clearInterval(id); done(count) }, 500)
  }))
  expect(ticks).toBeGreaterThan(30)
  expect(await app.windowFocusEvents()).toBe(0)
})
