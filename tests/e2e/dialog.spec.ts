// The local dialog (Set Jira URL / New Atlassian Window), spec R2: a sandboxed local page with a
// minimal preload, inert rendering of whatever it shows, inline validation, and IPC that answers
// only the open dialog's own page. Offline through the harness; dialog.showErrorBox is a recorder.
import type { Page } from '@playwright/test'
import { expect, test } from './helpers/app'
import type { LaunchedApp } from './helpers/app'
import { DIALOG_CHANNELS, DIALOG_PAGE, clickAppMenu, openDialog } from './helpers/dialog'

const START_URL = 'https://id.atlassian.com/login'
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"

async function windowCount(app: LaunchedApp): Promise<number> {
  return app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

// Every listener the app could leak per dialog: ipcMain (listeners and invoke handlers), app, and
// the main window and its contents (the dialog's parent)
async function listenerCounts(app: LaunchedApp) {
  return app.electronApp.evaluate(({ app: electronApp, BrowserWindow, ipcMain }) => {
    const total = (emitter: NodeJS.EventEmitter): number => emitter.eventNames().reduce((n, name) => n + emitter.listenerCount(name), 0)
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('file:'))!
    return {
      ipcMain: total(ipcMain),
      invokeHandlers: (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers.size,
      app: total(electronApp),
      mainWindow: total(main),
      mainContents: total(main.webContents),
      windows: BrowserWindow.getAllWindows().length
    }
  })
}

// A key press in the URL field that closes the dialog: keydown only, since the page is gone
// before a keyup could be delivered
async function pressClosing(dialog: Page, key: 'Enter' | 'Escape'): Promise<void> {
  await dialog.locator('#url').focus()
  await dialog.keyboard.down(key)
}

async function closed(page: Page): Promise<void> {
  if (!page.isClosed()) await page.waitForEvent('close')
}

test('the dialog is a sandboxed, isolated modal local page whose only bridge is dialogAPI', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)

  const dialog = await openDialog(app, 'Set Jira URL...')
  expect(await dialog.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const api = w.dialogAPI as Record<string, unknown> | undefined
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      ipcRenderer: typeof w.ipcRenderer,
      electron: typeof w.electron,
      dialogAPI: api ? Object.keys(api).sort() : null,
      functions: api ? Object.values(api).every((f) => typeof f === 'function') : false
    }
  })).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    ipcRenderer: 'undefined',
    electron: 'undefined',
    dialogAPI: ['cancel', 'getInit', 'submit'],
    functions: true
  })

  const prefs = await app.electronApp.evaluate(({ BrowserWindow, session }) => {
    const all = BrowserWindow.getAllWindows()
    const win = all.find((w) => w.webContents.getURL().startsWith('file:'))!
    const main = all.find((w) => w !== win)!
    const contents = win.webContents as Electron.WebContents & {
      getLastWebPreferences(): Electron.WebPreferences
      _getPreloadScript(): { filePath: string } | null
    }
    const p = contents.getLastWebPreferences()
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
      nodeIntegrationInWorker: p.nodeIntegrationInWorker,
      webviewTag: p.webviewTag,
      webSecurity: p.webSecurity,
      // Electron 44 leaves `preload` out of getLastWebPreferences; _getPreloadScript has it
      preload: contents._getPreloadScript()?.filePath ?? null,
      modal: win.isModal(),
      parentIsMain: win.getParentWindow() === main,
      resizable: win.isResizable(),
      sessionPreloads: session.defaultSession.getPreloadScripts().length
    }
  })
  expect(prefs).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    webSecurity: true,
    preload: expect.stringMatching(/[/\\]dist[/\\]preload[/\\]dialog\.js$/),
    modal: true,
    parentIsMain: true,
    resizable: false,
    sessionPreloads: 0
  })

  // CSP from the page itself: inline script does not run
  expect(await dialog.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'))).toBe(CSP)
  expect(await dialog.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__inlineRan = true'
    document.head.append(script)
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false
  })).toBe(false)

  // Shows the configured site
  await expect(dialog.locator('#heading')).toHaveText('Set Jira URL')
  await expect(dialog.locator('#url')).toHaveValue(START_URL)
  await expect(dialog.locator('#new-window-fields')).toBeHidden()

  // At most one dialog: the menu focuses the open one instead of opening another (in any mode)
  await clickAppMenu(app, 'New Atlassian Window...')
  await clickAppMenu(app, 'Set Jira URL...')
  expect(await windowCount(app)).toBe(2)
  await expect(dialog.locator('#heading')).toHaveText('Set Jira URL')
})

test('a hostile current URL renders inertly as the input value', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)

  // normalizeJiraUrl percent-encodes these characters, so the app can never store such a URL;
  // inject it at the IPC boundary (wrapping the real, sender-checked handler) to prove the page
  // itself renders whatever it is given as text
  const hostile = 'https://x.atlassian.net/"><img src=x onerror="window.__pwned=1">'
  await app.electronApp.evaluate(({ ipcMain }, raw) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('dialog:get-init')!
    ipcMain.removeHandler('dialog:get-init')
    ipcMain.handle('dialog:get-init', async (event, ...args) => ({ ...((await original(event, ...args)) as object), currentUrl: raw }))
  }, hostile)

  const dialog = await openDialog(app, 'Set Jira URL...')
  await expect(dialog.locator('#url')).toHaveValue(hostile)
  expect(await dialog.evaluate(() => ({
    value: document.querySelector<HTMLInputElement>('#url')!.value,
    images: document.querySelectorAll('img').length,
    pwned: (window as unknown as { __pwned?: number }).__pwned ?? null,
    markup: document.body.innerHTML.includes('<img')
  }))).toEqual({ value: hostile, images: 0, pwned: null, markup: false })

  // Submitting it stores (and loads) only the normalized, percent-encoded form
  await dialog.locator('#submit').click()
  await closed(dialog)
  await expect(page).toHaveURL('https://x.atlassian.net/%22%3E%3Cimg%20src=x%20onerror=%22window.__pwned=1%22%3E')
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([])
})

test('cancel, reopen and submit three times: no error dialogs and no leaked listeners', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  const before = await listenerCounts(app)
  expect(before.invokeHandlers).toBeGreaterThanOrEqual(DIALOG_CHANNELS.length)

  for (let round = 1; round <= 3; round++) {
    const cancelled = await openDialog(app, 'Set Jira URL...')
    // Alternate the button and the Escape key
    if (round % 2) await cancelled.locator('#cancel').click()
    else await pressClosing(cancelled, 'Escape')
    await closed(cancelled)

    const dialog = await openDialog(app, 'Set Jira URL...')
    await dialog.locator('#url').fill(`team${round}.atlassian.net`)
    await pressClosing(dialog, 'Enter')
    await closed(dialog)
    await expect(page).toHaveURL(`https://team${round}.atlassian.net/jira`)
  }

  await expect.poll(() => windowCount(app)).toBe(1)
  expect(await listenerCounts(app)).toEqual(before)
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([])

  // The last URL set is what the next dialog shows
  const last = await openDialog(app, 'Set Jira URL...')
  await expect(last.locator('#url')).toHaveValue('https://team3.atlassian.net/jira')
})

test('an invalid URL shows an inline error and the dialog stays open', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)

  const dialog = await openDialog(app, 'Set Jira URL...')
  const error = dialog.locator('#error')
  await expect(error).toBeHidden()

  for (const [input, message] of [
    ['javascript:alert(1)', 'Only http and https addresses are supported.'],
    ['   ', 'Enter your Jira address.'],
    ['https://user:pw@team.atlassian.net/', 'Remove the username and password from the address.']
  ]) {
    await dialog.locator('#url').fill(input)
    await dialog.locator('#submit').click()
    await expect(error).toHaveText(message)
    await expect(error).toBeVisible()
    await expect(dialog.locator('#url')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.locator('#submit')).toBeEnabled()
  }
  expect(dialog.isClosed()).toBe(false)
  expect(await windowCount(app)).toBe(2)
  expect(page.url()).toBe(START_URL)

  // Typing clears the error
  await dialog.locator('#url').fill('team.atlassian.net')
  await expect(error).toBeHidden()

  // A malformed payload (not something the page can send) is rejected outright; still open
  expect(await dialog.evaluate(() => (window as unknown as { dialogAPI: { submit(p: unknown): Promise<unknown> } }).dialogAPI
    .submit({ url: 42 }).then(() => 'resolved', () => 'rejected'))).toBe('rejected')
  expect(dialog.isClosed()).toBe(false)
  await pressClosing(dialog, 'Escape')
  await closed(dialog)

  // New-window mode: only in-app addresses
  const newWindow = await openDialog(app, 'New Atlassian Window...')
  await expect(newWindow.locator('#heading')).toHaveText('New Atlassian Window')
  await expect(newWindow.locator('#new-window-fields')).toBeVisible()
  await expect(newWindow.locator('#url')).toHaveValue('')
  await newWindow.locator('#url').fill('https://example.com/')
  await newWindow.locator('#submit').click()
  await expect(newWindow.locator('#error')).toHaveText('Only Atlassian addresses, or your own Jira site, can open in a new window.')
  expect(newWindow.isClosed()).toBe(false)
  expect(await windowCount(app)).toBe(2)
  expect((await app.requests()).map((r) => r.url)).not.toContain('https://example.com/')
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([])
})

type Who = 'main' | 'dialog' | 'dialog-subframe'
interface FakeCall {
  channel: string
  sender: Who
  frame: Who
  args?: unknown[]
}

// Calls the registered handler directly with a fake event (sender + senderFrame), as Electron
// would for an invoke from that webContents/frame. Returns the value, or 'rejected: <message>'.
async function callHandlers(app: LaunchedApp, calls: FakeCall[]): Promise<unknown[]> {
  return app.electronApp.evaluate(async ({ BrowserWindow, ipcMain }, list) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const all = BrowserWindow.getAllWindows()
    const dialog = all.find((w) => w.webContents.getURL().startsWith('file:'))
    const main = all.find((w) => w !== dialog)!
    const contents = { main: main.webContents, dialog: dialog?.webContents, 'dialog-subframe': dialog?.webContents }
    const frames = { main: main.webContents.mainFrame, dialog: dialog?.webContents.mainFrame, 'dialog-subframe': dialog?.webContents.mainFrame.frames[0] }
    const results: unknown[] = []
    for (const call of list) {
      try {
        results.push(await handlers.get(call.channel)!({ sender: contents[call.sender], senderFrame: frames[call.frame] }, ...(call.args ?? [])))
      } catch (error) {
        results.push(`rejected: ${(error as Error).message}`)
      }
    }
    return results
  }, calls)
}

test('rejects IPC from any sender but the open dialog\'s own page', async ({ launchApp }) => {
  const app = await launchApp()
  const page = await app.electronApp.firstWindow()
  await expect(page).toHaveURL(START_URL)
  const rejected = (channel: string) => `rejected: ${channel}: sender is not the expected local page`
  const validSubmit = [{ url: 'https://evil.atlassian.net/' }]

  // No dialog open: nothing answers, whoever asks
  expect(await callHandlers(app, DIALOG_CHANNELS.map((channel) => ({ channel, sender: 'main', frame: 'main', args: validSubmit })))).toEqual(
    DIALOG_CHANNELS.map(rejected)
  )

  const dialog = await openDialog(app, 'Set Jira URL...')
  // A same-page iframe inside the dialog (it has no preload, but its frame must be refused anyway)
  await dialog.evaluate(() => new Promise<void>((done) => {
    const frame = document.createElement('iframe')
    frame.src = location.href
    frame.onload = () => done()
    document.body.append(frame)
  }))
  expect(await app.electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'))!
    return win.webContents.mainFrame.frames.map((f) => f.url)
  })).toEqual([expect.stringMatching(DIALOG_PAGE)])

  const cases: FakeCall[] = []
  for (const channel of DIALOG_CHANNELS) {
    cases.push(
      { channel, sender: 'main', frame: 'main', args: validSubmit },
      { channel, sender: 'main', frame: 'dialog', args: validSubmit },
      { channel, sender: 'dialog', frame: 'main', args: validSubmit },
      { channel, sender: 'dialog', frame: 'dialog-subframe', args: validSubmit }
    )
  }
  expect(await callHandlers(app, cases)).toEqual(cases.map((c) => rejected(c.channel)))

  // The same fake event shape from the dialog's own main frame is accepted, so the rejections
  // above are the sender checks and not a broken harness
  expect(await callHandlers(app, [{ channel: 'dialog:get-init', sender: 'dialog', frame: 'dialog' }])).toEqual([{ mode: 'set-url', currentUrl: START_URL }])

  // Nothing was applied, and the dialog is still open and working
  expect(page.url()).toBe(START_URL)
  expect(dialog.isClosed()).toBe(false)
  await expect(dialog.locator('#url')).toHaveValue(START_URL)
  await dialog.locator('#cancel').click()
  await closed(dialog)

  // Closed again: nothing answers
  expect(await callHandlers(app, [{ channel: 'dialog:get-init', sender: 'main', frame: 'main' }])).toEqual([rejected('dialog:get-init')])
})
