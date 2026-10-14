import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ userData: '' }))

// Minimal BrowserWindow: records constructor options and lets a test fire window events
const fake = vi.hoisted(() => ({
  created: [] as { options: Record<string, unknown>; emit: (name: string) => void }[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  BrowserWindow: class {
    private listeners = new Map<string, (() => void)[]>()
    private bounds: { x: number; y: number; width: number; height: number }
    webContents = { getURL: () => 'https://acme.atlassian.net/wiki/spaces/ENG' }
    constructor(options: Record<string, unknown>) {
      this.bounds = { x: 1, y: 2, width: 1000, height: 700 }
      fake.created.push({
        options,
        emit: (name) => {
          if (name === 'moved') this.bounds = { x: 300, y: 200, width: 1000, height: 700 }
          for (const listener of this.listeners.get(name) ?? []) listener()
        }
      })
    }
    on(name: string, listener: () => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      return this
    }
    loadURL() { return Promise.resolve() }
    show() {}
    showInactive() {}
    focus() {}
    maximize() {}
    close() {}
    isDestroyed() { return false }
    isMaximized() { return false }
    isMinimized() { return false }
    getBounds() { return this.bounds }
  }
}))

import { WindowManager } from '../../src/main/services/WindowManager'

const URL = 'https://acme.atlassian.net/wiki/spaces/ENG'
const statesFile = () => join(env.userData, 'window-states.json')

beforeEach(() => {
  env.userData = mkdtempSync(join(tmpdir(), 'jira-desktop-wm-'))
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
