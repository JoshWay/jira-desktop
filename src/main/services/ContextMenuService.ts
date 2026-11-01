import { BrowserWindow, Menu, MenuItem } from 'electron'
import { WindowManager, WindowConfig } from './WindowManager'
import { isInAppUrl } from '../security/urlPolicy'
import { navigationAccelerators } from '../navigation/navigationRules'
import type { HistoryStep } from '../navigation/navigationRules'

export interface ContextMenuParams {
  x: number
  y: number
  linkURL: string
  linkText: string
  pageURL: string
  isEditable: boolean
  selectionText: string
}

// Back / Forward as NavigationController does them for the Go menu: the same history rules (never
// the placeholder or the about:blank step, re-checked against the policy) and the same way off a
// local page
export interface ContextMenuNavigation {
  canGo(win: BrowserWindow, step: HistoryStep): boolean
  go(win: BrowserWindow, step: HistoryStep): void
}

export class ContextMenuService {
  private windowManager: WindowManager
  private getConfiguredSiteUrl: () => string | undefined
  private navigation: ContextMenuNavigation

  // getConfiguredSiteUrl: the same getter the webContents policy uses, so the user's own site counts as in-app
  constructor(windowManager: WindowManager, getConfiguredSiteUrl: () => string | undefined, navigation: ContextMenuNavigation) {
    this.windowManager = windowManager
    this.getConfiguredSiteUrl = getConfiguredSiteUrl
    this.navigation = navigation
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
    // codex:run npm test -- tests/unit/ContextMenuService.test.ts
    const inAppLink = !!params.linkURL && isInAppUrl(params.linkURL, this.getConfiguredSiteUrl())
    if (menuItems.length > 0 && inAppLink) {
      menuItems.push(new MenuItem({ type: 'separator' }))
    }

    // Atlassian-specific menu items
    if (inAppLink) {
      const product = this.windowManager.identifyProduct(params.linkURL)
      const productName = product ? product.name : 'Atlassian'

      menuItems.push(
        new MenuItem({
          label: `Open ${productName} in New Window`,
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

    // Through the navigation controller, never webContents.goBack() / goForward(): those would
    // walk onto the placeholder and the about:blank step, and skip the policy re-check
    // codex:run npm test -- tests/unit/ContextMenuService.test.ts
    // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
    const accelerators = navigationAccelerators(process.platform)
    menuItems.push(
      new MenuItem({
        label: 'Back',
        accelerator: accelerators.back,
        enabled: this.navigation.canGo(window, -1),
        click: () => this.navigation.go(window, -1)
      })
    )

    menuItems.push(
      new MenuItem({
        label: 'Forward',
        accelerator: accelerators.forward,
        enabled: this.navigation.canGo(window, 1),
        click: () => this.navigation.go(window, 1)
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
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private emitTelemetryEvent(eventName: string, data: any): void {
    // TODO: Implement telemetry emission
    console.log(`Telemetry: ${eventName}`, data)
  }
}