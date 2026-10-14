import { beforeEach, describe, expect, it, vi } from 'vitest'

// Captures every menu ContextMenuService builds; popup is a no-op
const built = vi.hoisted(() => [] as { label?: string; type?: string }[][])

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (items: { label?: string; type?: string }[]) => {
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
import type { WindowManager } from '../../src/main/services/WindowManager'

const windowManager = { identifyProduct: () => null } as unknown as WindowManager

function rightClick(service: ContextMenuService, linkURL: string): string[] {
  let handler: ((event: { preventDefault(): void }, params: Record<string, unknown>) => void) | undefined
  const window = {
    webContents: {
      on: (name: string, listener: typeof handler) => { if (name === 'context-menu') handler = listener },
      canGoBack: () => false,
      canGoForward: () => false
    }
  }
  service.setupForWindow(window as unknown as Electron.BrowserWindow)
  handler!({ preventDefault: () => {} }, { x: 0, y: 0, linkURL, linkText: '', pageURL: 'https://x.test/', isEditable: false, selectionText: '' })
  return built.at(-1)!.map((item) => item.label ?? `(${item.type})`)
}

const NEW_WINDOW = 'Open Atlassian in New Window'

describe('ContextMenuService link items', () => {
  beforeEach(() => { built.length = 0 })

  it('offers a new window for Atlassian links', () => {
    expect(rightClick(new ContextMenuService(windowManager, () => undefined), 'https://team.atlassian.net/browse/X-1')).toContain(NEW_WINDOW)
  })

  it('offers a new window for links on the configured self-hosted site', () => {
    const service = new ContextMenuService(windowManager, () => 'https://jira.corp.test/')
    expect(rightClick(service, 'https://jira.corp.test/browse/X-1')).toContain(NEW_WINDOW)
  })

  it('reads the configured site at click time', () => {
    let site: string | undefined
    const service = new ContextMenuService(windowManager, () => site)
    expect(rightClick(service, 'https://jira.corp.test/browse/X-1')).not.toContain(NEW_WINDOW)
    site = 'https://jira.corp.test/'
    expect(rightClick(service, 'https://jira.corp.test/browse/X-1')).toContain(NEW_WINDOW)
  })

  it('offers nothing for look-alikes, other hosts or plaintext Atlassian links', () => {
    const service = new ContextMenuService(windowManager, () => 'https://jira.corp.test/')
    for (const url of ['https://atlassian.net.evil.test/', 'https://evil.test/', 'http://team.atlassian.net/', 'http://jira.corp.test/', 'smb://x/y']) {
      expect(rightClick(service, url)).not.toContain(NEW_WINDOW)
    }
  })
})
