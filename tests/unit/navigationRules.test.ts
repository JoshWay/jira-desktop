import { describe, expect, it } from 'vitest'
import { historyTarget, navigationAccelerators, navigationCommand, shareableUrl } from '../../src/main/navigation/navigationRules'

const PLACEHOLDER = 'file:///app/dist/renderer/placeholder.html'
const isLocalPage = (url: string): boolean => url.startsWith('file:///app/dist/renderer/')
const rules = { isLocalPage, isAllowed: () => true }

describe('historyTarget', () => {
  const site = ['https://team.atlassian.net/jira', 'https://team.atlassian.net/browse/X-1', 'https://team.atlassian.net/browse/X-2']

  it('steps one entry back or forward', () => {
    expect(historyTarget(site, 2, -1, rules)).toBe(1)
    expect(historyTarget(site, 1, -1, rules)).toBe(0)
    expect(historyTarget(site, 0, 1, rules)).toBe(1)
    expect(historyTarget(site, 1, 1, rules)).toBe(2)
  })

  it('has nowhere to go at either end, or with no history', () => {
    expect(historyTarget(site, 0, -1, rules)).toBeNull()
    expect(historyTarget(site, 2, 1, rules)).toBeNull()
    expect(historyTarget([], -1, -1, rules)).toBeNull()
    expect(historyTarget([], -1, 1, rules)).toBeNull()
  })

  it('never lands on a local page or about:blank (the placeholder and the step main takes off it)', () => {
    // Main window after first-run setup: placeholder -> about:blank -> the site
    const firstRun = [PLACEHOLDER, 'about:blank', 'https://acme.atlassian.net/jira']
    expect(historyTarget(firstRun, 2, -1, rules)).toBeNull()
    expect(historyTarget(firstRun, 0, 1, rules)).toBe(2)
    // Skips them in between too
    const mixed = ['https://a.atlassian.net/1', 'about:blank', PLACEHOLDER, 'https://a.atlassian.net/2']
    expect(historyTarget(mixed, 3, -1, rules)).toBe(0)
    expect(historyTarget(mixed, 0, 1, rules)).toBe(3)
  })

  it('only ever lands on http(s) entries', () => {
    const odd = ['data:text/html,x', 'chrome-error://chromewebdata/', 'javascript:1', '', 'not a url', 'https://a.atlassian.net/ok', 'blob:https://a.atlassian.net/1']
    expect(historyTarget(odd, 6, -1, rules)).toBe(5)
    expect(historyTarget(odd, 5, -1, rules)).toBeNull()
    expect(historyTarget(odd, 0, 1, rules)).toBe(5)
    expect(historyTarget(odd, 5, 1, rules)).toBeNull()
  })

  it('skips entries the navigation policy no longer allows in the window', () => {
    // The site was changed from a self-hosted one: its pages are external now
    const entries = ['https://jira.corp.test/', 'https://jira.corp.test/browse/X-1', 'https://acme.atlassian.net/jira', 'https://acme.atlassian.net/browse/A-1']
    const isAllowed = (url: string): boolean => new URL(url).hostname.endsWith('.atlassian.net')
    expect(historyTarget(entries, 3, -1, { isLocalPage, isAllowed })).toBe(2)
    expect(historyTarget(entries, 2, -1, { isLocalPage, isAllowed })).toBeNull()
    expect(historyTarget(entries, 0, 1, { isLocalPage, isAllowed })).toBe(2)
  })

  it('refuses an active index outside the entries', () => {
    expect(historyTarget(site, 7, -1, rules)).toBeNull()
    expect(historyTarget(site, -3, 1, rules)).toBeNull()
    expect(historyTarget(site, 1.5, 1, rules)).toBeNull()
  })
})

describe('shareableUrl', () => {
  it('returns an http(s) page address as its parsed href', () => {
    expect(shareableUrl('https://team.atlassian.net/browse/X-1?focused=1#c', isLocalPage)).toBe('https://team.atlassian.net/browse/X-1?focused=1#c')
    expect(shareableUrl('http://jira.corp.test:8080/', isLocalPage)).toBe('http://jira.corp.test:8080/')
  })

  it('has nothing to share for local pages and non-web schemes', () => {
    for (const url of [PLACEHOLDER, 'about:blank', '', 'data:text/html,<p>x', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome-error://chromewebdata/', 'mailto:a@b.test', 'smb://x/y', 'blob:https://a.atlassian.net/1']) {
      expect(shareableUrl(url, isLocalPage), url).toBeNull()
    }
  })

  it('treats a dev-server local page as local, not shareable', () => {
    const isDevLocal = (url: string): boolean => url.startsWith('http://localhost:5173/')
    expect(shareableUrl('http://localhost:5173/dialog.html', isDevLocal)).toBeNull()
  })
})

describe('navigationAccelerators', () => {
  it('uses Cmd+[ / Cmd+] on macOS and Alt+Left / Alt+Right elsewhere', () => {
    expect(navigationAccelerators('darwin')).toEqual({ back: 'CmdOrCtrl+[', forward: 'CmdOrCtrl+]' })
    expect(navigationAccelerators('win32')).toEqual({ back: 'Alt+Left', forward: 'Alt+Right' })
    expect(navigationAccelerators('linux')).toEqual({ back: 'Alt+Left', forward: 'Alt+Right' })
  })
})

describe('navigationCommand', () => {
  it('maps macOS swipes and mouse/keyboard app-commands to back and forward', () => {
    expect(navigationCommand('swipe', 'left')).toBe('back')
    expect(navigationCommand('swipe', 'right')).toBe('forward')
    expect(navigationCommand('app-command', 'browser-backward')).toBe('back')
    expect(navigationCommand('app-command', 'browser-forward')).toBe('forward')
  })

  it('ignores everything else', () => {
    expect(navigationCommand('swipe', 'up')).toBeNull()
    expect(navigationCommand('swipe', 'down')).toBeNull()
    expect(navigationCommand('app-command', 'browser-refresh')).toBeNull()
    expect(navigationCommand('app-command', 'left')).toBeNull()
    expect(navigationCommand('swipe', 'browser-backward')).toBeNull()
  })
})
