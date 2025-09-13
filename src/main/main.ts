import { app, BrowserWindow, Menu, nativeTheme, ipcMain, shell, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { WindowManager } from './services/WindowManager'
import { ContextMenuService } from './services/ContextMenuService'

class JiraApp {
  private mainWindow: BrowserWindow | null = null
  private jiraUrl: string = 'https://id.atlassian.com/login'
  private manualUpdateCheck: boolean = false
  private windowManager: WindowManager
  private contextMenuService: ContextMenuService

  constructor() {
    this.windowManager = new WindowManager()
    this.contextMenuService = new ContextMenuService(this.windowManager)
    this.initializeApp()
    this.setupAutoUpdater()
  }

  private initializeApp(): void {
    // Handle app ready
    app.whenReady().then(() => {
      this.createWindow()
      this.setupMenu()
      this.setupIpcHandlers()

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

    // Handle app termination
    app.on('before-quit', () => {
      this.windowManager.closeAllWindows()
    })

    // Handle external links and navigation
    app.on('web-contents-created', (_, contents) => {
      // Handle new window creation (target="_blank" links)
      contents.setWindowOpenHandler(({ url }) => {
        if (this.isAtlassianUrl(url)) {
          // Navigate in current window instead of opening new window
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.loadURL(url)
          }
          return { action: 'deny' }
        }
        shell.openExternal(url)
        return { action: 'deny' }
      })

      // Handle navigation within the same window (including dropdown menu clicks)
      contents.on('will-navigate', (event, navigationUrl) => {
        const currentUrl = contents.getURL()
        
        // Allow navigation within Atlassian domains
        if (this.isAtlassianUrl(navigationUrl)) {
          // Allow the navigation to proceed within the app
          return
        }
        
        // For non-Atlassian URLs, prevent navigation and open externally
        if (!this.isAtlassianUrl(currentUrl) || !this.isAtlassianUrl(navigationUrl)) {
          event.preventDefault()
          shell.openExternal(navigationUrl)
        }
      })
    })
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
      webPreferences: {
        preload: join(__dirname, '../preload/preload.js'),
        sandbox: false,
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
    this.mainWindow.loadURL(this.jiraUrl)
  }

  private isAtlassianUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url)
      const hostname = parsedUrl.hostname.toLowerCase()
      
      // Allow all Atlassian services to stay within the app
      return (
        hostname.includes('atlassian.net') ||
        hostname.includes('atlassian.com') ||
        hostname.includes('bitbucket.org') ||
        hostname.includes('trello.com') ||
        hostname === 'id.atlassian.com' ||
        url.startsWith(this.jiraUrl)
      )
    } catch {
      return false
    }
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
            click: () => this.promptForJiraUrl()
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
            click: () => this.promptForNewWindow()
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

  private setupIpcHandlers(): void {
    ipcMain.handle('get-theme', () => {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    })

    ipcMain.handle('set-jira-url', (_, url: string) => {
      this.jiraUrl = url
      this.loadJiraApp()
      return true
    })

    // Handle theme change notifications
    nativeTheme.on('updated', () => {
      const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      this.mainWindow?.webContents.send('theme-changed', theme)
    })
  }

  private async promptForJiraUrl(): Promise<void> {
    // Create a simple prompt window (independent, not modal)
    const promptWindow = new BrowserWindow({
      width: 500,
      height: 300,
      resizable: false,
      modal: false,
      alwaysOnTop: true,
      center: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    const promptHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Set Jira URL</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          padding: 30px;
          margin: 0;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h2 { margin-top: 0; color: #333; }
        label { display: block; margin-bottom: 8px; font-weight: 500; }
        input { 
          width: 100%; 
          padding: 12px; 
          border: 2px solid #ddd; 
          border-radius: 6px; 
          font-size: 14px;
          margin-bottom: 20px;
        }
        input:focus { outline: none; border-color: #0052cc; }
        .buttons { display: flex; gap: 10px; justify-content: flex-end; }
        button {
          padding: 10px 20px;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          cursor: pointer;
        }
        .primary { background: #0052cc; color: white; }
        .primary:hover { background: #0747a6; }
        .secondary { background: #f4f5f7; color: #333; }
        .secondary:hover { background: #e4e5ea; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🚀 Set Jira URL</h2>
        <label for="url">Enter your company's Jira URL:</label>
        <input type="url" id="url" value="${this.jiraUrl}" placeholder="https://your-company.atlassian.net" autofocus>
        <div class="buttons">
          <button class="secondary" onclick="window.close()">Cancel</button>
          <button class="primary" onclick="setUrl()">Set URL</button>
        </div>
      </div>
      <script>
        function setUrl() {
          const url = document.getElementById('url').value.trim();
          if (url) {
            require('electron').ipcRenderer.send('set-jira-url', url);
            window.close();
          }
        }
        document.getElementById('url').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') setUrl();
          if (e.key === 'Escape') window.close();
        });
      </script>
    </body>
    </html>`

    promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml)}`)
    
    // Handle the URL setting
    ipcMain.once('set-jira-url', (_, url: string) => {
      let normalizedUrl = url
      
      // Normalize URL
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'https://' + normalizedUrl
      }
      
      // Add /jira/projects if it's an Atlassian domain
      if (normalizedUrl.includes('atlassian.net') && !normalizedUrl.includes('/jira')) {
        normalizedUrl = normalizedUrl.replace(/\/$/, '') + '/jira/projects'
      }
      
      this.jiraUrl = normalizedUrl
      this.loadJiraApp()
      promptWindow.close()
    })
  }

  private toggleDarkMode(): void {
    nativeTheme.themeSource = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'
  }

  private async promptForNewWindow(): Promise<void> {
    const promptWindow = new BrowserWindow({
      width: 500,
      height: 350,
      resizable: false,
      modal: false,
      alwaysOnTop: true,
      center: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    const promptHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Open New Atlassian Window</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          padding: 30px;
          margin: 0;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h2 { margin-top: 0; color: #333; }
        label { display: block; margin-bottom: 8px; font-weight: 500; }
        input, select { 
          width: 100%; 
          padding: 12px; 
          border: 2px solid #ddd; 
          border-radius: 6px; 
          font-size: 14px;
          margin-bottom: 15px;
        }
        input:focus, select:focus { outline: none; border-color: #0052cc; }
        .checkbox-group { margin-bottom: 20px; }
        .checkbox-group input[type="checkbox"] { width: auto; margin-right: 8px; }
        .buttons { display: flex; gap: 10px; justify-content: flex-end; }
        button {
          padding: 10px 20px;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          cursor: pointer;
        }
        .primary { background: #0052cc; color: white; }
        .primary:hover { background: #0747a6; }
        .secondary { background: #f4f5f7; color: #333; }
        .secondary:hover { background: #e4e5ea; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🚀 Open New Atlassian Window</h2>
        <label for="url">Enter Atlassian URL:</label>
        <input type="url" id="url" placeholder="https://your-company.atlassian.net/jira" autofocus>
        <label for="product">Product Type:</label>
        <select id="product">
          <option value="auto">Auto-detect</option>
          <option value="jira">Jira</option>
          <option value="confluence">Confluence</option>
          <option value="bitbucket">Bitbucket</option>
          <option value="trello">Trello</option>
        </select>
        <div class="checkbox-group">
          <label>
            <input type="checkbox" id="background"> Open in background
          </label>
        </div>
        <div class="buttons">
          <button class="secondary" onclick="window.close()">Cancel</button>
          <button class="primary" onclick="openWindow()">Open Window</button>
        </div>
      </div>
      <script>
        function openWindow() {
          const url = document.getElementById('url').value.trim();
          const product = document.getElementById('product').value;
          const background = document.getElementById('background').checked;
          
          if (url) {
            require('electron').ipcRenderer.send('open-new-window', { url, product, background });
            window.close();
          }
        }
        
        document.getElementById('url').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') openWindow();
          if (e.key === 'Escape') window.close();
        });
      </script>
    </body>
    </html>`

    promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml)}`)
    
    // Handle new window creation
    ipcMain.once('open-new-window', async (_, { url, product, background }) => {
      let normalizedUrl = url
      
      // Normalize URL
      if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
        normalizedUrl = 'https://' + normalizedUrl
      }
      
      // Identify product if auto-detect, otherwise lookup by ID
      const detectedProduct = product === 'auto' 
        ? this.windowManager.identifyProduct(normalizedUrl)
        : this.windowManager.getProductById(product)
      
      if (detectedProduct) {
        await this.windowManager.createWindow({
          url: normalizedUrl,
          product: detectedProduct,
          focused: !background
        })
      }
      
      promptWindow.close()
    })
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

  private showUpdateErrorDialog(errorMessage: string): void {
    dialog.showMessageBox(this.mainWindow!, {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Unable to check for updates',
      detail: 'There was a problem checking for updates. Please check your internet connection and try again later.',
      buttons: ['OK']
    })
  }
}

// Initialize the app
new JiraApp()