import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({
  userData: '',
  workAreas: [] as { x: number; y: number; width: number; height: number }[]
}))

// Minimal BrowserWindow: records constructor options and lets a test fire window events
const fake = vi.hoisted(() => ({
  created: [] as { options: Record<string, unknown>; emit: (name: string) => void; maximized: () => number }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  screen: { getAllDisplays: () => env.workAreas.map((workArea) => ({ workArea })) },
  BrowserWindow: class {
    private listeners = new Map<string, (() => void)[]>()
    private bounds: { x: number; y: number; width: number; height: number }
    private maximizeCalls = 0
    webContents = { getURL: () => 'https://acme.atlassian.net/wiki/spaces/ENG' }
    constructor(options: Record<string, unknown>) {
      this.bounds = { x: 1, y: 2, width: 1000, height: 700 }
      fake.created.push({
        options,
        emit: (name) => {
          if (name === 'moved') this.bounds = { x: 300, y: 200, width: 1000, height: 700 }
          for (const listener of this.listeners.get(name) ?? []) listener()
        },
        maximized: () => this.maximizeCalls
      })
    }
    on(name: string, listener: () => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      return this
    }
    loaded = false
    loadURL() {
      this.loaded = true
      return Promise.resolve()
    }
    show() {}
    showInactive() {}
    focus() {}
    maximize() { this.maximizeCalls++ }
    close() {}
    isDestroyed() { return false }
    isMaximized() { return false }
    isMinimized() { return false }
    getBounds() { return this.bounds }
  }
}))

import { WindowManager, sanitizeWindowStates } from '../../src/main/services/WindowManager'

const URL = 'https://acme.atlassian.net/wiki/spaces/ENG'
const statesFile = () => join(env.userData, 'window-states.json')

beforeEach(() => {
  env.userData = mkdtempSync(join(tmpdir(), 'jira-desktop-wm-'))
  env.workAreas = [{ x: 0, y: 0, width: 2560, height: 1440 }]
  fake.created.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(env.userData, { recursive: true, force: true })
})

describe('WindowManager window-state persistence', () => {
  it('uses saved bounds for a window created right after construction (no load race)', async () => {
    const manager = new WindowManager()
    const product = manager.identifyProduct(URL)!
    const id = `${product.id}-acme.atlassian.net/wiki/spaces/ENG/`
    writeFileSync(statesFile(), JSON.stringify({
      windowStates: [{ id, productId: product.id, url: URL, bounds: { x: 40, y: 50, width: 900, height: 650 }, isMaximized: false, isMinimized: false }]
    }))

    const fresh = new WindowManager()
    await fresh.createWindow({ url: URL, product })
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]!.options).toMatchObject({ x: 40, y: 50, width: 900, height: 650 })
  })

  it('flush writes a pending debounced window state immediately', async () => {
    vi.useFakeTimers()
    const manager = new WindowManager()
    const product = manager.identifyProduct(URL)!
    await manager.createWindow({ url: URL, product })
    fake.created[0]!.emit('moved')

    manager.flush()
    const saved = JSON.parse(readFileSync(statesFile(), 'utf-8'))
    expect(saved.windowStates).toHaveLength(1)
    expect(saved.windowStates[0].bounds).toEqual({ x: 300, y: 200, width: 1000, height: 700 })
  })
})

// window-states.json is outside the app's control and its entries reach the BrowserWindow constructor
// codex:run npm test -- tests/unit/WindowManager.test.ts
describe('WindowManager saved-state hardening', () => {
  const ID = 'confluence-acme.atlassian.net/wiki/spaces/ENG/'
  const FIXED_KEYS = ['backgroundColor', 'icon', 'minHeight', 'minWidth', 'show', 'title', 'webPreferences']
  const optionKeys = (): string[] => Object.keys(fake.created[0]!.options).sort()
  const entry = (fields: Record<string, unknown>) => ({ id: ID, productId: 'confluence', url: URL, isMaximized: false, isMinimized: false, ...fields })

  async function openWith(saved: unknown): Promise<void> {
    fake.created.length = 0
    writeFileSync(statesFile(), JSON.stringify({ windowStates: [saved] }))
    const manager = new WindowManager()
    expect(await manager.createWindow({ url: URL, product: manager.identifyProduct(URL)! })).not.toBeNull()
    expect(fake.created).toHaveLength(1)
  }

  it('passes only x/y/width/height from saved bounds, never other window options', async () => {
    await openWith(entry({
      bounds: {
        x: 40, y: 50, width: 900, height: 650,
        opacity: 0, alwaysOnTop: true, kiosk: true, closable: false, focusable: false, frame: false,
        parent: {}, webPreferences: { sandbox: false, nodeIntegration: true }
      },
      show: true,
      kiosk: true
    }))
    expect(optionKeys()).toEqual(['height', 'width', 'x', 'y', ...FIXED_KEYS].sort())
    expect(fake.created[0]!.options).toMatchObject({ x: 40, y: 50, width: 900, height: 650, show: false })
    expect(fake.created[0]!.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true })
  })

  it('fits saved bounds to the displays that exist now, and uses the default size when none shows them', async () => {
    // Partly off the bottom-right corner and too small: pulled fully onto the display, grown to the minimum
    await openWith(entry({ bounds: { x: 2400, y: 1300, width: 400, height: 300 } }))
    expect(fake.created[0]!.options).toMatchObject({ x: 2560 - 800, y: 1440 - 600, width: 800, height: 600 })

    // Saved on a monitor that is unplugged now: the product's default size, placed by the OS
    await openWith(entry({ bounds: { x: -40000, y: 40000, width: 900, height: 650 } }))
    expect(fake.created[0]!.options).toMatchObject({ width: 1200, height: 900 })
    expect(optionKeys()).toEqual(['height', 'width', ...FIXED_KEYS].sort())
  })

  it('ignores malformed entries: the window opens at the default size', async () => {
    for (const saved of [
      entry({ bounds: { x: '40', y: 50, width: 900, height: 650 } }),
      entry({ bounds: { x: 40, y: 50, width: 900 } }),
      entry({ bounds: null }),
      entry({ id: 7, bounds: { x: 40, y: 50, width: 900, height: 650 } }),
      'not an entry'
    ]) {
      await openWith(saved)
      expect(optionKeys(), JSON.stringify(saved)).toEqual(['height', 'width', ...FIXED_KEYS].sort())
    }
  })

  it('maximizes only for a saved isMaximized of exactly true', async () => {
    for (const [isMaximized, calls] of [[true, 1], ['true', 0], [1, 0], [false, 0]] as const) {
      await openWith(entry({ bounds: { x: 40, y: 50, width: 900, height: 650 }, isMaximized }))
      expect(fake.created[0]!.maximized(), JSON.stringify(isMaximized)).toBe(calls)
    }
  })
})

// codex:run npm test -- tests/unit/WindowManager.test.ts
describe('sanitizeWindowStates', () => {
  const good = { id: 'a', productId: 'jira', bounds: { x: 0, y: 0, width: 900, height: 700 } }

  it('rebuilds each entry from its known fields only, keeping unknown top-level fields', () => {
    const raw = JSON.parse('{"windowStates":[{"id":"a","productId":"jira","url":"https://x.atlassian.net/","bounds":{"x":1,"y":2,"width":900,"height":700,"kiosk":true},"isMaximized":true,"isMinimized":false,"__proto__":{"polluted":true},"extra":1}],"future":{"kept":true}}')
    const file = sanitizeWindowStates(raw)
    expect(file.windowStates).toEqual([
      { id: 'a', productId: 'jira', url: 'https://x.atlassian.net/', bounds: { x: 1, y: 2, width: 900, height: 700 }, isMaximized: true, isMinimized: false }
    ])
    expect(Object.keys(file.windowStates![0]!)).toEqual(['id', 'productId', 'url', 'bounds', 'isMaximized', 'isMinimized'])
    expect(Object.keys(file.windowStates![0]!.bounds)).toEqual(['x', 'y', 'width', 'height'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((file as Record<string, unknown>).future).toEqual({ kept: true })
  })

  it('drops entries without a string id/productId or with non-finite bounds, and a list that is not an array', () => {
    const file = sanitizeWindowStates({
      windowStates: [
        good,
        { ...good, id: 7 },
        { ...good, productId: null },
        { ...good, bounds: { x: 0, y: 0, width: 900, height: 'tall' } },
        { ...good, bounds: { x: 0, y: 0, width: 900, height: null } },
        null,
        []
      ]
    })
    expect(file.windowStates).toEqual([{ ...good, url: '', isMaximized: false, isMinimized: false }])
    expect(sanitizeWindowStates({ windowStates: { 0: good } })).toEqual({})
  })
})

describe('WindowManager onWindowCreated', () => {
  it('hands each new window to the hook before it loads anything', async () => {
    const seen: { loaded: boolean }[] = []
    const manager = new WindowManager((window) => seen.push({ loaded: (window as unknown as { loaded: boolean }).loaded }))
    const created = await manager.createWindow({ url: URL, product: manager.identifyProduct(URL)! })
    expect(seen).toEqual([{ loaded: false }])
    expect((created as unknown as { loaded: boolean }).loaded).toBe(true)
  })

  it('is optional', async () => {
    const manager = new WindowManager()
    expect(await manager.createWindow({ url: URL, product: manager.identifyProduct(URL)! })).not.toBeNull()
  })
})

describe('WindowManager icons', () => {
  it('asks the icon resolver for the product icon', async () => {
    const asked: string[] = []
    const manager = new WindowManager(undefined, (file) => {
      asked.push(file)
      return `/resolved/${file}`
    })
    await manager.createWindow({ url: URL, product: manager.identifyProduct(URL)! })
    expect(asked).toEqual(['confluence-icon.png'])
    expect(fake.created[0]!.options.icon).toBe('/resolved/confluence-icon.png')
  })

  it('leaves the icon to Electron without a resolver', async () => {
    const manager = new WindowManager()
    await manager.createWindow({ url: URL, product: manager.identifyProduct(URL)! })
    expect(fake.created[0]!.options.icon).toBeUndefined()
  })
})
