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

test('stubs main-process functions and records the app calling them', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await app.stubMain('shell', 'openExternal', undefined, { async: true })

  // A renderer-initiated navigation off Atlassian is handed to the OS browser by the app
  await page.evaluate(() => { window.location.href = 'https://example.com/elsewhere' })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://example.com/elsewhere']])
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
