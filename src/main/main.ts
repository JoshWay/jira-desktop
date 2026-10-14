import { app, BrowserWindow, Menu, nativeTheme, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, resolve } from 'path'
import { WindowManager } from './services/WindowManager'
import { ContextMenuService } from './services/ContextMenuService'
import { installWebContentsPolicy } from './security/webContentsPolicy'
import { isExpectedLoadAbort } from './security/navigationPolicy'
import { DialogController } from './dialogs/DialogController'
import { createSettingsStore } from './services/settings'
import type { SettingsStore } from './services/settings'

class JiraApp {
  private mainWindow: BrowserWindow | null = null
  private jiraUrl: string = 'https://id.atlassian.com/login'
  private manualUpdateCheck: boolean = false
  private windowManager: WindowManager
  private contextMenuService: ContextMenuService
  private dialogs: DialogController
  private settings: SettingsStore

  constructor() {
    // Both stores load synchronously, so they are ready before anything reads them (spec R3)
    this.settings = createSettingsStore()
    this.windowManager = new WindowManager()
    this.contextMenuService = new ContextMenuService(this.windowManager, () => this.jiraUrl)
    // Registers the dialog IPC channels once, at startup (spec R2)
    // codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
    this.dialogs = new DialogController({
      getParentWindow: () => this.mainWindow,
      getSiteUrl: () => this.jiraUrl,
      setSiteUrl: (url) => {
        this.jiraUrl = url
        if (this.mainWindow) this.loadJiraApp()
        else this.createWindow()
      },
      windowManager: this.windowManager
    })
    this.initializeApp()
    this.setupAutoUpdater()
  }

  private initializeApp(): void {
    // Navigation, window.open, <webview> and permission policy for every webContents and session
    // (spec R2). Installed before 'ready' so it covers the first window.
    // codex:run npm run test:e2e -- tests/e2e/security.spec.ts
    installWebContentsPolicy(() => this.jiraUrl)

    // Handle app ready
    app.whenReady().then(() => {
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
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      show: false,
      autoHideMenuBar: false,
      icon: join(__dirname, '../../resources/icon.png'),
      // Remote content: no preload, no Node, sandboxed and isolated (spec R2)
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    })

    // Handle window ready
    this.mainWindow.on('ready-to-show', () => {
      this.mainWindow?.show()
    })

    // Handle window closed
    this.mainWindow.on('closed', () => {
      this.mainWindow = null
    })

    // Setup context menu for the main window
    this.contextMenuService.setupForWindow(this.mainWindow)

    // Load Jira directly
    this.loadJiraApp()
  }

  private loadJiraApp(): void {
    if (!this.mainWindow) return

    // Load Jira directly - just like the original Nativefier approach
    this.mainWindow.loadURL(this.jiraUrl).catch((error: unknown) => {
      if (!isExpectedLoadAbort(error)) console.error('Failed to load Jira:', error)
    })
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
          {
            label: 'Toggle Dark Mode',
            accelerator: 'CommandOrControl+Shift+D',
            click: () => this.toggleDarkMode()
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

  private toggleDarkMode(): void {
    nativeTheme.themeSource = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'
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

// Initialize the app
new JiraApp()