import { BrowserWindow, Menu, MenuItem, ipcMain } from 'electron'
import { WindowManager, WindowConfig } from './WindowManager'

export interface ContextMenuParams {
  x: number
  y: number
  linkURL: string
  linkText: string
  pageURL: string
  isEditable: boolean
  selectionText: string
}

export class ContextMenuService {
  private windowManager: WindowManager

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager
    this.setupContextMenuHandlers()
  }

  private setupContextMenuHandlers(): void {
    // Handle context menu events from webContents
    ipcMain.handle('show-context-menu', async (event, params: ContextMenuParams) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender)
      if (!sourceWindow) return

      await this.showContextMenu(sourceWindow, params)
    })
  }

  public setupForWindow(window: BrowserWindow): void {
    window.webContents.on('context-menu', (event, params) => {
      // Prevent default context menu
      event.preventDefault()
      
      const contextParams: ContextMenuParams = {
        x: params.x,
        y: params.y,
        linkURL: params.linkURL || '',
        linkText: params.linkText || '',
        pageURL: params.pageURL,
        isEditable: params.isEditable,
        selectionText: params.selectionText || ''
      }

      this.showContextMenu(window, contextParams)
    })
  }

  private async showContextMenu(window: BrowserWindow, params: ContextMenuParams): Promise<void> {
    const menuItems: MenuItem[] = []

    // Standard context menu items
    if (params.selectionText) {
      menuItems.push(
        new MenuItem({
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          click: () => {
            window.webContents.copy()
          }
        })
      )
    }

    if (params.isEditable) {
      if (params.selectionText) {
        menuItems.push(
          new MenuItem({
            label: 'Cut',
            accelerator: 'CmdOrCtrl+X',
            click: () => {
              window.webContents.cut()
            }
          })
        )
      }
      
      menuItems.push(
        new MenuItem({
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          click: () => {
            window.webContents.paste()
          }
        })
      )
    }

    // Add separator if we have standard items and will add Atlassian items
    if (menuItems.length > 0 && params.linkURL && this.isAtlassianLink(params.linkURL)) {
      menuItems.push(new MenuItem({ type: 'separator' }))
    }

    // Atlassian-specific menu items
    if (params.linkURL && this.isAtlassianLink(params.linkURL)) {
      const product = this.windowManager.identifyProduct(params.linkURL)
      const productName = product ? product.name : 'Atlassian'

      menuItems.push(
        new MenuItem({
          label: `Open ${productName} in New Window`,
          icon: product ? this.getProductIconPath(product.icon) : undefined,
          click: async () => {
            await this.openInNewWindow(params.linkURL, product, false)
          }
        })
      )

      menuItems.push(
        new MenuItem({
          label: `Open ${productName} in Background`,
          click: async () => {
            await this.openInNewWindow(params.linkURL, product, true)
          }
        })
      )
    }

    // Browser navigation items
    if (menuItems.length > 0) {
      menuItems.push(new MenuItem({ type: 'separator' }))
    }

    menuItems.push(
      new MenuItem({
        label: 'Back',
        accelerator: 'Alt+Left',
        enabled: window.webContents.canGoBack(),
        click: () => {
          window.webContents.goBack()
        }
      })
    )

    menuItems.push(
      new MenuItem({
        label: 'Forward',
        accelerator: 'Alt+Right',
        enabled: window.webContents.canGoForward(),
        click: () => {
          window.webContents.goForward()
        }
      })
    )

    menuItems.push(
      new MenuItem({
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          window.webContents.reload()
        }
      })
    )

    // Developer tools (only in development)
    if (process.env.NODE_ENV === 'development') {
      menuItems.push(new MenuItem({ type: 'separator' }))
      menuItems.push(
        new MenuItem({
          label: 'Inspect Element',
          click: () => {
            window.webContents.inspectElement(params.x, params.y)
          }
        })
      )
    }

    // Create and show menu
    if (menuItems.length > 0) {
      const contextMenu = Menu.buildFromTemplate(menuItems.map(item => item))
      contextMenu.popup({
        window,
        x: params.x,
        y: params.y,
        callback: () => {
          // Menu dismissed
        }
      })
    }
  }

  private async openInNewWindow(url: string, product: any, background: boolean): Promise<void> {
    try {
      const config: WindowConfig = {
        url,
        product: product || {
          id: 'atlassian',
          name: 'Atlassian',
          domains: [],
          icon: 'icon.png',
          defaultSize: { width: 1200, height: 900 },
          backgroundColor: '#172B4D'
        },
        focused: !background
      }

      const newWindow = await this.windowManager.createWindow(config)
      
      if (newWindow) {
        // Emit telemetry event
        this.emitTelemetryEvent('window_spawned', {
          product: product?.id || 'unknown',
          url: new URL(url).hostname,
          background,
          windowCount: this.windowManager.getWindowCount()
        })
      } else {
        throw new Error('Failed to create window')
      }
    } catch (error) {
      console.error('Failed to open in new window:', error)
      
      // Emit error telemetry
      this.emitTelemetryEvent('window_spawn_failed', {
        product: product?.id || 'unknown',
        url: new URL(url).hostname,
        error: error.message
      })
    }
  }

  private isAtlassianLink(url: string): boolean {
    try {
      const parsedUrl = new URL(url)
      const hostname = parsedUrl.hostname.toLowerCase()
      
      return (
        hostname.includes('atlassian.net') ||
        hostname.includes('atlassian.com') ||
        hostname.includes('bitbucket.org') ||
        hostname.includes('trello.com') ||
        hostname === 'id.atlassian.com'
      )
    } catch {
      return false
    }
  }

  private getProductIconPath(iconName: string): string {
    // Return path to product icon for menu display
    // Note: Electron menu icons are limited, so this might not always work
    return ''
  }

  private emitTelemetryEvent(eventName: string, data: any): void {
    // TODO: Implement telemetry emission
    console.log(`Telemetry: ${eventName}`, data)
  }
}