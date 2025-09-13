import { BrowserWindow, Menu, MenuItem, nativeImage } from 'electron'
import { join } from 'path'
import { StorageService } from './StorageService'

export interface AtlassianProduct {
  id: string
  name: string
  domains: string[]
  icon: string
  defaultSize: { width: number; height: number }
  backgroundColor: string
}

export interface WindowConfig {
  url: string
  product: AtlassianProduct
  title?: string
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  focused?: boolean
}

export interface WindowState {
  id: string
  productId: string
  url: string
  bounds: { x: number; y: number; width: number; height: number }
  isMaximized: boolean
  isMinimized: boolean
}

export class WindowManager {
  private windows: Map<string, BrowserWindow> = new Map()
  private windowStates: Map<string, WindowState> = new Map()
  private sessionPartition: string = 'persist:atlassian-shared'
  private storage: StorageService
  private saveStateTimeout: NodeJS.Timeout | null = null

  private readonly products: Map<string, AtlassianProduct> = new Map([
    ['jira', {
      id: 'jira',
      name: 'Jira',
      domains: ['*.atlassian.net/jira', '*.atlassian.net/secure'],
      icon: 'jira-icon.png',
      defaultSize: { width: 1200, height: 900 },
      backgroundColor: '#0052CC'
    }],
    ['confluence', {
      id: 'confluence',
      name: 'Confluence',
      domains: ['*.atlassian.net/wiki'],
      icon: 'confluence-icon.png',
      defaultSize: { width: 1200, height: 900 },
      backgroundColor: '#172B4D'
    }],
    ['bitbucket', {
      id: 'bitbucket',
      name: 'Bitbucket',
      domains: ['bitbucket.org', '*.atlassian.net/bitbucket'],
      icon: 'bitbucket-icon.png',
      defaultSize: { width: 1400, height: 1000 },
      backgroundColor: '#0052CC'
    }],
    ['trello', {
      id: 'trello',
      name: 'Trello',
      domains: ['trello.com'],
      icon: 'trello-icon.png',
      defaultSize: { width: 1300, height: 900 },
      backgroundColor: '#026AA7'
    }],
    ['teams', {
      id: 'teams',
      name: 'Atlassian Teams',
      domains: ['*.atlassian.net/people', 'teams.atlassian.com'],
      icon: 'teams-icon.png',
      defaultSize: { width: 1100, height: 800 },
      backgroundColor: '#172B4D'
    }],
    ['studio', {
      id: 'studio',
      name: 'Atlassian Studio',
      domains: ['*.atlassian.net/studio', 'studio.atlassian.com'],
      icon: 'studio-icon.png',
      defaultSize: { width: 1400, height: 1000 },
      backgroundColor: '#172B4D'
    }]
  ])

  constructor() {
    this.storage = new StorageService('window-states.json')
    this.loadWindowStates()
  }

  public getProductById(productId: string): AtlassianProduct | null {
    return this.products.get(productId) || null
  }

  public identifyProduct(url: string): AtlassianProduct | null {
    try {
      const parsedUrl = new URL(url)
      const hostname = parsedUrl.hostname.toLowerCase()
      const pathname = parsedUrl.pathname.toLowerCase()
      const fullUrl = `${hostname}${pathname}`

      for (const product of this.products.values()) {
        for (const domain of product.domains) {
          const pattern = domain.replace(/\*/g, '.*')
          const regex = new RegExp(pattern, 'i')
          if (regex.test(fullUrl)) {
            return product
          }
        }
      }

      // Fallback: if it's an Atlassian domain but no specific product match
      if (hostname.includes('atlassian.net') || hostname.includes('atlassian.com')) {
        return this.products.get('jira') || null
      }

      return null
    } catch {
      return null
    }
  }

  public async createWindow(config: WindowConfig): Promise<BrowserWindow | null> {
    try {
      const windowId = this.generateWindowId(config.product.id, config.url)
      
      // Check if window for this product/URL already exists
      if (this.windows.has(windowId)) {
        const existingWindow = this.windows.get(windowId)!
        if (!existingWindow.isDestroyed()) {
          existingWindow.focus()
          return existingWindow
        }
        this.windows.delete(windowId)
      }

      const savedState = this.windowStates.get(windowId)
      const bounds = savedState?.bounds || {
        x: undefined,
        y: undefined,
        width: config.size?.width || config.product.defaultSize.width,
        height: config.size?.height || config.product.defaultSize.height
      }

      const window = new BrowserWindow({
        ...bounds,
        minWidth: 800,
        minHeight: 600,
        show: false,
        title: config.title || `${config.product.name} - Jira Desktop`,
        icon: this.getProductIcon(config.product),
        backgroundColor: config.product.backgroundColor,
        webPreferences: {
          partition: this.sessionPartition,
          preload: join(__dirname, '../preload/preload.js'),
          sandbox: false,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          allowRunningInsecureContent: false
        }
      })

      // Setup window event handlers
      this.setupWindowEvents(window, windowId, config.product)
      
      // Register window
      this.windows.set(windowId, window)
      
      // Load URL
      await window.loadURL(config.url)
      
      // Show window
      if (config.focused !== false) {
        window.show()
        window.focus()
      } else {
        window.showInactive()
      }

      // Restore maximized state
      if (savedState?.isMaximized) {
        window.maximize()
      }

      return window
    } catch (error) {
      console.error('Failed to create window:', error)
      return null
    }
  }

  public getWindowCount(): number {
    return this.windows.size
  }

  public getAllWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).filter(w => !w.isDestroyed())
  }

  public closeAllWindows(): void {
    // Clear any pending save operations
    if (this.saveStateTimeout) {
      clearTimeout(this.saveStateTimeout)
      this.saveStateTimeout = null
    }
    
    // Save current states before closing
    this.saveWindowStates()
    
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.close()
      }
    }
    this.windows.clear()
  }

  private setupWindowEvents(window: BrowserWindow, windowId: string, product: AtlassianProduct): void {
    // Handle window closed
    window.on('closed', () => {
      this.windows.delete(windowId)
    })

    // Handle window state changes for persistence (with debouncing)
    const saveWindowState = () => {
      if (window.isDestroyed()) return
      
      const bounds = window.getBounds()
      const windowState: WindowState = {
        id: windowId,
        productId: product.id,
        url: window.webContents.getURL(),
        bounds,
        isMaximized: window.isMaximized(),
        isMinimized: window.isMinimized()
      }
      this.windowStates.set(windowId, windowState)
      this.debouncedSaveWindowStates()
    }

    window.on('resized', saveWindowState)
    window.on('moved', saveWindowState)
    window.on('maximize', saveWindowState)
    window.on('unmaximize', saveWindowState)

    // Handle ready to show
    window.on('ready-to-show', () => {
      window.show()
    })

    // Setup navigation handling specific to this window
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      // Allow navigation within Atlassian domains
      if (this.isAtlassianUrl(navigationUrl)) {
        return
      }
      
      // Prevent navigation to external sites
      event.preventDefault()
    })
  }

  private generateWindowId(productId: string, url: string): string {
    // Create a robust ID for the window based on productId, hostname, and up to 4 path segments
    try {
      const parsedUrl = new URL(url)
      const hostname = parsedUrl.hostname
      // Remove leading/trailing slashes and split path
      const pathSegments = parsedUrl.pathname.replace(/^\/+|\/+$/g, '').split('/')
      // Pad to 4 segments if needed
      while (pathSegments.length < 4) {
        pathSegments.push('')
      }
      const id = `${productId}-${hostname}/${pathSegments.slice(0, 4).join('/')}`
      return id
    } catch {
      // Fallback: use productId and a base64-encoded URL
      return `${productId}-${Buffer.from(url).toString('base64')}`
    }
  }

  private getProductIcon(product: AtlassianProduct): string {
    return join(__dirname, '../../resources', product.icon)
  }

  private isAtlassianUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url)
      const hostname = parsedUrl.hostname.toLowerCase()
      
      return (
        hostname.includes('atlassian.net') ||
        hostname.includes('atlassian.com') ||
        hostname.includes('bitbucket.org') ||
        hostname.includes('trello.com')
      )
    } catch {
      return false
    }
  }

  private loadWindowStates(): void {
    try {
      const states = this.storage.get<WindowState[]>('windowStates', [])
      this.windowStates.clear()
      
      for (const state of states) {
        this.windowStates.set(state.id, state)
      }
    } catch (error) {
      console.error('Failed to load window states:', error)
    }
  }

  private saveWindowStates(): void {
    try {
      const states = Array.from(this.windowStates.values())
      this.storage.set('windowStates', states)
    } catch (error) {
      console.error('Failed to save window states:', error)
    }
  }

  private debouncedSaveWindowStates(): void {
    // Clear existing timeout
    if (this.saveStateTimeout) {
      clearTimeout(this.saveStateTimeout)
    }
    
    // Set new timeout for 500ms debounce
    this.saveStateTimeout = setTimeout(() => {
      this.saveWindowStates()
      this.saveStateTimeout = null
    }, 500)
  }
}