import { E2E_SITE_URL, expect, test } from './helpers/app'

// The automatic check would run this long after startup in a packaged build (UpdateController)
const STARTUP_CHECK_DELAY_MS = 3000

test('an unpackaged build never checks for updates, and a manual check says why', async ({ launchApp }) => {
  // Any update prompt would block on a real modal; record it instead
  const app = await launchApp({
    stubs: [{ module: 'dialog', method: 'showMessageBox', returnValue: { response: 0, checkboxChecked: false }, async: true }]
  })
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(E2E_SITE_URL)
  expect(await app.electronApp.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(false)

  // Past the point where a packaged build checks: nothing was offered and nothing was fetched
  await page.waitForTimeout(STARTUP_CHECK_DELAY_MS + 1000)
  expect(await app.stubCalls('dialog', 'showMessageBox')).toEqual([])

  // Check for Updates... explains that this build does not update
  await app.electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === 'Check for Updates...')!
    ;(item.click as () => void)()
  })
  await expect.poll(async () => (await app.stubCalls('dialog', 'showMessageBox')).length).toBe(1)
  const [call] = await app.stubCalls('dialog', 'showMessageBox')
  // (parent window, options)
  const options = call!.at(-1) as { title?: string; message?: string }
  expect(options.title).toBe('Updates Unavailable')
  expect(options.message).toMatch(/packaged/)

  const hosts = (await app.requests()).map((request) => new URL(request.url).hostname)
  expect(hosts.filter((host) => /(^|\.)github(usercontent)?\.com$/.test(host))).toEqual([])
  // The escapeSink fixture fails the test at teardown if any request escaped
})
