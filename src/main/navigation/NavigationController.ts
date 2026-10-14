// Browser-parity navigation (spec R4): Back / Forward (menu, Cmd+[ / Cmd+] or Alt+Left / Right,
// macOS swipe, mouse back/forward via app-command, the right-click menu), Copy Current URL, Open in
// Browser and Find, all acting on a content window: the main window or a WindowManager window,
// never the dialog, an auth popup or the find bar. Menu actions act on the focused window Electron
// passes to the click, so the action does nothing when that is not a content window; swipe,
// app-command and the right-click menu act on the window they arrive at. The decisions are in
// navigationRules.ts (pure); this file wires them.
// codex:run npm test -- tests/unit/navigationRules.test.ts
// codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
import { BrowserWindow, Menu, app, clipboard } from 'electron'
import type { BaseWindow, MenuItemConstructorOptions, WebContents } from 'electron'
import { openExternalSafely } from '../security/webContentsPolicy'
import { historyTarget, navigationAccelerators, navigationCommand, shareableUrl } from './navigationRules'
import type { HistoryStep, NavigationCommand } from './navigationRules'

export const NAVIGATION_MENU_IDS = Object.freeze({ back: 'navigation-back', forward: 'navigation-forward' } as const)

export interface NavigationControllerDeps {
  // True for a URL of one of the app's own local pages (never shared or navigated back to)
  isLocalPage: (url: string) => boolean
  // Whether the navigation policy lets a content window show `url` (Back / Forward re-check it)
  isAllowedInWindow: (url: string) => boolean
  // Opens the find bar on a content window
  openFind: (owner: BrowserWindow) => void
  // Loads `url` (a history entry Back / Forward chose) in a content window that shows one of the
  // app's local pages, the way main loads its site: about:blank first. The policy treats a window
  // showing a local page as confined, so going there straight from history would hand the site's
  // own redirects to the browser.
  leaveLocalPage: (win: BrowserWindow, url: string) => void
}

export class NavigationController {
  private readonly deps: NavigationControllerDeps
  private readonly contentWindows = new WeakSet<BrowserWindow>()

  constructor(deps: NavigationControllerDeps) {
    this.deps = deps
    // Back / Forward are enabled for whichever content window has focus
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    app.on('browser-window-focus', () => this.refreshMenu())
    app.on('browser-window-blur', () => this.refreshMenu())
  }

  // Makes `win` a content window: menu actions may target it, and its swipes and app-commands
  // navigate it. Call once, right after creating the main window or a WindowManager window.
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  attach(win: BrowserWindow): void {
    if (this.contentWindows.has(win)) return
    this.contentWindows.add(win)
    win.on('swipe', (_event, direction: string) => this.run(win, navigationCommand('swipe', direction)))
    win.on('app-command', (_event, command: string) => this.run(win, navigationCommand('app-command', command)))
    // Any history change (subframes can add entries too) may change what Back / Forward can do
    const refresh = (): void => this.refreshMenu()
    const contents = win.webContents
    contents.on('did-frame-navigate', refresh)
    contents.on('did-navigate-in-page', refresh)
    win.once('closed', refresh)
  }

  // The content window a menu action applies to: the focused window Electron passed, if it is one
  target(win: BaseWindow | null | undefined): BrowserWindow | null {
    if (!(win instanceof BrowserWindow) || win.isDestroyed() || win.webContents.isDestroyed()) return null
    return this.contentWindows.has(win) ? win : null
  }

  // The "Go" menu, and the Edit menu's Find item
  menuItems(): { go: MenuItemConstructorOptions[]; find: MenuItemConstructorOptions } {
    const accelerators = navigationAccelerators(process.platform)
    return {
      go: [
        { id: NAVIGATION_MENU_IDS.back, label: 'Back', accelerator: accelerators.back, click: (_item, win) => this.go(win, -1) },
        { id: NAVIGATION_MENU_IDS.forward, label: 'Forward', accelerator: accelerators.forward, click: (_item, win) => this.go(win, 1) },
        { type: 'separator' },
        { label: 'Copy Current URL', accelerator: 'CmdOrCtrl+Shift+C', click: (_item, win) => this.copyUrl(win) },
        { label: 'Open in Browser', accelerator: 'CmdOrCtrl+Shift+O', click: (_item, win) => this.openInBrowser(win) }
      ],
      find: { label: 'Find...', accelerator: 'CmdOrCtrl+F', click: (_item, win) => this.find(win) }
    }
  }

  // Enables Back / Forward only when the focused content window can move that way. Call after
  // setting a new application menu as well.
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  refreshMenu(): void {
    const menu = Menu.getApplicationMenu()
    if (!menu) return
    const target = this.target(BrowserWindow.getFocusedWindow())
    for (const [step, id] of [[-1, NAVIGATION_MENU_IDS.back], [1, NAVIGATION_MENU_IDS.forward]] as const) {
      const item = menu.getMenuItemById(id)
      if (item) item.enabled = this.canGo(target, step)
    }
  }

  // Whether Back (step -1) or Forward (step 1) can move `win`: the Go menu's enabled state, and the
  // context menu's
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  canGo(win: BaseWindow | null | undefined, step: HistoryStep): boolean {
    const target = this.target(win)
    return target !== null && this.historyIndex(target.webContents, step) !== null
  }

  // codex:run npm test -- tests/unit/navigationRules.test.ts
  private historyIndex(contents: WebContents, step: HistoryStep): number | null {
    const history = contents.navigationHistory
    const entries = history.getAllEntries().map((entry) => entry.url)
    return historyTarget(entries, history.getActiveIndex(), step, { isLocalPage: this.deps.isLocalPage, isAllowed: this.deps.isAllowedInWindow })
  }

  private run(win: BrowserWindow, command: NavigationCommand | null): void {
    if (command === 'back') this.go(win, -1)
    else if (command === 'forward') this.go(win, 1)
  }

  // Back (step -1) or Forward (step 1) on `win`, if it is a content window that can move that way:
  // every Back / Forward (Go menu, swipe, app-command, context menu) comes through here. From one of
  // the app's local pages (the load-error placeholder) the entry is loaded through leaveLocalPage,
  // not straight from history.
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  go(win: BaseWindow | null | undefined, step: HistoryStep): void {
    const target = this.target(win)
    if (!target) return
    const contents = target.webContents
    const index = this.historyIndex(contents, step)
    if (index === null) return
    if (this.deps.isLocalPage(contents.getURL())) {
      const url = contents.navigationHistory.getEntryAtIndex(index)?.url
      if (url) this.deps.leaveLocalPage(target, url)
    } else {
      contents.navigationHistory.goToIndex(index)
    }
  }

  private currentUrl(win: BaseWindow | undefined): string | null {
    const target = this.target(win)
    return target ? shareableUrl(target.webContents.getURL(), this.deps.isLocalPage) : null
  }

  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  private copyUrl(win: BaseWindow | undefined): void {
    const url = this.currentUrl(win)
    if (url) clipboard.writeText(url)
  }

  // Through the external-open policy (http/https/mailto only), on top of shareableUrl's http(s)
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  private openInBrowser(win: BaseWindow | undefined): void {
    const url = this.currentUrl(win)
    if (url) openExternalSafely(url)
  }

  private find(win: BaseWindow | undefined): void {
    const target = this.target(win)
    if (target) this.deps.openFind(target)
  }
}
