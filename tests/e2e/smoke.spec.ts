import { expect, test } from './helpers/app'

test('launches, shows the main window and keeps all traffic local', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL('https://id.atlassian.com/login')
  await expect(page).toHaveTitle('E2E stub')

  const mainWindow = await app.electronApp.browserWindow(page)
  await expect.poll(() => mainWindow.evaluate((win) => win.isVisible())).toBe(true)

  // Current behaviour, recorded so Task 4 has one place to tighten it (sandbox -> true)
  const prefs = await mainWindow.evaluate((win) => {
    const p = win.webContents.getLastWebPreferences()
    return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, webSecurity: p?.webSecurity }
  })
  expect(prefs).toEqual({ sandbox: false, contextIsolation: true, nodeIntegration: false, webSecurity: true })

  // The profile lives in the per-test temp dir, never the real one
  const paths = await app.electronApp.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData'),
    sessionData: electronApp.getPath('sessionData')
  }))
  expect(paths).toEqual({ userData: app.userDataDir, sessionData: app.userDataDir })

  expect(await app.requests()).toContainEqual({
    url: 'https://id.atlassian.com/login',
    method: 'GET',
    session: 'default',
    servedWith: 'stub-page'
  })
  // The escapeSink fixture fails the test at teardown if any request escaped
})
