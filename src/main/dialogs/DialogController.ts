// The app's one dialog window: Set Jira URL / New Atlassian Window (from the menu), and Welcome /
// the load-error view (opened by the app itself while the main window shows its placeholder). A
// sandboxed local page with its own minimal preload, at most one open at a time. IPC channels are
// registered once, here, and answer only the open dialog's own page (security/localPageIpc.ts).
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
// codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { DIALOG_CHANNELS } from '../../shared/dialog'
import type { DialogInit, DialogMode, DialogSubmitResult, ProductChoice, UrlDialogMode } from '../../shared/dialog'
import { handleFromLocalPage } from '../security/localPageIpc'
import type { LocalPage } from '../security/localPageIpc'
import { localPageUrl } from '../security/localPageUrl'
import { isExpectedLoadAbort } from '../security/navigationPolicy'
import { registerLocalPage, registerPrivilegedContents } from '../security/webContentsPolicy'
import type { LoadFailure } from '../services/mainWindowRules'
import type { WindowManager } from '../services/WindowManager'
import { parseLoadErrorSubmit, parseSubmitPayload, validateDialogUrl } from './dialogRules'

export interface DialogControllerDeps {
  // The main window, if open: the dialog is its modal child
  getParentWindow: () => BrowserWindow | null
  // The configured site (shown in set-url mode, and in-app for new-window mode)
  getSiteUrl: () => string | undefined
  // Called with the normalized URL after a successful set-url or welcome submit
  setSiteUrl: (url: string) => void
  // Called with LoadFailure.retryUrl when the load-error view's Retry is chosen
  retryLoad: (url: string) => void
  windowManager: Pick<WindowManager, 'createWindow' | 'identifyProduct' | 'getProductById'>
}

interface OpenDialog extends LocalPage {
  window: BrowserWindow
  mode: DialogMode
  // load-error only
  failure?: LoadFailure
  // Submitted or cancelled: closing, and no longer answered
  settled: boolean
}

const WINDOW_OPTIONS: Record<DialogMode, { title: string; width: number; height: number }> = {
  'set-url': { title: 'Set Jira URL', width: 480, height: 250 },
  'new-window': { title: 'New Atlassian Window', width: 480, height: 400 },
  welcome: { title: 'Welcome to Jira Desktop', width: 480, height: 300 },
  'load-error': { title: 'Couldn’t load Jira', width: 480, height: 290 }
}

// Opened by the app, not the user: a newer one replaces an open one instead of being dropped
const APP_OPENED: ReadonlySet<DialogMode> = new Set<DialogMode>(['welcome', 'load-error'])

export class DialogController {
  private readonly deps: DialogControllerDeps
  private readonly pageUrl: string
  private readonly preloadPath = join(__dirname, '../preload/dialog.js')
  private current: OpenDialog | null = null

  // Construct once, at startup: it registers the IPC channels and the dialog page as a local page
  constructor(deps: DialogControllerDeps) {
    this.deps = deps
    this.pageUrl = localPageUrl('dialog.html')
    registerLocalPage(this.pageUrl)

    // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
    const answering = (): OpenDialog | null => {
      const open = this.current
      return open && !open.settled && !open.window.isDestroyed() ? open : null
    }
    handleFromLocalPage(DIALOG_CHANNELS.getInit, answering, (dialog) => this.init(dialog))
    handleFromLocalPage(DIALOG_CHANNELS.submit, answering, (dialog, payload) => this.submit(dialog, payload))
    handleFromLocalPage(DIALOG_CHANNELS.cancel, answering, (dialog) => {
      this.settle(dialog)
    })
  }

  // Opens a dialog, or focuses the one already open (whatever its mode)
  open(mode: UrlDialogMode): void {
    this.show(mode)
  }

  // The load-error view for a failed main-window load (replaces an open welcome / load-error view)
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  showLoadError(failure: LoadFailure): void {
    this.show('load-error', failure)
  }

  // One that is settled is already closing, so a new one opens instead of the request being
  // swallowed. An open dialog the user asked for is focused and kept; one the app opened gives
  // way to a newer app-opened one (e.g. a second load failure).
  // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
  private show(mode: DialogMode, failure?: LoadFailure): void {
    const open = this.current
    if (open && !open.settled && !open.window.isDestroyed()) {
      if (!APP_OPENED.has(mode) || !APP_OPENED.has(open.mode)) {
        open.window.focus()
        return
      }
      this.settle(open)
    }

    const parent = this.deps.getParentWindow()
    const owner = parent && !parent.isDestroyed() ? parent : undefined
    const window = new BrowserWindow({
      ...WINDOW_OPTIONS[mode],
      useContentSize: true,
      show: false,
      parent: owner,
      modal: owner !== undefined,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
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
    registerPrivilegedContents(window.webContents)
    window.removeMenu()

    const dialog: OpenDialog = { window, contents: window.webContents, pageUrl: this.pageUrl, mode, failure, settled: false }
    this.current = dialog
    window.once('ready-to-show', () => window.show())
    window.once('closed', () => {
      if (this.current === dialog) this.current = null
    })
    // A page that failed to load never shows (no ready-to-show); close it so it does not stay
    // the hidden current dialog that every later open() would only focus
    // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
    window.loadURL(this.pageUrl).catch((error: unknown) => {
      if (isExpectedLoadAbort(error)) return
      console.error('dialog failed to load:', error)
      if (!window.isDestroyed()) window.close()
    })
  }

  private init(dialog: OpenDialog): DialogInit {
    switch (dialog.mode) {
      case 'new-window':
      case 'welcome':
        return { mode: dialog.mode }
      case 'load-error':
        return { mode: dialog.mode, failedUrl: dialog.failure?.failedUrl ?? '', errorDescription: dialog.failure?.errorDescription ?? '' }
      case 'set-url': {
        const currentUrl = this.deps.getSiteUrl()
        return currentUrl === undefined ? { mode: dialog.mode } : { mode: dialog.mode, currentUrl }
      }
    }
  }

  // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  private submit(dialog: OpenDialog, raw: unknown): DialogSubmitResult {
    if (dialog.mode === 'load-error') return this.submitLoadError(dialog, raw)

    const payload = parseSubmitPayload(dialog.mode, raw)
    if (!payload) throw new Error(`${DIALOG_CHANNELS.submit}: malformed payload`)
    const result = validateDialogUrl(dialog.mode, payload.url, this.deps.getSiteUrl())
    if (!result.ok) return result

    if (dialog.mode !== 'new-window') {
      this.settle(dialog)
      this.deps.setSiteUrl(result.url)
      return { ok: true }
    }
    const product = this.productFor(result.url, payload.product ?? 'auto')
    if (!product) return { ok: false, error: 'Choose the product for this address.' }
    this.settle(dialog)
    // Errors are handled (and logged) inside createWindow
    void this.deps.windowManager.createWindow({ url: result.url, product, focused: !payload.background })
    return { ok: true }
  }

  // Retry reloads what failed (main decided what that may be: LoadFailure.retryUrl); Change URL,
  // or Retry with nothing safe to retry, swaps this view for the set-url dialog
  private submitLoadError(dialog: OpenDialog, raw: unknown): DialogSubmitResult {
    const payload = parseLoadErrorSubmit(raw)
    if (!payload) throw new Error(`${DIALOG_CHANNELS.submit}: malformed payload`)
    this.settle(dialog)
    const retryUrl = dialog.failure?.retryUrl
    if (payload.action === 'retry' && retryUrl !== undefined) this.deps.retryLoad(retryUrl)
    else this.show('set-url')
    return { ok: true }
  }

  // Auto-detect falls back to Jira: the URL is already known to be in-app (e.g. a self-hosted site)
  private productFor(url: string, choice: ProductChoice) {
    const { windowManager } = this.deps
    if (choice !== 'auto') return windowManager.getProductById(choice)
    return windowManager.identifyProduct(url) ?? windowManager.getProductById('jira')
  }

  // Stops answering the dialog at once, and closes it after the current reply has been sent
  private settle(dialog: OpenDialog): void {
    dialog.settled = true
    setImmediate(() => {
      if (!dialog.window.isDestroyed()) dialog.window.close()
    })
  }
}
