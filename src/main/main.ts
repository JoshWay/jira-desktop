import { app, BrowserWindow, Menu, nativeTheme, ipcMain, shell, dialog } from 'electron'
import { join } from 'path'

class JiraApp {
  private mainWindow: BrowserWindow | null = null
  private jiraUrl: string = 'https://id.atlassian.com/login'

  constructor() {
    this.initializeApp()
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
        app.quit()
      }
    })

    // Handle external links
    app.on('web-contents-created', (_, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        if (url.includes('atlassian.net') || url.startsWith(this.jiraUrl)) {
          // Navigate in current window instead of opening new window
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.loadURL(url)
          }
          return { action: 'deny' }
        }
        shell.openExternal(url)
        return { action: 'deny' }
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

    // Load Jira directly
    this.loadJiraApp()
  }

  private loadJiraApp(): void {
    if (!this.mainWindow) return

    // Load Jira directly - just like the original Nativefier approach
    this.mainWindow.loadURL(this.jiraUrl)
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
}

// Initialize the app
new JiraApp()