import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/app'
import { PLACEHOLDER_PAGE } from './helpers/dialog'

// Persistent storage on a real launch (spec R3; unit coverage in tests/unit/StorageService.test.ts)

let userDataDir: string

test.beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'jira-desktop-e2e-storage-'))
})

test.afterEach(async () => {
  // On Windows a Chromium child process can hold a profile file (Network/Trust Tokens-journal) for
  // a moment after the app quits; rm's retries are made for that EBUSY/EPERM case
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('saved window states survive a launch and quit, written atomically on quit', async ({ launchApp }) => {
  const saved = {
    windowStates: [{
      id: 'confluence-acme.atlassian.net/wiki/spaces/ENG/',
      productId: 'confluence',
      url: 'https://acme.atlassian.net/wiki/spaces/ENG',
      bounds: { x: 40, y: 50, width: 900, height: 650 },
      isMaximized: false,
      isMinimized: false
    }]
  }
  // Seeded compact; the store writes pretty-printed. So the file only changes if the app
  // rewrites it, which proves the quit path wrote rather than left the seed in place.
  const seed = JSON.stringify(saved)
  await writeFile(join(userDataDir, 'window-states.json'), seed)

  const app = await launchApp({ userDataDir })
  await app.electronApp.firstWindow()
  // Loading must not rewrite the file; only the quit flush does
  expect(await readFile(join(userDataDir, 'window-states.json'), 'utf-8')).toBe(seed)
  // Quitting saves the window states that were loaded at startup and flushes them in before-quit
  await app.close()

  expect(await readFile(join(userDataDir, 'window-states.json'), 'utf-8')).toBe(JSON.stringify(saved, null, 2))
  const files = await readdir(userDataDir)
  expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('a corrupt settings file is quarantined and the app still starts', async ({ launchApp }) => {
  await writeFile(join(userDataDir, 'settings.json'), '{"jiraUrl": "https://acme.atl')

  const app = await launchApp({ userDataDir })
  const page = await app.electronApp.firstWindow()
  // No usable saved site: first-run setup, nothing remote loaded
  await expect(page).toHaveURL(PLACEHOLDER_PAGE)
  await app.close()
  expect(await app.requests()).toEqual([])

  expect(await readFile(join(userDataDir, 'settings.json.corrupt-1'), 'utf-8')).toBe('{"jiraUrl": "https://acme.atl')
  // The fresh file (the main window's bounds are saved on quit) holds no site: nothing was set
  const settings = JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf-8')) as Record<string, unknown>
  expect(settings.jiraUrl).toBeUndefined()
})
