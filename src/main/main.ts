import { app, BrowserWindow, Menu, nativeTheme, dialog, screen } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { WindowManager } from './services/WindowManager'
import { ContextMenuService } from './services/ContextMenuService'
import { installWebContentsPolicy, isLocalPageUrl, registerLocalPage } from './security/webContentsPolicy'
import { decideNavigation, isExpectedLoadAbort } from './security/navigationPolicy'
import { localPageUrl } from './security/localPageUrl'
import { DialogController } from './dialogs/DialogController'
import { createSettingsStore } from './services/settings'
import type { SettingsStore, ThemeSource } from './services/settings'
import { STRANDED_LOAD_DESCRIPTION, describeLoadFailure, isStranded, resolveSavedSiteUrl, shouldShowLoadError } from './services/mainWindowRules'
import type { LoadFailure } from './services/mainWindowRules'
import { mainWindowPlacement } from './services/windowBounds'
import { NavigationController } from './navigation/NavigationController'
import { sanitizeUserAgent } from './navigation/userAgent'
import { FindBarController } from './find/FindBarController'
import { appIconPath, productIconPath } from './services/appIcon'
import type { IconLocation } from './services/appIcon'
import { UpdateController } from './updates/UpdateController'

const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1200, height: 900 })
const MIN_WINDOW_SIZE = Object.freeze({ width: 800, height: 600 })
// The main window is created hidden and normally shown on its first paint; if no load event shows
// it by then, it is shown anyway, so the app is never running with no window
const MAIN_WINDOW_SHOW_FALLBACK_MS = 5_000

const THEME_CHOICES: readonly { label: string; value: ThemeSource }[] = Object.freeze([
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' }
])

// resources/ inside the packaged app, or the repo's when unpackaged (spec R5)
function iconLocation(): IconLocation {
  return { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }
}

function logLoadFailure(error: unknown): void {
  if (!isExpectedLoadAbort(error)) console.error('Failed to load:', error)
}

class JiraApp {
  private mainWindow: BrowserWindow | null = null
  private updates: UpdateController
  private windowManager: WindowManager
  private contextMenuService: ContextMenuService
  private dialogs: DialogController
  private settings: SettingsStore
  private navigation: NavigationController
  private findBars: FindBarController
  // The static page the main window shows while no site is loaded (first run, failed load)
  private readonly placeholderUrl: string
  private siteUrlCache: { raw: unknown; url: string | undefined } | null = null

  constructor() {
    // Both stores load synchronously, so they are ready before anything reads them (spec R3)
    this.settings = createSettingsStore()
    // Script-free and preload-free; registered so remote content can never navigate to it
    this.placeholderUrl = localPageUrl('placeholder.html')
    registerLocalPage(this.placeholderUrl)
    // Registers the find bar's IPC channels and page once, at startup (spec R4)
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    this.findBars = new FindBarController()
    this.navigation = new NavigationController({
      isLocalPage: isLocalPageUrl,
      // As for a remote-content window's own navigation, against the site configured now
      // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
      isAllowedInWindow: (url) => decideNavigation(url, false, { siteUrl: this.siteUrl(), isLocalPage: isLocalPageUrl }) === 'allow',
      openFind: (owner) => this.findBars.open(owner),
      // Back / Forward from the load-error placeholder: as any other site load, about:blank first
      // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
      leaveLocalPage: (win, url) => this.loadSite(url, win)
    })
    // WindowManager windows are content windows too: Back/Forward, swipe, app-command and Find.
    // Product icons that do not ship fall back to the app icon.
    // codex:run npm test -- tests/unit/appIcon.test.ts
    this.windowManager = new WindowManager(
      (window) => this.navigation.attach(window),
      (iconFile) => productIconPath(iconLocation(), iconFile, existsSync)
    )
    // Its Back / Forward go through the navigation controller, like the Go menu's
    // codex:run npm test -- tests/unit/ContextMenuService.test.ts
    this.contextMenuService = new ContextMenuService(this.windowManager, () => this.siteUrl(), this.navigation)
    // Registers the dialog IPC channels once, at startup (spec R2)
    // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
    // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
    this.dialogs = new DialogController({
      getParentWindow: () => this.mainWindow,
      getSiteUrl: () => this.siteUrl(),
      setSiteUrl: (url) => this.setSiteUrl(url),
      retryLoad: (url) => this.loadSite(url),
      windowManager: this.windowManager
    })
    // Packaged builds only: the feed is the app-update.yml electron-builder generates from
    // build.publish, and the updater is not even constructed in dev or e2e (spec R5)
    // codex:run npm test -- tests/unit/UpdateController.test.ts
    // codex:run npm run test:e2e -- tests/e2e/updates.spec.ts
    this.updates = new UpdateController({
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      getUpdater: () => autoUpdater,
      skippedVersion: {
        get: () => this.settings.get('skippedVersion'),
        set: (version) => {
          this.settings.set('skippedVersion', version)
          this.settings.flush()
        }
      },
      showMessageBox: (options) => {
        const parent = this.mainWindow
        return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
      }
    })
    this.initializeApp()
  }

  // The configured site, re-validated from settings.json on every read (the file is outside the
  // app's control, and main's own loadURL bypasses the navigation policy); undefined until set.
  // codex:run npm test -- tests/unit/mainWindowRules.test.ts
  private siteUrl(): string | undefined {
    const raw = this.settings.get('jiraUrl')
    let cache = this.siteUrlCache
    if (!cache || cache.raw !== raw) {
      cache = { raw, url: resolveSavedSiteUrl(raw, isLocalPageUrl) }
      this.siteUrlCache = cache
    }
    return cache.url
  }

  // From the set-url / welcome dialog: persisted at once, then loaded
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  private setSiteUrl(url: string): void {
    this.settings.set('jiraUrl', url)
    this.settings.flush()
    if (this.mainWindow) this.loadSite(url)
    else this.createWindow()
  }

  private initializeApp(): void {
    // Electron's default UA without its Electron/<v> and <app name>/<v> tokens, which Google sign-in
    // refuses (spec R4). Set before 'ready', so the default session and every window get it.
    // codex:run npm test -- tests/unit/userAgent.test.ts
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    app.userAgentFallback = sanitizeUserAgent(app.userAgentFallback, ['Electron', app.getName()])

    // Navigation, window.open, <webview> and permission policy for every webContents and session
    // (spec R2). Installed before 'ready' so it covers the first window.
    // codex:run npm run test:e2e -- tests/e2e/security.spec.ts
    installWebContentsPolicy(() => this.siteUrl())

    // A second launch (it quits at once, see the bottom of this file) brings this one forward
    // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
    app.on('second-instance', () => {
      const win = this.mainWindow
      if (!win || win.isDestroyed()) {
        if (app.isReady()) this.createWindow()
        return
      }
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })

    // Handle app ready
    app.whenReady().then(() => {
      // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
      nativeTheme.themeSource = this.settings.get('themeSource', 'system')
      this.createWindow()
      this.setupMenu()
      this.updates.startAutomaticChecks()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.createWindow()
        }
      })
    })

    // Quit when all windows are closed
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        this.windowManager.closeAllWindows()
        app.quit()
      }
    })

    // Handle app termination. Pending debounced writes are flushed synchronously; will-quit
    // flushes again for state saved while the windows were closing.
    // codex:run npm run test:e2e -- tests/e2e/storage.spec.ts
    app.on('before-quit', () => {
      this.windowManager.closeAllWindows()
      this.flushStorage()
    })
    app.on('will-quit', () => this.flushStorage())
  }

  private flushStorage(): void {
    this.windowManager.flush()
    this.settings.flush()
  }

  private createWindow(): void {
    // Saved bounds only while they are on a display that still exists (spec R3)
    // codex:run npm test -- tests/unit/windowBounds.test.ts
    // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
    const placement = mainWindowPlacement(
      this.settings.get('mainWindow'),
      screen.getAllDisplays().map((display) => display.workArea),
      DEFAULT_WINDOW_SIZE,
      MIN_WINDOW_SIZE
    )
    const win = new BrowserWindow({
      ...placement.options,
      minWidth: MIN_WINDOW_SIZE.width,
      minHeight: MIN_WINDOW_SIZE.height,
      show: false,
      autoHideMenuBar: false,
      // codex:run npm test -- tests/unit/appIcon.test.ts
      icon: appIconPath(iconLocation()),
      // Remote content: no preload, no Node, sandboxed and isolated (spec R2). It also shows the
      // placeholder, which needs nothing more.
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    })
    this.mainWindow = win

    // Shown once: on its first paint, or when loading first stops or a main-frame load fails before
    // one (a load the policy cancelled paints nothing, so ready-to-show never comes), or after a
    // bounded wait. Never again after that, so a window the user hid stays hidden.
    // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
    let revealed = false
    const reveal = (): void => {
      if (revealed || win.isDestroyed()) return
      revealed = true
      clearTimeout(revealFallback)
      win.webContents.off('did-stop-loading', reveal)
      if (!win.isVisible()) {
        if (placement.maximize) win.maximize()
        win.show()
      }
    }
    const revealFallback = setTimeout(reveal, MAIN_WINDOW_SHOW_FALLBACK_MS)
    win.once('ready-to-show', reveal)
    win.webContents.on('did-stop-loading', reveal)

    win.on('closed', () => {
      clearTimeout(revealFallback)
      if (this.mainWindow === win) this.mainWindow = null
    })

    // Bounds (as restored, when maximized) and maximized state, kept current; the store debounces
    // the writes and the quit path flushes them
    const saveState = (): void => {
      if (win.isDestroyed()) return
      this.settings.set('mainWindow', { bounds: win.getNormalBounds(), isMaximized: win.isMaximized() })
    }
    win.on('resized', saveState)
    win.on('moved', saveState)
    win.on('maximize', saveState)
    win.on('unmaximize', saveState)
    win.on('close', saveState)

    // A failed main-frame load (not an aborted one) shows the error view (see loadSite for an
    // aborted one that leaves nothing to show)
    // codex:run npm test -- tests/unit/mainWindowRules.test.ts
    // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) reveal()
      if (!shouldShowLoadError(errorCode, isMainFrame, validatedURL, isLocalPageUrl)) return
      // Not from inside the event: Chromium is still committing its own error page
      setImmediate(() => this.showLoadError(win, describeLoadFailure(validatedURL, errorDescription, this.siteUrl())))
    })

    this.contextMenuService.setupForWindow(win)
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    this.navigation.attach(win)

    const site = this.siteUrl()
    if (site) this.loadSite(site)
    else this.showPlaceholder(win, () => this.dialogs.open('welcome'))
  }

  // Loads `then` once the placeholder is up (or failed to come up)
  private showPlaceholder(win: BrowserWindow, then: () => void): void {
    win
      .loadURL(this.placeholderUrl)
      .catch(logLoadFailure)
      .finally(() => {
        if (!win.isDestroyed() && this.mainWindow === win) then()
      })
  }

  private showErrorIfStranded(win: BrowserWindow, url: string): void {
    if (win.isDestroyed() || this.mainWindow !== win) return
    const contents = win.webContents
    if (!isStranded(contents.getURL(), contents.isLoading(), isLocalPageUrl)) return
    this.showLoadError(win, describeLoadFailure(url, STRANDED_LOAD_DESCRIPTION, this.siteUrl()))
  }

  private showLoadError(win: BrowserWindow, failure: LoadFailure): void {
    if (win.isDestroyed() || this.mainWindow !== win) return
    this.showPlaceholder(win, () => this.dialogs.showLoadError(failure))
  }

  // Loads a site URL (already validated: the saved site, a dialog result, a load failure's retryUrl
  // or a history entry Back / Forward chose) in the main window, or in `win`. While it shows the
  // placeholder, a local page, the policy treats it as confined and would hand the site's own
  // redirects to the browser; so it leaves the placeholder for about:blank first.
  // A site load that ends with nothing to show for it shows the error view, not a blank (at startup,
  // never shown) window. The policy cancelling the site's redirect (sent to the browser, or refused)
  // does that: no did-fail-load fires and nothing commits; loadURL only rejects.
  // codex:run npm test -- tests/unit/mainWindowRules.test.ts
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  private loadSite(url: string, win: BrowserWindow | null = this.mainWindow): void {
    if (!win || win.isDestroyed()) return
    const load = (): void => {
      if (win.isDestroyed()) return
      win.loadURL(url).catch((error: unknown) => {
        logLoadFailure(error)
        // Checked once the rejection has settled: a newer load that superseded this one, or the
        // error view a real failure opened (did-fail-load), is under way by then
        setImmediate(() => this.showErrorIfStranded(win, url))
      })
    }
    if (isLocalPageUrl(win.webContents.getURL())) win.loadURL('about:blank').then(load, load)
    else load()
  }

  private setupMenu(): void {
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    const navigation = this.navigation.menuItems()
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Jira Desktop',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Set Jira URL...',
            accelerator: 'CommandOrControl+U',
            click: () => this.dialogs.open('set-url')
          },
          { type: 'separator' },
          {
            label: 'Check for Updates...',
            click: () => void this.updates.check('manual')
          },
          { type: 'separator' },
          {
            label: 'New Atlassian Window...',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => this.dialogs.open('new-window')
          },
          {
            label: 'Close All Windows',
            accelerator: 'CmdOrCtrl+Shift+W',
            click: () => this.windowManager.closeAllWindows()
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          navigation.find
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          {
            label: 'Appearance',
            // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
            submenu: THEME_CHOICES.map(({ label, value }) => ({
              label,
              type: 'radio' as const,
              checked: nativeTheme.themeSource === value,
              click: () => this.setTheme(value)
            }))
          },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Go',
        submenu: navigation.go
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close' }
        ]
      }
    ]

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
    this.navigation.refreshMenu()
  }

  // Applied, persisted, and the menu rebuilt so exactly the chosen radio is checked
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  private setTheme(theme: ThemeSource): void {
    nativeTheme.themeSource = theme
    this.settings.set('themeSource', theme)
    this.setupMenu()
  }
}

// Test isolation: JIRA_DESKTOP_USER_DATA_DIR redirects the whole profile (must run before 'ready'
// and before JiraApp constructs services that read the userData path)
// codex:run npm run test:e2e -- tests/e2e/smoke.spec.ts
const userDataDirOverride = process.env.JIRA_DESKTOP_USER_DATA_DIR
if (userDataDirOverride) {
  app.setPath('userData', resolve(userDataDirOverride))
}

// One instance per profile: the lock lives in the userData dir, so it is taken after the override
// above (e2e launches, each on its own dir, never collide). A second launch hands over to the first
// (its 'second-instance') and quits before creating anything.
// codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
if (app.requestSingleInstanceLock()) {
  new JiraApp()
} else {
  app.quit()
}