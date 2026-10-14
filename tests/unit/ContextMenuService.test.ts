import { beforeEach, describe, expect, it, vi } from 'vitest'

interface BuiltItem { label?: string; type?: string; enabled?: boolean; accelerator?: string; click?: () => void }

// Captures every menu ContextMenuService builds; popup is a no-op
const built = vi.hoisted(() => [] as BuiltItem[][])

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (items: BuiltItem[]) => {
      built.push(items)
      return { popup: () => {} }
    }
  },
  MenuItem: class {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options)
    }
  },
  BrowserWindow: class {}
}))

import { ContextMenuService } from '../../src/main/services/ContextMenuService'
import type { ContextMenuNavigation } from '../../src/main/services/ContextMenuService'
import type { WindowManager } from '../../src/main/services/WindowManager'
import { navigationAccelerators } from '../../src/main/navigation/navigationRules'

const windowManager = { identifyProduct: () => null } as unknown as WindowManager
const noNavigation: ContextMenuNavigation = { canGo: () => false, go: () => {} }

type Handler = (event: { preventDefault(): void }, params: Record<string, unknown>) => void

// A main-window stand-in whose raw history calls fail the test if the menu ever uses them
function fakeWindow(): { window: Electron.BrowserWindow; open(linkURL?: string): BuiltItem[] } {
  let handler: Handler | undefined
  const raw = (): never => { throw new Error('raw webContents history call') }
  const window = {
    webContents: {
      on: (name: string, listener: Handler) => { if (name === 'context-menu') handler = listener },
      canGoBack: raw,
      canGoForward: raw,
      goBack: raw,
      goForward: raw
    }
  } as unknown as Electron.BrowserWindow
  return {
    window,
    open(linkURL = '') {
      handler!({ preventDefault: () => {} }, { x: 0, y: 0, linkURL, linkText: '', pageURL: 'https://x.test/', isEditable: false, selectionText: '' })
      return built.at(-1)!
    }
  }
}

function rightClick(service: ContextMenuService, linkURL: string): string[] {
  const fake = fakeWindow()
  service.setupForWindow(fake.window)
  return fake.open(linkURL).map((item) => item.label ?? `(${item.type})`)
}

const NEW_WINDOW = 'Open Atlassian in New Window'

describe('ContextMenuService link items', () => {
  beforeEach(() => { built.length = 0 })

  it('offers a new window for Atlassian links', () => {
    expect(rightClick(new ContextMenuService(windowManager, () => undefined, noNavigation), 'https://team.atlassian.net/browse/X-1')).toContain(NEW_WINDOW)
  })

  it('offers a new window for links on the configured self-hosted site', () => {
    const service = new ContextMenuService(windowManager, () => 'https://jira.corp.test/', noNavigation)
    expect(rightClick(service, 'https://jira.corp.test/browse/X-1')).toContain(NEW_WINDOW)
  })

  it('reads the configured site at click time', () => {
    let site: string | undefined
    const service = new ContextMenuService(windowManager, () => site, noNavigation)
    expect(rightClick(service, 'https://jira.corp.test/browse/X-1')).not.toContain(NEW_WINDOW)
    site = 'https://jira.corp.test/'
    expect(rightClick(service, 'https://jira.corp.test/browse/X-1')).toContain(NEW_WINDOW)
  })

  it('offers nothing for look-alikes, other hosts or plaintext Atlassian links', () => {
    const service = new ContextMenuService(windowManager, () => 'https://jira.corp.test/', noNavigation)
    for (const url of ['https://atlassian.net.evil.test/', 'https://evil.test/', 'http://team.atlassian.net/', 'http://jira.corp.test/', 'smb://x/y']) {
      expect(rightClick(service, url)).not.toContain(NEW_WINDOW)
    }
  })
})

// codex:run npm test -- tests/unit/ContextMenuService.test.ts
describe('ContextMenuService Back / Forward', () => {
  beforeEach(() => { built.length = 0 })

  it('takes enablement and the move from the navigation controller, never the raw history', () => {
    const calls: [unknown, number][] = []
    let movable: Record<number, boolean> = { [-1]: false, [1]: true }
    const navigation: ContextMenuNavigation = {
      canGo: (win, step) => { calls.push([win, step]); return movable[step] },
      go: (win, step) => { calls.push([win, step * 10]) }
    }
    const fake = fakeWindow()
    new ContextMenuService(windowManager, () => undefined, navigation).setupForWindow(fake.window)

    const item = (items: BuiltItem[], label: string): BuiltItem => items.find((i) => i.label === label)!
    let items = fake.open()
    expect([item(items, 'Back').enabled, item(items, 'Forward').enabled]).toEqual([false, true])
    item(items, 'Back').click!()
    item(items, 'Forward').click!()
    expect(calls).toEqual([[fake.window, -1], [fake.window, 1], [fake.window, -10], [fake.window, 10]])

    // Read on every right-click
    movable = { [-1]: true, [1]: false }
    items = fake.open()
    expect([item(items, 'Back').enabled, item(items, 'Forward').enabled]).toEqual([true, false])
  })

  it('shows the Go menu accelerators for the platform', () => {
    const fake = fakeWindow()
    new ContextMenuService(windowManager, () => undefined, noNavigation).setupForWindow(fake.window)
    const items = fake.open()
    const expected = navigationAccelerators(process.platform)
    expect(items.find((i) => i.label === 'Back')!.accelerator).toBe(expected.back)
    expect(items.find((i) => i.label === 'Forward')!.accelerator).toBe(expected.forward)
  })
})
