// The app's one dialog window (Set Jira URL / New Atlassian Window): a sandboxed local page with
// its own minimal preload, at most one open at a time. IPC channels are registered once, here, and
// answer only the open dialog's own page (security/localPageIpc.ts).
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { DIALOG_CHANNELS } from '../../shared/dialog'
import type { DialogInit, DialogMode, DialogSubmitResult, ProductChoice } from '../../shared/dialog'
import { handleFromLocalPage } from '../security/localPageIpc'
import type { LocalPage } from '../security/localPageIpc'
import { isExpectedLoadAbort } from '../security/navigationPolicy'
import { registerLocalPage } from '../security/webContentsPolicy'
import type { WindowManager } from '../services/WindowManager'
import { parseSubmitPayload, validateDialogUrl } from './dialogRules'

export interface DialogControllerDeps {
  // The main window, if open: the dialog is its modal child
  getParentWindow: () => BrowserWindow | null
  // The configured site (shown in set-url mode, and in-app for new-window mode)
  getSiteUrl: () => string | undefined
  // Called with the normalized URL after a successful set-url submit
  setSiteUrl: (url: string) => void
  windowManager: Pick<WindowManager, 'createWindow' | 'identifyProduct' | 'getProductById'>
}

interface OpenDialog extends LocalPage {
  window: BrowserWindow
  mode: DialogMode
  // Submitted or cancelled: closing, and no longer answered
  settled: boolean
}

const WINDOW_OPTIONS: Record<DialogMode, { title: string; width: number; height: number }> = {
  'set-url': { title: 'Set Jira URL', width: 480, height: 250 },
  'new-window': { title: 'New Atlassian Window', width: 480, height: 400 }
}

// The built page, or the electron-vite dev server's copy under `npm run dev` (never when packaged)
function dialogPageUrl(): string {
  const devServer = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  if (devServer) return new URL('dialog.html', devServer.endsWith('/') ? devServer : `${devServer}/`).href
  return pathToFileURL(join(__dirname, '../renderer/dialog.html')).href
}

export class DialogController {
  private readonly deps: DialogControllerDeps
  private readonly pageUrl: string
  private readonly preloadPath = join(__dirname, '../preload/dialog.js')
  private current: OpenDialog | null = null

  // Construct once, at startup: it registers the IPC channels and the dialog page as a local page
  constructor(deps: DialogControllerDeps) {
    this.deps = deps
    this.pageUrl = dialogPageUrl()
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

  // Opens the dialog, or focuses the one already open (whatever its mode)
  // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
  open(mode: DialogMode): void {
    const open = this.current
    if (open && !open.window.isDestroyed()) {
      open.window.focus()
      return
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
    window.removeMenu()

    const dialog: OpenDialog = { window, contents: window.webContents, pageUrl: this.pageUrl, mode, settled: false }
    this.current = dialog
    window.once('ready-to-show', () => window.show())
    window.once('closed', () => {
      if (this.current === dialog) this.current = null
    })
    window.loadURL(this.pageUrl).catch((error: unknown) => {
      if (!isExpectedLoadAbort(error)) console.error('dialog failed to load:', error)
    })
  }

  private init(dialog: OpenDialog): DialogInit {
    if (dialog.mode === 'new-window') return { mode: dialog.mode }
    const currentUrl = this.deps.getSiteUrl()
    return currentUrl === undefined ? { mode: dialog.mode } : { mode: dialog.mode, currentUrl }
  }

  // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
  private submit(dialog: OpenDialog, raw: unknown): DialogSubmitResult {
    const payload = parseSubmitPayload(dialog.mode, raw)
    if (!payload) throw new Error(`${DIALOG_CHANNELS.submit}: malformed payload`)
    const result = validateDialogUrl(dialog.mode, payload.url, this.deps.getSiteUrl())
    if (!result.ok) return result

    if (dialog.mode === 'set-url') {
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
