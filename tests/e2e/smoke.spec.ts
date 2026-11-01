import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { E2E_SITE_URL, expect, test } from './helpers/app'

test('launches, shows the main window and keeps all traffic local', async ({ launchApp }) => {
  // Configured for E2E_SITE_URL (the fixture's default settings.json); first run is in startup.spec.ts
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(E2E_SITE_URL)
  await expect(page).toHaveTitle('E2E stub')

  // The app's ready-to-show -> show() still runs; the harness turns it into an inactive,
  // transparent, off-screen show, so the window is shown without stealing the screen
  const mainWindow = await app.electronApp.browserWindow(page)
  await expect.poll(() => mainWindow.evaluate((win) => win.isVisible())).toBe(true)

  // Remote content is sandboxed, isolated and has no preload (spec R2; details in security.spec.ts)
  const prefs = await mainWindow.evaluate((win) => {
    const p = win.webContents.getLastWebPreferences()
    // Electron 44 leaves `preload` out of getLastWebPreferences; _getPreloadScript has it
    const contents = win.webContents as Electron.WebContents & { _getPreloadScript?: () => unknown }
    if (typeof contents._getPreloadScript !== 'function') throw new Error('Electron no longer has webContents._getPreloadScript')
    return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, webSecurity: p?.webSecurity, preload: contents._getPreloadScript() }
  })
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: null })

  // The profile lives in the per-test temp dir, never the real one
  const paths = await app.electronApp.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData'),
    sessionData: electronApp.getPath('sessionData')
  }))
  expect(paths).toEqual({ userData: app.userDataDir, sessionData: app.userDataDir })

  expect(await app.requests()).toContainEqual({
    url: E2E_SITE_URL,
    method: 'GET',
    session: 'default',
    servedWith: 'stub-page'
  })
  // The escapeSink fixture fails the test at teardown if any request escaped
})

// scripts/mac-smoke-launch.sh (CI, packaged macOS app) treats this file as proof that startup
// finished without throwing; it is written only when JIRA_DESKTOP_SMOKE_TEST=1
test('writes the startup marker the packaged smoke launch waits for, and only when asked', async ({ launchApp }) => {
  const marker = (dir: string): string => join(dir, 'smoke-startup-complete')

  const marked = await launchApp({ env: { JIRA_DESKTOP_SMOKE_TEST: '1' } })
  await expect(await marked.electronApp.firstWindow()).toHaveURL(E2E_SITE_URL)
  await expect.poll(() => existsSync(marker(marked.userDataDir))).toBe(true)
  await marked.close()

  const plain = await launchApp()
  const page = await plain.electronApp.firstWindow()
  await expect(page).toHaveURL(E2E_SITE_URL)
  // The marker would follow setupMenu in the same tick; once the app's own menu (not Electron's
  // default one) is installed, the point where it would have been written has passed
  await expect.poll(() => plain.electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0]?.label ?? null)).toBe('Jira Desktop')
  expect(existsSync(marker(plain.userDataDir))).toBe(false)
})
