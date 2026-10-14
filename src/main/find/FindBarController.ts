// Find in page (spec R4): one small find bar per content window, opened with Cmd/Ctrl+F.
//
// The bar is a sandboxed local page (src/renderer/find.html) with its own minimal preload, shown
// as a WebContentsView overlaid on the top right of the content window. That view is a separate
// webContents with its own prefs: the remote page underneath keeps no preload and no IPC, and the
// bar's contents are registered as privileged, so the webContents policy confines them to local
// pages for their whole life. Chosen over a frameless child window because the overlay moves,
// resizes and hides with its window on every platform without tracking it.
//
// IPC channels are registered once, here, and each call is answered only for the shown bar it
// comes from (security/localPageIpc.ts). The bar's requests drive findInPage on its own window
// only; match counts come back from that window's found-in-page.
// codex:run npm test -- tests/unit/findRules.test.ts
// codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
import { WebContentsView } from 'electron'
import type { BrowserWindow, Event, Result } from 'electron'
import { join } from 'path'
import { FIND_CHANNELS } from '../../shared/find'
import type { FindResult } from '../../shared/find'
import { handleFromAnyLocalPage } from '../security/localPageIpc'
import type { LocalPage } from '../security/localPageIpc'
import { localPageUrl } from '../security/localPageUrl'
import { isExpectedLoadAbort } from '../security/navigationPolicy'
import { registerLocalPage, registerPrivilegedContents } from '../security/webContentsPolicy'
import { findBarBounds, parseFindQuery, toFindResult } from './findRules'

interface FindBar extends LocalPage {
  // The content window it searches and sits on
  owner: BrowserWindow
  view: WebContentsView
  shown: boolean
  // The page has loaded, so messages sent to it are received
  loaded: boolean
  // The latest findInPage request; found-in-page results for any other are stale
  requestId: number | null
  // Removes the listeners it added to its window
  detach: () => void
}

const NO_MATCHES: FindResult = Object.freeze({ activeMatchOrdinal: 0, matches: 0 })

export class FindBarController {
  private readonly pageUrl: string
  private readonly preloadPath = join(__dirname, '../preload/find.js')
  private readonly bars = new Map<BrowserWindow, FindBar>()

  // Construct once, at startup: it registers the IPC channels and the find page as a local page
  constructor() {
    this.pageUrl = localPageUrl('find.html')
    registerLocalPage(this.pageUrl)

    // Only a bar that is showing is answered
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    const shownBars = (): FindBar[] => [...this.bars.values()].filter((bar) => bar.shown && !bar.view.webContents.isDestroyed())
    handleFromAnyLocalPage(FIND_CHANNELS.find, shownBars, (bar, raw) => this.find(bar, raw))
    handleFromAnyLocalPage(FIND_CHANNELS.close, shownBars, (bar) => {
      this.hide(bar)
    })
  }

  // Shows the bar on `owner` (a content window), or focuses and selects its input if it is showing
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  open(owner: BrowserWindow): void {
    if (owner.isDestroyed()) return
    const existing = this.bars.get(owner)
    if (existing && existing.view.webContents.isDestroyed()) this.discard(existing)
    const bar = this.bars.get(owner) ?? this.create(owner)
    const restart = !bar.shown
    if (!bar.shown) {
      this.layout(bar)
      // Added last, so it sits above the window's own page
      owner.contentView.addChildView(bar.view)
      bar.shown = true
    }
    this.activate(bar, restart)
  }

  private create(owner: BrowserWindow): FindBar {
    const view = new WebContentsView({
      // A local page with a preload: confined by the webContents policy to its own page (spec R2)
      webPreferences: {
        preload: this.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        spellcheck: false
      }
    })
    // Confined to local pages for its whole life, whatever Electron's internals report
    registerPrivilegedContents(view.webContents)

    const bar: FindBar = { owner, view, contents: view.webContents, pageUrl: this.pageUrl, shown: false, loaded: false, requestId: null, detach: () => {} }
    this.bars.set(owner, bar)

    const target = owner.webContents
    const relayout = (): void => this.layout(bar)
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    const onFound = (_event: Event, result: Result): void => {
      if (bar.requestId === null || result.requestId !== bar.requestId) return
      this.send(bar, FIND_CHANNELS.result, toFindResult(result))
    }
    // A new document ends the search (Chromium drops it); the bar closes with it, as a browser's does
    const onNavigate = (): void => {
      if (bar.shown) this.hide(bar)
    }
    const onClosed = (): void => this.discard(bar)
    owner.on('resize', relayout)
    owner.once('closed', onClosed)
    target.on('found-in-page', onFound)
    target.on('did-navigate', onNavigate)
    bar.detach = () => {
      owner.off('resize', relayout)
      owner.off('closed', onClosed)
      target.off('found-in-page', onFound)
      target.off('did-navigate', onNavigate)
    }

    view.webContents.once('did-finish-load', () => {
      bar.loaded = true
      if (bar.shown) this.activate(bar, true)
    })
    // A bar that failed to load, or whose renderer died, is dropped; the next Find makes a new one
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    view.webContents.once('render-process-gone', () => this.discard(bar))
    view.webContents.loadURL(this.pageUrl).catch((error: unknown) => {
      if (isExpectedLoadAbort(error)) return
      console.error('find bar failed to load:', error)
      this.discard(bar)
    })
    return bar
  }

  // Hides the bar, removes its listeners and closes its contents (its window closed, or it broke)
  private discard(bar: FindBar): void {
    this.hide(bar)
    bar.detach()
    if (this.bars.get(bar.owner) === bar) this.bars.delete(bar.owner)
    if (!bar.view.webContents.isDestroyed()) bar.view.webContents.close()
  }

  // Moves focus into the bar only when its window already has focus, so a find never pulls the
  // app forward (on macOS, focusing a view's contents focuses its window)
  private activate(bar: FindBar, restart: boolean): void {
    if (!bar.loaded) return
    this.send(bar, FIND_CHANNELS.activate, restart)
    if (!bar.owner.isDestroyed() && bar.owner.isFocused()) bar.view.webContents.focus()
  }

  // codex:run npm test -- tests/unit/findRules.test.ts
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  private find(bar: FindBar, raw: unknown): void {
    const query = parseFindQuery(raw)
    if (!query) throw new Error(`${FIND_CHANNELS.find}: malformed query`)
    const target = bar.owner.webContents
    if (target.isDestroyed()) return
    if (query.text === '') {
      bar.requestId = null
      target.stopFindInPage('clearSelection')
      this.send(bar, FIND_CHANNELS.result, NO_MATCHES)
      return
    }
    // Electron's findNext means "start a new find session"
    bar.requestId = target.findInPage(query.text, { forward: query.forward, findNext: query.newSession })
  }

  // Hides the bar and ends the search, clearing the page's find highlight; focus goes back to the page
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  private hide(bar: FindBar): void {
    bar.requestId = null
    const { owner, view } = bar
    if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.stopFindInPage('clearSelection')
    if (!bar.shown) return
    bar.shown = false
    if (owner.isDestroyed()) return
    owner.contentView.removeChildView(view)
    if (owner.isFocused()) owner.webContents.focus()
  }

  private layout(bar: FindBar): void {
    if (bar.owner.isDestroyed()) return
    const [width, height] = bar.owner.getContentSize()
    bar.view.setBounds(findBarBounds({ width, height }))
  }

  private send(bar: FindBar, channel: string, payload: unknown): void {
    if (bar.loaded && !bar.view.webContents.isDestroyed()) bar.view.webContents.send(channel, payload)
  }
}
