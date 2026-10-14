import { app, BrowserWindow, Menu, nativeTheme, dialog, screen } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, resolve } from 'path'
import { WindowManager } from './services/WindowManager'
import { ContextMenuService } from './services/ContextMenuService'
import { installWebContentsPolicy, isLocalPageUrl, registerLocalPage } from './security/webContentsPolicy'
import { isExpectedLoadAbort } from './security/navigationPolicy'
import { localPageUrl } from './security/localPageUrl'
import { DialogController } from './dialogs/DialogController'
import { createSettingsStore } from './services/settings'
import type { SettingsStore, ThemeSource } from './services/settings'
import { STRANDED_LOAD_DESCRIPTION, describeLoadFailure, isStranded, resolveSavedSiteUrl, shouldShowLoadError } from './services/mainWindowRules'
import type { LoadFailure } from './services/mainWindowRules'
import { mainWindowPlacement } from './services/windowBounds'

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

function logLoadFailure(error: unknown): void {
  if (!isExpectedLoadAbort(error)) console.error('Failed to load:', error)
}

class JiraApp {
  private mainWindow: BrowserWindow | null = null
  private manualUpdateCheck: boolean = false
  private windowManager: WindowManager
  private contextMenuService: ContextMenuService
  private dialogs: DialogController
  private settings: SettingsStore
  // The static page the main window shows while no site is loaded (first run, failed load)
  private readonly placeholderUrl: string
  private siteUrlCache: { raw: unknown; url: string | undefined } | null = null

  constructor() {
    // Both stores load synchronously, so they are ready before anything reads them (spec R3)
    this.settings = createSettingsStore()
    // Script-free and preload-free; registered so remote content can never navigate to it
    this.placeholderUrl = localPageUrl('placeholder.html')
    registerLocalPage(this.placeholderUrl)
    this.windowManager = new WindowManager()
    this.contextMenuService = new ContextMenuService(this.windowManager, () => this.siteUrl())
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
    this.initializeApp()
    this.setupAutoUpdater()
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
      icon: join(__dirname, '../../resources/icon.png'),
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

  // Loads a site URL (already validated: the saved site, a dialog result or a load failure's
  // retryUrl) in the main window. While it shows the placeholder, a local page, the policy treats
  // it as confined and would hand the site's own redirects to the browser; so it leaves the
  // placeholder for about:blank first.
  // A site load that ends with nothing to show for it shows the error view, not a blank (at startup,
  // never shown) window. The policy cancelling the site's redirect (sent to the browser, or refused)
  // does that: no did-fail-load fires and nothing commits; loadURL only rejects.
  // codex:run npm test -- tests/unit/mainWindowRules.test.ts
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  private loadSite(url: string): void {
    const win = this.mainWindow
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
            click: () => this.manualCheckForUpdates()
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
          { role: 'selectAll' }
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
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close' }
        ]
      }
    ]

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
  }

  // Applied, persisted, and the menu rebuilt so exactly the chosen radio is checked
  // codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
  private setTheme(theme: ThemeSource): void {
    nativeTheme.themeSource = theme
    this.settings.set('themeSource', theme)
    this.setupMenu()
  }

  private setupAutoUpdater(): void {
    // Configure auto-updater for GitHub releases
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'JoshWay',
      repo: 'jira-desktop'
    })

    // Check for updates when app starts (after window is ready)
    app.whenReady().then(() => {
      setTimeout(() => {
        this.checkForUpdates()
      }, 3000) // Wait 3 seconds after app start
    })

    // Handle update events
    autoUpdater.on('update-available', (info) => {
      this.showUpdateDialog(info)
    })

    autoUpdater.on('update-not-available', () => {
      console.log('App is up to date')
      // Only show dialog for manual checks, not automatic startup checks
      if (this.manualUpdateCheck) {
        this.showNoUpdateDialog()
        this.manualUpdateCheck = false
      }
    })

    autoUpdater.on('error', (error) => {
      console.error('Auto-updater error:', error)
      // Show user-friendly error dialog for manual checks
      if (this.manualUpdateCheck) {
        this.showUpdateErrorDialog(error.message)
        this.manualUpdateCheck = false
      }
    })

    autoUpdater.on('download-progress', (progress) => {
      console.log(`Download progress: ${Math.round(progress.percent)}%`)
    })

    autoUpdater.on('update-downloaded', () => {
      this.showRestartDialog()
    })
  }

  private async checkForUpdates(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      console.error('Failed to check for updates:', error)
      // Error handling is done in the error event handler
    }
  }

  private async manualCheckForUpdates(): Promise<void> {
    this.manualUpdateCheck = true
    try {
      await this.checkForUpdates()
    } catch (error) {
      // Fallback error handling if the event handler doesn't catch it
      if (this.manualUpdateCheck) {
        this.showUpdateErrorDialog('Unable to check for updates. Please try again later.')
        this.manualUpdateCheck = false
      }
    }
  }

  private async showUpdateDialog(updateInfo: any): Promise<void> {
    const result = await dialog.showMessageBox(this.mainWindow!, {
      type: 'info',
      title: 'Update Available',
      message: `Jira Desktop v${updateInfo.version} is available!`,
      detail: `You're currently running v${app.getVersion()}. Would you like to download and install the update?`,
      buttons: ['Update Now', 'Remind Me Later', 'Skip This Version'],
      defaultId: 0,
      cancelId: 1
    })

    switch (result.response) {
      case 0: // Update Now
        autoUpdater.downloadUpdate()
        this.showDownloadingDialog()
        break
      case 1: // Remind Me Later
        console.log('User chose to be reminded later')
        break
      case 2: // Skip This Version
        console.log('User chose to skip this version')
        break
    }
  }

  private showDownloadingDialog(): void {
    dialog.showMessageBox(this.mainWindow!, {
      type: 'info',
      title: 'Downloading Update',
      message: 'Downloading update...',
      detail: 'The update is being downloaded in the background. You\'ll be notified when it\'s ready to install.',
      buttons: ['OK']
    })
  }

  private async showRestartDialog(): Promise<void> {
    const result = await dialog.showMessageBox(this.mainWindow!, {
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded successfully!',
      detail: 'The update has been downloaded and is ready to install. Would you like to restart the app now?',
      buttons: ['Restart Now', 'Restart Later'],
      defaultId: 0,
      cancelId: 1
    })

    if (result.response === 0) {
      autoUpdater.quitAndInstall()
    }
  }

  private showNoUpdateDialog(): void {
    dialog.showMessageBox(this.mainWindow!, {
      type: 'info',
      title: 'No Updates Available',
      message: 'You\'re running the latest version!',
      detail: `Jira Desktop v${app.getVersion()} is up to date. No new updates are available at this time.`,
      buttons: ['OK']
    })
  }

  private showUpdateErrorDialog(_errorMessage: string): void {
    dialog.showMessageBox(this.mainWindow!, {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Unable to check for updates',
      detail: 'There was a problem checking for updates. Please check your internet connection and try again later.',
      buttons: ['OK']
    })
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