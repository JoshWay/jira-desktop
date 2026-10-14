import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { StorageService } from './StorageService'
import type { StorageData } from './StorageService'
import { fitBoundsToDisplays } from './windowBounds'
import { hostMatches } from '../security/urlPolicy'

// Every window's floor; saved bounds smaller than this grow to it when restored
const MIN_WINDOW_SIZE = Object.freeze({ width: 800, height: 600 })

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

// Shape of window-states.json
export interface WindowStatesFile {
  windowStates?: WindowState[]
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// One saved entry rebuilt from its known fields only, or null when it has no string id/productId
// or its bounds are not four finite numbers. Nothing else in the entry survives.
function sanitizeWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, productId, url, bounds, isMaximized, isMinimized } = raw as Record<string, unknown>
  if (typeof id !== 'string' || typeof productId !== 'string') return null
  if (typeof bounds !== 'object' || bounds === null) return null
  const { x, y, width, height } = bounds as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  return {
    id,
    productId,
    url: typeof url === 'string' ? url : '',
    bounds: { x, y, width, height },
    isMaximized: isMaximized === true,
    isMinimized: isMinimized === true
  }
}

// window-states.json is outside the app's control: its entries reach the BrowserWindow
// constructor, so only well-formed ones are kept, each rebuilt from its known fields. Unknown
// top-level fields are kept, as in settings.json.
// codex:run npm test -- tests/unit/WindowManager.test.ts
export function sanitizeWindowStates(raw: StorageData): WindowStatesFile {
  const file: StorageData = { ...raw }
  if (Array.isArray(raw.windowStates)) {
    file.windowStates = raw.windowStates.map(sanitizeWindowState).filter((state) => state !== null)
  } else {
    delete file.windowStates
  }
  return file as WindowStatesFile
}

export class WindowManager {
  private windows: Map<string, BrowserWindow> = new Map()
  private windowStates: Map<string, WindowState> = new Map()
  private storage: StorageService<WindowStatesFile>
  private saveStateTimeout: NodeJS.Timeout | null = null
  // Called with each window right after it is constructed, before it loads anything
  private readonly onWindowCreated?: (window: BrowserWindow) => void

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

  // onWindowCreated: lets main make every window it creates a content window (navigation, find)
  // codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
  constructor(onWindowCreated?: (window: BrowserWindow) => void) {
    this.onWindowCreated = onWindowCreated
    // StorageService loads synchronously, so saved states are available here (spec R3)
    // codex:run npm test -- tests/unit/WindowManager.test.ts
    this.storage = new StorageService<WindowStatesFile>('window-states.json', { sanitize: sanitizeWindowStates })
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
      // codex:run npm run test:e2e -- tests/e2e/security.spec.ts
      if (hostMatches(hostname, 'atlassian.net') || hostMatches(hostname, 'atlassian.com')) {
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

      // Saved bounds only while they are on a display that still exists, pulled fully onto it, and
      // only their four numbers: never the stored object itself (spec R3)
      // codex:run npm test -- tests/unit/WindowManager.test.ts
      const savedState = this.windowStates.get(windowId)
      const fitted = savedState
        ? fitBoundsToDisplays(savedState.bounds, screen.getAllDisplays().map((display) => display.workArea), MIN_WINDOW_SIZE)
        : null
      const placement = fitted
        ? { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height }
        : {
            width: config.size?.width || config.product.defaultSize.width,
            height: config.size?.height || config.product.defaultSize.height
          }

      const window = new BrowserWindow({
        ...placement,
        minWidth: MIN_WINDOW_SIZE.width,
        minHeight: MIN_WINDOW_SIZE.height,
        show: false,
        title: config.title || `${config.product.name} - Jira Desktop`,
        icon: this.getProductIcon(config.product),
        backgroundColor: config.product.backgroundColor,
        // Default session (shares the main window's login); remote content gets no preload (spec R2).
        // Navigation is governed globally by security/webContentsPolicy.
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          allowRunningInsecureContent: false
        }
      })

      // codex:run npm test -- tests/unit/WindowManager.test.ts
      this.onWindowCreated?.(window)

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
      if (savedState?.isMaximized === true) {
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

  // Writes pending window states to disk now; the quit path calls it
  // codex:run npm test -- tests/unit/WindowManager.test.ts
  public flush(): void {
    if (this.saveStateTimeout) {
      clearTimeout(this.saveStateTimeout)
      this.saveStateTimeout = null
      this.saveWindowStates()
    }
    this.storage.flush()
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

  private loadWindowStates(): void {
    try {
      const states = this.storage.get('windowStates', [])
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