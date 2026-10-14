// Browser-parity UX (spec R4): Back / Forward (menu, swipe, app-command) with the menu items
// disabled when history can't move, Copy Current URL, Open in Browser through the external-open
// policy, the find bar (a sandboxed local page overlaid on the content window) and the user agent.
// Offline through the harness. The harness keeps every window unfocused, so menu actions are driven
// the way Electron drives them: the item's click with an explicit focused window. Unit coverage for
// the pure rules is in tests/unit/navigationRules.test.ts, findRules.test.ts and userAgent.test.ts.
import type { Page } from '@playwright/test'
import { E2E_SITE_URL, expect, test } from './helpers/app'
import type { LaunchedApp, Route } from './helpers/app'
import { DIALOG_PAGE, PLACEHOLDER_PAGE, closeVia, openDialog, waitForDialog } from './helpers/dialog'

const START_URL = E2E_SITE_URL
const FIND_PAGE = /^file:\/\/.*\/dist\/renderer\/find\.html$/
const FIND_CHANNELS = ['find:query', 'find:close'] as const
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
const BACK = 'navigation-back'
const FORWARD = 'navigation-forward'

function page(title: string, body = ''): Route['response'] {
  return { body: `<!doctype html><title>${title}</title><p>${body}</p>` }
}

const ROUTES: Route[] = [
  { url: START_URL, response: page('Start') },
  { url: 'https://e2e.atlassian.net/browse/ONE-1', response: page('One') },
  { url: 'https://e2e.atlassian.net/browse/TWO-2?focused=1#comment', response: page('Two') },
  { url: 'https://e2e.atlassian.net/fruit', response: page('Fruit', 'apple banana Apple cherry APPLE pear') }
]

// The BrowserWindow id behind a page
async function windowIdOf(app: LaunchedApp, target: Page): Promise<number> {
  return (await app.electronApp.browserWindow(target)).evaluate((win) => win.id)
}

// Clicks a menu item (labels from the menu bar down) as Electron does when `windowId` has focus;
// null is a click with no focused window
async function clickMenuIn(app: LaunchedApp, path: string[], windowId: number | null): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow, Menu }, { labels, id }) => {
    let items = Menu.getApplicationMenu()!.items
    let item: Electron.MenuItem | undefined
    for (const label of labels) {
      item = items.find((i) => i.label === label)
      if (!item) throw new Error(`no menu item ${labels.join(' > ')}`)
      items = item.submenu?.items ?? []
    }
    const focused = id === null ? undefined : BrowserWindow.fromId(id)
    if (id !== null && !focused) throw new Error(`no window ${id}`)
    ;(item!.click as (event: unknown, focusedWindow?: Electron.BrowserWindow) => void)({}, focused ?? undefined)
  }, { labels: path, id: windowId })
}

// Makes BrowserWindow.getFocusedWindow() report `windowId` from now on (the harness never lets a
// window take real focus), so the menu's enabled state follows that window. A real focus change
// also blurs the window that had focus; that event is emitted (not 'browser-window-focus', which
// the harness counts as a window taking focus) so the menu is refreshed at once.
async function reportFocused(app: LaunchedApp, windowId: number): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow, app: electronApp }, id) => {
    const win = BrowserWindow.fromId(id)
    BrowserWindow.getFocusedWindow = () => (win && !win.isDestroyed() ? win : null)
    electronApp.emit('browser-window-blur', {}, win)
  }, windowId)
}

async function navEnabled(app: LaunchedApp): Promise<{ back: boolean; forward: boolean }> {
  return app.electronApp.evaluate(({ Menu }, ids) => {
    const menu = Menu.getApplicationMenu()!
    return { back: menu.getMenuItemById(ids[0])!.enabled, forward: menu.getMenuItemById(ids[1])!.enabled }
  }, [BACK, FORWARD])
}

// A renderer-initiated navigation, as a click on a link would be
async function navigate(target: Page, url: string): Promise<void> {
  await target.evaluate((next) => { window.location.href = next }, url)
  await expect(target).toHaveURL(url)
}

async function emitOnWindow(app: LaunchedApp, windowId: number, event: 'swipe' | 'app-command', value: string): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, { id, name, arg }) => {
    BrowserWindow.fromId(id)!.emit(name, {}, arg)
  }, { id: windowId, name: event, arg: value })
}

interface ContextMenuItem { label: string; enabled: boolean; accelerator: string | null }

// Right-clicks the window's page (its 'context-menu' event, as Chromium sends it) and returns the
// menu ContextMenuService built. The native popup is replaced by a no-op first, so no menu is ever
// shown and nothing takes focus; with `click`, then clicks that item as the user would (the item's
// click handler, whether or not it is enabled, as a state change between popup and click could).
async function contextMenu(app: LaunchedApp, windowId: number, click?: string): Promise<ContextMenuItem[]> {
  return app.electronApp.evaluate(({ BrowserWindow, Menu }, { id, label }) => {
    type Recorder = { menus: Electron.Menu[] }
    const scope = globalThis as unknown as { __contextMenus?: Recorder }
    if (!scope.__contextMenus) {
      const recorder: Recorder = { menus: [] }
      const build = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = (template) => {
        const menu = build(template)
        menu.popup = () => {}
        recorder.menus.push(menu)
        return menu
      }
      scope.__contextMenus = recorder
    }
    const recorder = scope.__contextMenus
    const win = BrowserWindow.fromId(id)!
    const before = recorder.menus.length
    const url = win.webContents.getURL()
    win.webContents.emit('context-menu', { preventDefault: () => {} }, { x: 1, y: 1, linkURL: '', linkText: '', pageURL: url, isEditable: false, selectionText: '' })
    if (recorder.menus.length !== before + 1) throw new Error('no context menu was built')
    const items = recorder.menus.at(-1)!.items
    if (label !== undefined) {
      const item = items.find((i) => i.label === label)
      if (!item) throw new Error(`no context menu item ${label}`)
      ;(item.click as () => void)()
    }
    return items.filter((i) => i.type !== 'separator').map((i) => ({ label: i.label, enabled: i.enabled, accelerator: i.accelerator ?? null }))
  }, { id: windowId, label: click })
}

async function contextNav(app: LaunchedApp, windowId: number): Promise<{ back: boolean; forward: boolean }> {
  const items = await contextMenu(app, windowId)
  const enabled = (label: string): boolean => {
    const item = items.find((i) => i.label === label)
    if (!item) throw new Error(`no context menu item ${label}`)
    return item.enabled
  }
  return { back: enabled('Back'), forward: enabled('Forward') }
}

async function historyUrls(app: LaunchedApp, windowId: number): Promise<string[]> {
  return app.electronApp.evaluate(({ BrowserWindow }, id) =>
    BrowserWindow.fromId(id)!.webContents.navigationHistory.getAllEntries().map((e) => e.url), windowId)
}

async function findBarPage(app: LaunchedApp): Promise<Page> {
  const find = (): Page | undefined => app.electronApp.windows().find((p) => !p.isClosed() && FIND_PAGE.test(p.url()))
  await expect.poll(() => find() !== undefined).toBe(true)
  return find()!
}

// The find bar view's state on a window: shown (attached to the window's content view) and bounds
async function findBarState(app: LaunchedApp, windowId: number) {
  return app.electronApp.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.fromId(id)!
    const views = win.contentView.children.filter((v) => v !== win.contentView && 'webContents' in v && (v as Electron.WebContentsView).webContents !== win.webContents)
    const bar = views[0] as Electron.WebContentsView | undefined
    const [width] = win.getContentSize()
    return { shown: views.length, contentWidth: width, bounds: bar?.getBounds() ?? null, onTop: bar ? win.contentView.children.at(-1) === bar : false }
  }, windowId)
}

test('Back / Forward after two navigations, by menu, swipe and app-command; disabled when history cannot move', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')
  const mainId = await windowIdOf(app, main)
  await reportFocused(app, mainId)

  const one = 'https://e2e.atlassian.net/browse/ONE-1'
  const two = 'https://e2e.atlassian.net/browse/TWO-2?focused=1#comment'
  await navigate(main, one)
  await navigate(main, two)
  await expect.poll(() => navEnabled(app)).toEqual({ back: true, forward: false })
  // Both were real (intercepted) loads
  expect(await app.requests()).toEqual(expect.arrayContaining([
    expect.objectContaining({ url: one, servedWith: 'route' }),
    expect.objectContaining({ url: two, servedWith: 'route' })
  ]))

  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await expect(main).toHaveURL(one)
  await expect.poll(() => navEnabled(app)).toEqual({ back: true, forward: true })

  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await expect(main).toHaveURL(START_URL)
  await expect.poll(() => navEnabled(app)).toEqual({ back: false, forward: true })
  // Nothing further back: a click does nothing
  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await clickMenuIn(app, ['Go', 'Forward'], mainId)
  await expect(main).toHaveURL(one)
  await clickMenuIn(app, ['Go', 'Forward'], mainId)
  await expect(main).toHaveURL(two)
  await expect.poll(() => navEnabled(app)).toEqual({ back: true, forward: false })

  // macOS three-finger swipe and Windows/Linux mouse buttons, on the window they arrive at
  await emitOnWindow(app, mainId, 'swipe', 'left')
  await expect(main).toHaveURL(one)
  await emitOnWindow(app, mainId, 'swipe', 'right')
  await expect(main).toHaveURL(two)
  await emitOnWindow(app, mainId, 'app-command', 'browser-backward')
  await expect(main).toHaveURL(one)
  await emitOnWindow(app, mainId, 'app-command', 'browser-forward')
  await expect(main).toHaveURL(two)
  await emitOnWindow(app, mainId, 'swipe', 'up')
  await emitOnWindow(app, mainId, 'app-command', 'browser-refresh')

  // No focused window, or a focused window that is not a content window: nothing moves, and the
  // menu items are disabled
  await clickMenuIn(app, ['Go', 'Back'], null)
  const dialog = await openDialog(app, 'Set Jira URL...')
  const dialogId = await windowIdOf(app, dialog)
  await clickMenuIn(app, ['Go', 'Back'], dialogId)
  // Find on the dialog opens nothing either
  await clickMenuIn(app, ['Edit', 'Find...'], dialogId)
  await reportFocused(app, dialogId)
  await navigate(main, one)
  await expect.poll(() => navEnabled(app)).toEqual({ back: false, forward: false })
  await expect(dialog).toHaveURL(DIALOG_PAGE)
  await closeVia(dialog, () => dialog.locator('#cancel').click())
  expect(main.url()).toBe(one)
  expect(await app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().filter((c) => c.getURL().endsWith('/find.html')).length)).toBe(0)
})

test('Back never returns to the setup placeholder or the blank page main loads on the way to the site', async ({ launchApp }) => {
  const app = await launchApp({ settings: null, routes: [{ url: 'https://acme.atlassian.net/*', response: page('Acme') }] })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveURL(PLACEHOLDER_PAGE)
  const mainId = await windowIdOf(app, main)
  await reportFocused(app, mainId)

  const dialog = await waitForDialog(app)
  await dialog.locator('#url').fill('acme.atlassian.net')
  await closeVia(dialog, () => dialog.locator('#submit').click())
  await expect(main).toHaveURL('https://acme.atlassian.net/jira')
  // The placeholder and about:blank are in the window's history, but out of reach
  expect(await app.electronApp.evaluate(({ BrowserWindow }, id) =>
    BrowserWindow.fromId(id)!.webContents.navigationHistory.getAllEntries().map((e) => e.url), mainId)).toEqual([
    expect.stringMatching(PLACEHOLDER_PAGE),
    'about:blank',
    'https://acme.atlassian.net/jira'
  ])
  await expect.poll(() => navEnabled(app)).toEqual({ back: false, forward: false })
  // The right-click menu's Back / Forward follow the same rules as the Go menu (with its accelerators)
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  const accelerators = process.platform === 'darwin' ? ['CmdOrCtrl+[', 'CmdOrCtrl+]'] : ['Alt+Left', 'Alt+Right']
  expect((await contextMenu(app, mainId)).filter((i) => i.label === 'Back' || i.label === 'Forward')).toEqual([
    { label: 'Back', enabled: false, accelerator: accelerators[0] },
    { label: 'Forward', enabled: false, accelerator: accelerators[1] }
  ])
  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await contextMenu(app, mainId, 'Back')
  await emitOnWindow(app, mainId, 'swipe', 'left')
  await emitOnWindow(app, mainId, 'app-command', 'browser-backward')
  await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.webContents.isLoading(), mainId)).toBe(false)
  expect(main.url()).toBe('https://acme.atlassian.net/jira')
  expect(await historyUrls(app, mainId)).toHaveLength(3)

  // Still the site, still governed as remote content: an in-app link stays in the window
  await navigate(main, 'https://acme.atlassian.net/browse/A-1')
  await expect.poll(() => contextNav(app, mainId)).toEqual({ back: true, forward: false })
  await contextMenu(app, mainId, 'Back')
  await expect(main).toHaveURL('https://acme.atlassian.net/jira')
  await expect.poll(() => contextNav(app, mainId)).toEqual({ back: false, forward: true })
  await contextMenu(app, mainId, 'Forward')
  await expect(main).toHaveURL('https://acme.atlassian.net/browse/A-1')
  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await expect(main).toHaveURL('https://acme.atlassian.net/jira')
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
})

// Back from the load-error placeholder reaches the failed site's entry. The window still shows a
// local page then, which the policy treats as confined, so it must leave it the way main's own
// site load does (about:blank first): otherwise the site's first redirect would go to the browser.
// codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
for (const via of ['Go menu', 'context menu'] as const) {
  test(`Back (${via}) from the load-error view loads the site in the app, redirects included`, async ({ launchApp }) => {
    const app = await launchApp({ routes: [{ url: START_URL, response: { kind: 'network-error' } }] })
    const main = await app.electronApp.firstWindow()
    await expect(main).toHaveURL(PLACEHOLDER_PAGE)
    const mainId = await windowIdOf(app, main)
    await reportFocused(app, mainId)
    const dialog = await waitForDialog(app)
    // The failed load's own (error page) entry, then the placeholder
    expect(await historyUrls(app, mainId)).toEqual([START_URL, expect.stringMatching(PLACEHOLDER_PAGE)])
    await expect.poll(() => navEnabled(app)).toEqual({ back: true, forward: false })
    expect(await contextNav(app, mainId)).toEqual({ back: true, forward: false })

    // The site is back, and redirects as Jira's root does; the user closes the error view and goes Back
    await app.setRoutes([{ url: START_URL, response: { status: 302, headers: { location: `${START_URL}/your-work` }, body: '' } }])
    await closeVia(dialog, () => dialog.locator('#cancel').click())
    if (via === 'Go menu') await clickMenuIn(app, ['Go', 'Back'], mainId)
    else await contextMenu(app, mainId, 'Back')
    await expect(main).toHaveURL(`${START_URL}/your-work`)
    await expect(main).toHaveTitle('E2E stub')
    expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
    // Out of the placeholder for good: Back skips it and the blank step
    await expect.poll(() => navEnabled(app)).toEqual({ back: true, forward: false })
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  })
}

test('Back / Forward re-check the navigation policy: pages of a site that is no longer configured are out of reach', async ({ launchApp }) => {
  const app = await launchApp({ settings: { jiraUrl: 'https://jira.corp.test/' }, routes: [{ url: 'https://jira.corp.test/*', response: page('Corp') }, ...ROUTES] })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveURL('https://jira.corp.test/')
  const mainId = await windowIdOf(app, main)
  await reportFocused(app, mainId)
  // In-app while it is the configured site
  await navigate(main, 'https://jira.corp.test/browse/X-1')
  await expect.poll(() => navEnabled(app)).toEqual({ back: true, forward: false })

  const dialog = await openDialog(app, 'Set Jira URL...')
  await dialog.locator('#url').fill(START_URL)
  await closeVia(dialog, () => dialog.locator('#submit').click())
  await expect(main).toHaveTitle('Start')
  await navigate(main, 'https://e2e.atlassian.net/browse/ONE-1')

  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await expect(main).toHaveURL(START_URL)
  await expect.poll(() => navEnabled(app)).toEqual({ back: false, forward: true })
  await clickMenuIn(app, ['Go', 'Back'], mainId)
  await emitOnWindow(app, mainId, 'app-command', 'browser-backward')
  await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.webContents.isLoading(), mainId)).toBe(false)
  expect(main.url()).toBe(START_URL)
})

test('Back / Forward and Find act on a WindowManager window as well', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')

  const target = 'https://team.atlassian.net/wiki/spaces/X'
  const dialog = await openDialog(app, 'New Atlassian Window...')
  const opened = app.electronApp.waitForEvent('window', { predicate: (p) => p.url() === target })
  await dialog.locator('#url').fill(target)
  await dialog.locator('#background').check()
  await closeVia(dialog, () => dialog.locator('#submit').click())
  const extra = await opened
  const extraId = await windowIdOf(app, extra)

  await navigate(extra, 'https://team.atlassian.net/wiki/spaces/Y')
  await clickMenuIn(app, ['Go', 'Back'], extraId)
  await expect(extra).toHaveURL(target)
  await emitOnWindow(app, extraId, 'app-command', 'browser-forward')
  await expect(extra).toHaveURL('https://team.atlassian.net/wiki/spaces/Y')
  expect(main.url()).toBe(START_URL)

  await clickMenuIn(app, ['Edit', 'Find...'], extraId)
  await findBarPage(app)
  await expect.poll(async () => (await findBarState(app, extraId)).shown).toBe(1)
  expect((await findBarState(app, await windowIdOf(app, main))).shown).toBe(0)

  // Closing the window closes its find bar's contents too
  const findBars = () => app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().filter((c) => c.getURL().endsWith('/find.html')).length)
  expect(await findBars()).toBe(1)
  await extra.close()
  await expect.poll(findBars).toBe(0)
})

test('a find bar whose renderer died is replaced by a working one on the next Find', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await navigate(main, 'https://e2e.atlassian.net/fruit')
  const mainId = await windowIdOf(app, main)
  await clickMenuIn(app, ['Edit', 'Find...'], mainId)
  const first = await findBarPage(app)
  await expect(first.locator('#query')).toBeVisible()

  await app.electronApp.evaluate(({ webContents }) => {
    webContents.getAllWebContents().find((c) => c.getURL().endsWith('/find.html'))!.forcefullyCrashRenderer()
  })
  await expect.poll(async () => (await findBarState(app, mainId)).shown).toBe(0)
  await expect.poll(() => app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().filter((c) => c.getURL().endsWith('/find.html')).length)).toBe(0)

  await clickMenuIn(app, ['Edit', 'Find...'], mainId)
  const next = await findBarPage(app)
  expect(next).not.toBe(first)
  await next.locator('#query').fill('pear')
  await expect(next.locator('#count')).toHaveText('1 of 1')
  // The harness's error-box recorder would have caught a main-process exception
  expect(await app.stubCalls('dialog', 'showErrorBox')).toEqual([])
})

test('Copy Current URL copies the page address, and nothing for a local or non-web page', async ({ launchApp }) => {
  // A recorder, so the run never overwrites the user's real clipboard
  const app = await launchApp({ routes: ROUTES, stubs: [{ module: 'clipboard', method: 'writeText' }] })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')
  const mainId = await windowIdOf(app, main)

  const two = 'https://e2e.atlassian.net/browse/TWO-2?focused=1#comment'
  await navigate(main, two)
  await clickMenuIn(app, ['Go', 'Copy Current URL'], mainId)
  expect(await app.stubCalls('clipboard', 'writeText')).toEqual([[two]])

  // Not a content window (an SSO popup, the dialog), or no window: nothing
  const popupOpened = app.electronApp.waitForEvent('window')
  await main.evaluate(() => { window.open('https://accounts.google.com/signin') })
  const popup = await popupOpened
  await expect(popup).toHaveURL('https://accounts.google.com/signin')
  await clickMenuIn(app, ['Go', 'Copy Current URL'], await windowIdOf(app, popup))
  await clickMenuIn(app, ['Go', 'Open in Browser'], await windowIdOf(app, popup))
  await popup.close()
  const dialog = await openDialog(app, 'Set Jira URL...')
  await clickMenuIn(app, ['Go', 'Copy Current URL'], await windowIdOf(app, dialog))
  await clickMenuIn(app, ['Go', 'Copy Current URL'], null)
  await closeVia(dialog, () => dialog.locator('#cancel').click())

  // Pages with nothing to share (main may load these; the policy never lets remote content)
  for (const url of ['about:blank', 'data:text/html,<p>data']) {
    await app.electronApp.evaluate(({ BrowserWindow }, { id, next }) => BrowserWindow.fromId(id)!.loadURL(next), { id: mainId, next: url })
    await clickMenuIn(app, ['Go', 'Copy Current URL'], mainId)
  }
  expect(await app.stubCalls('clipboard', 'writeText')).toEqual([[two]])
  expect(await app.stubCalls('shell', 'openExternal')).toEqual([])
})

test('Open in Browser hands an https page to the external-open policy, and never a non-web scheme', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')
  const mainId = await windowIdOf(app, main)

  await navigate(main, 'https://e2e.atlassian.net/browse/ONE-1')
  await clickMenuIn(app, ['Go', 'Open in Browser'], mainId)
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://e2e.atlassian.net/browse/ONE-1']])
  // It is still open in the app too
  expect(main.url()).toBe('https://e2e.atlassian.net/browse/ONE-1')

  for (const url of ['data:text/html,<p>data', 'about:blank']) {
    await app.electronApp.evaluate(({ BrowserWindow }, { id, next }) => BrowserWindow.fromId(id)!.loadURL(next), { id: mainId, next: url })
    await clickMenuIn(app, ['Go', 'Open in Browser'], mainId)
  }
  await clickMenuIn(app, ['Go', 'Open in Browser'], null)
  // A sentinel after them proves the clicks above ran and opened nothing
  await app.electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.loadURL('https://e2e.atlassian.net/browse/TWO-2?focused=1'), mainId)
  await clickMenuIn(app, ['Go', 'Open in Browser'], mainId)
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([
    ['https://e2e.atlassian.net/browse/ONE-1'],
    ['https://e2e.atlassian.net/browse/TWO-2?focused=1']
  ])
  // A user's own clicks are never throttled by the page-driven rate limit (burst 3)
  for (let i = 0; i < 4; i++) await clickMenuIn(app, ['Go', 'Open in Browser'], mainId)
  await expect.poll(async () => (await app.stubCalls('shell', 'openExternal')).length).toBe(6)
  expect(await app.stubCalls('permission', 'openExternal')).toEqual([])
})

test('Find shows the match count, Enter / Shift+Enter move through matches, Esc closes and clears', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')
  await navigate(main, 'https://e2e.atlassian.net/fruit')
  await expect(main).toHaveTitle('Fruit')
  const mainId = await windowIdOf(app, main)

  await clickMenuIn(app, ['Edit', 'Find...'], mainId)
  const bar = await findBarPage(app)
  const state = await findBarState(app, mainId)
  expect(state).toMatchObject({ shown: 1, onTop: true })
  expect(state.bounds!.y).toBe(0)
  expect(state.bounds!.x + state.bounds!.width).toBeLessThanOrEqual(state.contentWidth)

  const input = bar.locator('#query')
  const count = bar.locator('#count')
  await input.fill('apple')
  await expect(count).toHaveText('1 of 3')
  await input.press('Enter')
  await expect(count).toHaveText('2 of 3')
  await input.press('Enter')
  await expect(count).toHaveText('3 of 3')
  await input.press('Shift+Enter')
  await expect(count).toHaveText('2 of 3')
  await bar.locator('#previous').click()
  await expect(count).toHaveText('1 of 3')
  await bar.locator('#next').click()
  await expect(count).toHaveText('2 of 3')

  await input.fill('cherry')
  await expect(count).toHaveText('1 of 1')
  await input.fill('kiwi')
  await expect(count).toHaveText('No matches')
  await input.fill('')
  await expect(count).toHaveText('')
  await input.fill('banana')
  await expect(count).toHaveText('1 of 1')

  // Esc closes the bar and stops the search with 'clearSelection'
  await app.electronApp.evaluate(({ BrowserWindow }, id) => {
    const contents = BrowserWindow.fromId(id)!.webContents
    const original = contents.stopFindInPage.bind(contents)
    const calls: string[] = ((globalThis as unknown as { __stopFindCalls: string[] }).__stopFindCalls = [])
    contents.stopFindInPage = (action) => {
      calls.push(action)
      original(action)
    }
  }, mainId)
  await input.press('Escape')
  await expect.poll(async () => (await findBarState(app, mainId)).shown).toBe(0)
  expect(await app.electronApp.evaluate(() => (globalThis as unknown as { __stopFindCalls: string[] }).__stopFindCalls)).toEqual(['clearSelection'])

  // Closed: its IPC is no longer answered, even from its own page
  expect(await bar.evaluate(() => (window as unknown as { findAPI: { find(q: unknown): Promise<void> } }).findAPI
    .find({ text: 'apple', forward: true, newSession: true }).then(() => 'answered', () => 'rejected'))).toBe('rejected')

  // Reopened: the same bar searches its text again from the start
  await clickMenuIn(app, ['Edit', 'Find...'], mainId)
  await expect.poll(async () => (await findBarState(app, mainId)).shown).toBe(1)
  await expect(input).toHaveValue('banana')
  await expect(count).toHaveText('1 of 1')
  expect(app.electronApp.windows().filter((p) => !p.isClosed() && FIND_PAGE.test(p.url()))).toHaveLength(1)

  // A new document in the window closes the bar
  await navigate(main, 'https://e2e.atlassian.net/browse/ONE-1')
  await expect.poll(async () => (await findBarState(app, mainId)).shown).toBe(0)
})

test('the find bar is a separate, confined local page; the remote page underneath gets nothing', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')
  const mainId = await windowIdOf(app, main)
  await clickMenuIn(app, ['Edit', 'Find...'], mainId)
  const bar = await findBarPage(app)
  await expect(bar.locator('#query')).toBeVisible()

  const prefs = await app.electronApp.evaluate(({ BrowserWindow, session, webContents }, id) => {
    type Internals = Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences; _getPreloadScript(): unknown }
    const win = BrowserWindow.fromId(id)!
    const barContents = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/find.html')) as Internals
    const p = barContents.getLastWebPreferences()
    return {
      separate: barContents !== win.webContents,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
      nodeIntegrationInWorker: p.nodeIntegrationInWorker,
      webviewTag: p.webviewTag,
      webSecurity: p.webSecurity,
      preload: barContents._getPreloadScript(),
      mainPreload: (win.webContents as Internals)._getPreloadScript(),
      sessionPreloads: session.defaultSession.getPreloadScripts().length
    }
  }, mainId)
  expect(prefs).toEqual({
    separate: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    webSecurity: true,
    preload: expect.objectContaining({ filePath: expect.stringMatching(/[/\\]dist[/\\]preload[/\\]find\.js$/) }),
    mainPreload: null,
    sessionPreloads: 0
  })

  // Its only bridge is findAPI; the remote page has none
  expect(await bar.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const api = w.findAPI as Record<string, unknown> | undefined
    return { require: typeof w.require, process: typeof w.process, ipcRenderer: typeof w.ipcRenderer, findAPI: api ? Object.keys(api).sort() : null }
  })).toEqual({ require: 'undefined', process: 'undefined', ipcRenderer: 'undefined', findAPI: ['close', 'find', 'onActivate', 'onResult'] })
  expect(await main.evaluate(() => [typeof (window as unknown as Record<string, unknown>).findAPI, typeof (window as unknown as Record<string, unknown>).dialogAPI])).toEqual(['undefined', 'undefined'])

  // CSP from the page itself: inline script does not run
  expect(await bar.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'))).toBe(CSP)
  expect(await bar.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__inlineRan = true'
    document.head.append(script)
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false
  })).toBe(false)

  // IPC from anything but a shown find bar's own main frame is refused, and a malformed query too
  type Who = 'main' | 'bar'
  const calls = async (list: { channel: string; sender: Who; frame: Who; args?: unknown[] }[]) =>
    app.electronApp.evaluate(async ({ ipcMain, webContents, BrowserWindow }, { cases, id }) => {
      type Handler = (event: unknown, ...args: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
      const main = BrowserWindow.fromId(id)!.webContents
      const barContents = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/find.html'))!
      const contents = { main, bar: barContents }
      const results: unknown[] = []
      for (const call of cases) {
        try {
          results.push(await handlers.get(call.channel)!({ sender: contents[call.sender], senderFrame: contents[call.frame].mainFrame }, ...(call.args ?? [])))
        } catch (error) {
          results.push(`rejected: ${(error as Error).message}`)
        }
      }
      return results
    }, { cases: list, id: mainId })
  const query = { text: 'Start', forward: true, newSession: true }
  const refused = (channel: string) => `rejected: ${channel}: sender is not an open local page`
  const cases = FIND_CHANNELS.flatMap((channel) => [
    { channel, sender: 'main' as const, frame: 'main' as const, args: [query] },
    { channel, sender: 'main' as const, frame: 'bar' as const, args: [query] },
    { channel, sender: 'bar' as const, frame: 'main' as const, args: [query] }
  ])
  expect(await calls(cases)).toEqual(cases.map((c) => refused(c.channel)))
  expect(await calls([{ channel: 'find:query', sender: 'bar', frame: 'bar', args: [{ text: 1 }] }])).toEqual(['rejected: find:query: malformed query'])
  // The same shape from the bar's own frame is answered, so the refusals above are the sender check
  expect(await calls([{ channel: 'find:query', sender: 'bar', frame: 'bar', args: [query] }])).toEqual([undefined])

  // Confined: even an in-app URL is handed to the browser instead of loading in the bar
  const barUrl = bar.url()
  await bar.evaluate(() => { window.location.href = 'https://e2e.atlassian.net/browse/ONE-1' })
  await expect.poll(() => app.stubCalls('shell', 'openExternal')).toEqual([['https://e2e.atlassian.net/browse/ONE-1']])
  expect(bar.url()).toBe(barUrl)
  expect(main.url()).toBe(START_URL)
})

test('the user agent drops the Electron and app-name tokens, for windows and the session', async ({ launchApp }) => {
  const app = await launchApp({ routes: ROUTES })
  const main = await app.electronApp.firstWindow()
  await expect(main).toHaveTitle('Start')
  const { fallback, sessionUA, appName } = await app.electronApp.evaluate(({ app: electronApp, session }) => ({
    fallback: electronApp.userAgentFallback,
    sessionUA: session.defaultSession.getUserAgent(),
    appName: electronApp.getName()
  }))
  const pageUA = await main.evaluate(() => navigator.userAgent)
  for (const ua of [fallback, sessionUA, pageUA]) {
    expect(ua).toMatch(/^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/)
    expect(ua).not.toMatch(/Electron\//)
    expect(ua).not.toContain(`${appName.replace(/\s+/g, '')}/`)
  }
  expect(pageUA).toBe(fallback)
})
