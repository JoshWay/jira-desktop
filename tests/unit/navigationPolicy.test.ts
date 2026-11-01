import { describe, expect, it } from 'vitest'
import {
  ALLOWED_PERMISSIONS,
  LocalPageRegistry,
  decideNavigation,
  decideWindowOpen,
  hasPrivilegedPrefs,
  isConfinedContents,
  isExpectedLoadAbort,
  isPermissionAllowed,
  isSameLocalPage,
  localPageKey,
  toExternalHref
} from '../../src/main/security/navigationPolicy'
import type { ConfinementProbe, PolicyContext } from '../../src/main/security/navigationPolicy'

function ctx(local: string[] = [], siteUrl?: string): PolicyContext {
  const registry = new LocalPageRegistry()
  for (const url of local) registry.register(url)
  return { siteUrl, isLocalPage: (url) => registry.matches(url) }
}

describe('hasPrivilegedPrefs', () => {
  const plain = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false }
  it('is false for a plain sandboxed, isolated renderer (as Electron reports it)', () => {
    expect(hasPrivilegedPrefs(plain)).toBe(false)
    expect(hasPrivilegedPrefs({ ...plain, preload: '' })).toBe(false)
  })
  it('is true for every privilege-granting pref', () => {
    for (const extra of [
      { preload: '/x/preload.js' },
      { nodeIntegration: true },
      { nodeIntegrationInSubFrames: true },
      { nodeIntegrationInWorker: true },
      { webviewTag: true },
      { sandbox: false },
      { contextIsolation: false }
    ]) {
      expect(hasPrivilegedPrefs({ ...plain, ...extra }), JSON.stringify(extra)).toBe(true)
    }
  })
  it('fails closed when prefs are unknown', () => {
    expect(hasPrivilegedPrefs(null)).toBe(true)
    expect(hasPrivilegedPrefs(undefined)).toBe(true)
  })
})

describe('isExpectedLoadAbort', () => {
  it('is true only for ERR_ABORTED', () => {
    expect(isExpectedLoadAbort(Object.assign(new Error('ERR_ABORTED (-3) loading x'), { code: 'ERR_ABORTED', errno: -3 }))).toBe(true)
    expect(isExpectedLoadAbort(Object.assign(new Error('ERR_FAILED (-2) loading x'), { code: 'ERR_FAILED', errno: -2 }))).toBe(false)
    expect(isExpectedLoadAbort(new Error('ERR_ABORTED'))).toBe(false)
    expect(isExpectedLoadAbort(null)).toBe(false)
    expect(isExpectedLoadAbort(undefined)).toBe(false)
  })
})

describe('localPageKey', () => {
  it('uses the exact origin for http(s)', () => {
    expect(localPageKey('http://localhost:5173/dialog.html?mode=x#y')).toBe('http://localhost:5173')
    expect(localPageKey('https://LOCALHOST:5173/')).toBe('https://localhost:5173')
  })
  it('uses the exact path for file:, ignoring query and hash', () => {
    expect(localPageKey('file:///app/dist/renderer/dialog.html?mode=x#y')).toBe('file:///app/dist/renderer/dialog.html')
  })
  it('refuses schemes that cannot be a local page', () => {
    for (const url of ['data:text/html,x', 'about:blank', 'blob:https://x.atlassian.net/1', 'javascript:1', 'not a url', '']) {
      expect(localPageKey(url)).toBeNull()
    }
  })
  // Node's pathToFileURL keeps a lowercase drive letter; Chromium's committed URL uppercases it
  it('canonicalises a Windows drive letter to uppercase, and nothing else in the path', () => {
    expect(localPageKey('file:///c:/Program%20Files/Jira/resources/app.asar/dist/renderer/dialog.html')).toBe(
      'file:///C:/Program%20Files/Jira/resources/app.asar/dist/renderer/dialog.html'
    )
    expect(localPageKey('file:///c:/app/dialog.html')).toBe(localPageKey('file:///C:/app/dialog.html'))
    expect(localPageKey('file:///C:/App/dialog.html')).not.toBe(localPageKey('file:///C:/app/dialog.html'))
  })
})

describe('isConfinedContents', () => {
  const plain = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false }
  const LOCAL = 'file:///app/dist/renderer/dialog.html'
  const isLocal = (url: string): boolean => url === LOCAL
  function probe(overrides: Partial<ConfinementProbe> = {}): ConfinementProbe {
    return { registered: false, prefs: () => plain, preload: () => undefined, url: () => 'https://team.atlassian.net/', ...overrides }
  }
  const boom = (): never => { throw new Error('internals changed') }

  it('is false for a plain remote contents', () => {
    expect(isConfinedContents(probe(), isLocal)).toBe(false)
  })
  it('is true for a registered contents even when every other signal says plain', () => {
    expect(isConfinedContents(probe({ registered: true }), isLocal)).toBe(true)
    expect(isConfinedContents(probe({ registered: true, prefs: boom, preload: boom, url: boom }), isLocal)).toBe(true)
  })
  it('is true when the preload getter reports a preload the prefs leave out', () => {
    expect(isConfinedContents(probe({ preload: () => '/app/dist/preload/dialog.js' }), isLocal)).toBe(true)
  })
  it('is true for privileged prefs, unknown prefs, and a local page', () => {
    expect(isConfinedContents(probe({ prefs: () => ({ ...plain, nodeIntegration: true }) }), isLocal)).toBe(true)
    expect(isConfinedContents(probe({ prefs: () => undefined }), isLocal)).toBe(true)
    expect(isConfinedContents(probe({ prefs: () => null }), isLocal)).toBe(true)
    expect(isConfinedContents(probe({ url: () => LOCAL }), isLocal)).toBe(true)
  })
  it('fails closed, without throwing, when any getter throws', () => {
    for (const broken of [{ prefs: boom }, { preload: boom }, { url: boom }]) {
      expect(() => isConfinedContents(probe(broken), isLocal)).not.toThrow()
      expect(isConfinedContents(probe(broken), isLocal), Object.keys(broken)[0]).toBe(true)
    }
    expect(isConfinedContents(probe(), boom)).toBe(true)
  })
})

describe('isSameLocalPage', () => {
  it('matches the same page whatever the query or hash', () => {
    expect(isSameLocalPage('file:///app/dist/renderer/dialog.html?again#x', 'file:///app/dist/renderer/dialog.html')).toBe(true)
    expect(isSameLocalPage('http://localhost:5173/dialog.html#x', 'http://localhost:5173/dialog.html')).toBe(true)
  })
  it('is stricter than localPageKey: another path on the dev server is a different page', () => {
    expect(isSameLocalPage('http://localhost:5173/other.html', 'http://localhost:5173/dialog.html')).toBe(false)
    expect(isSameLocalPage('http://localhost:5173/', 'http://localhost:5173/dialog.html')).toBe(false)
  })
  it('refuses other files, hosts, ports and schemes', () => {
    const page = 'file:///app/dist/renderer/dialog.html'
    for (const url of [
      'file:///app/dist/renderer/dialog.htm',
      'file:///app/dist/renderer/other.html',
      'file://host/app/dist/renderer/dialog.html',
      'https://team.atlassian.net/app/dist/renderer/dialog.html',
      'data:text/html,<p>x',
      'about:blank',
      '',
      'not a url'
    ]) {
      expect(isSameLocalPage(url, page), url).toBe(false)
    }
    expect(isSameLocalPage('http://localhost:5174/dialog.html', 'http://localhost:5173/dialog.html')).toBe(false)
    expect(isSameLocalPage('https://localhost:5173/dialog.html', 'http://localhost:5173/dialog.html')).toBe(false)
  })
  it('matches across Windows drive-letter case (Node lowercase vs Chromium uppercase) only', () => {
    const fromNode = 'file:///c:/users/me/jira/resources/app.asar/dist/renderer/dialog.html'
    const fromChromium = 'file:///C:/users/me/jira/resources/app.asar/dist/renderer/dialog.html?mode=welcome'
    expect(isSameLocalPage(fromChromium, fromNode)).toBe(true)
    expect(isSameLocalPage(fromNode, fromChromium)).toBe(true)
    expect(isSameLocalPage('file:///D:/users/me/jira/resources/app.asar/dist/renderer/dialog.html', fromNode)).toBe(false)
    expect(isSameLocalPage('file:///C:/Users/me/jira/resources/app.asar/dist/renderer/dialog.html', fromNode)).toBe(false)
  })
  it('never matches when the expected page itself is not a local page URL', () => {
    expect(isSameLocalPage('about:blank', 'about:blank')).toBe(false)
    expect(isSameLocalPage('data:text/html,x', 'data:text/html,x')).toBe(false)
  })
})

describe('LocalPageRegistry', () => {
  it('starts empty', () => {
    const registry = new LocalPageRegistry()
    expect(registry.matches('file:///app/dialog.html')).toBe(false)
    expect(registry.matches('http://localhost:5173/')).toBe(false)
  })
  it('matches http(s) by exact origin only', () => {
    const registry = new LocalPageRegistry()
    registry.register('http://localhost:5173/')
    expect(registry.matches('http://localhost:5173/dialog.html')).toBe(true)
    expect(registry.matches('http://localhost:5174/dialog.html')).toBe(false)
    expect(registry.matches('https://localhost:5173/dialog.html')).toBe(false)
    expect(registry.matches('http://localhost.evil.test:5173/')).toBe(false)
    expect(registry.matches('http://127.0.0.1:5173/')).toBe(false)
  })
  it('matches file: by exact path only', () => {
    const registry = new LocalPageRegistry()
    registry.register('file:///app/dist/renderer/dialog.html')
    expect(registry.matches('file:///app/dist/renderer/dialog.html#x')).toBe(true)
    expect(registry.matches('file:///app/dist/renderer/other.html')).toBe(false)
    expect(registry.matches('file:///app/dist/renderer/')).toBe(false)
    expect(registry.matches('file:///etc/passwd')).toBe(false)
  })
  it('matches a page registered from a lowercase Windows drive when Chromium reports it uppercase', () => {
    const registry = new LocalPageRegistry()
    registry.register('file:///c:/app/dist/renderer/dialog.html')
    expect(registry.matches('file:///C:/app/dist/renderer/dialog.html?mode=x')).toBe(true)
    expect(registry.matches('file:///c:/app/dist/renderer/dialog.html')).toBe(true)
    expect(registry.matches('file:///D:/app/dist/renderer/dialog.html')).toBe(false)
  })
  it('rejects registrations that are not local-page URLs', () => {
    const registry = new LocalPageRegistry()
    expect(() => registry.register('data:text/html,x')).toThrow()
    expect(() => registry.register('about:blank')).toThrow()
    expect(registry.matches('data:text/html,x')).toBe(false)
  })
})

describe('toExternalHref', () => {
  it('returns the parsed href for http, https and mailto', () => {
    expect(toExternalHref('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(toExternalHref('http://example.com')).toBe('http://example.com/')
    expect(toExternalHref('mailto:a@b.test')).toBe('mailto:a@b.test')
  })
  it('never returns the raw string (the parser strips leading whitespace and tabs)', () => {
    expect(toExternalHref('  \thttps://example.com/x')).toBe('https://example.com/x')
    expect(toExternalHref('ht\ttps://example.com/x')).toBe('https://example.com/x')
  })
  it('returns null for every other scheme', () => {
    for (const url of ['smb://x/y', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ms-msdt:x', 'vscode://x', 'ftp://x/', 'about:blank', 'nonsense', '']) {
      expect(toExternalHref(url)).toBeNull()
    }
  })
})

describe('decideNavigation from remote content', () => {
  it('allows in-app and auth URLs', () => {
    expect(decideNavigation('https://team.atlassian.net/jira', false, ctx())).toBe('allow')
    expect(decideNavigation('https://id.atlassian.com/login', false, ctx())).toBe('allow')
    expect(decideNavigation('https://accounts.google.com/o/oauth2', false, ctx())).toBe('allow')
    expect(decideNavigation('https://corp.okta.com/sso', false, ctx())).toBe('allow')
  })
  it('allows the configured site', () => {
    expect(decideNavigation('https://jira.corp.test/browse/X-1', false, ctx([], 'https://jira.corp.test/'))).toBe('allow')
    expect(decideNavigation('https://jira.corp.test/browse/X-1', false, ctx())).toBe('external')
  })
  it('sends look-alike and other https hosts to the browser', () => {
    expect(decideNavigation('https://atlassian.net.evil.test/', false, ctx())).toBe('external')
    expect(decideNavigation('https://evilatlassian.net/', false, ctx())).toBe('external')
    expect(decideNavigation('http://team.atlassian.net/', false, ctx())).toBe('external')
    expect(decideNavigation('mailto:a@b.test', false, ctx())).toBe('external')
  })
  it('blocks non-safe schemes', () => {
    for (const url of ['smb://x/y', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'vscode://x', 'about:blank']) {
      expect(decideNavigation(url, false, ctx())).toBe('block')
    }
  })
  it('never lets remote content reach a local page', () => {
    const c = ctx(['file:///app/dialog.html', 'http://localhost:5173/'])
    expect(decideNavigation('file:///app/dialog.html', false, c)).toBe('block')
    expect(decideNavigation('http://localhost:5173/dialog.html', false, c)).toBe('block')
  })
})

describe('decideNavigation from confined (local or privileged) content', () => {
  const c = ctx(['file:///app/dialog.html', 'http://localhost:5173/'])
  it('allows registered local pages', () => {
    expect(decideNavigation('file:///app/dialog.html?mode=set-url', true, c)).toBe('allow')
    expect(decideNavigation('http://localhost:5173/dialog.html', true, c)).toBe('allow')
  })
  it('never loads remote content, even in-app or auth', () => {
    expect(decideNavigation('https://team.atlassian.net/jira', true, c)).toBe('external')
    expect(decideNavigation('https://accounts.google.com/x', true, c)).toBe('external')
    expect(decideNavigation('file:///app/other.html', true, c)).toBe('block')
    expect(decideNavigation('smb://x/y', true, c)).toBe('block')
  })
})

describe('decideWindowOpen', () => {
  it('loads in-app URLs in the opener', () => {
    expect(decideWindowOpen('https://team.atlassian.net/browse/X-1', false, ctx())).toBe('load-in-opener')
    expect(decideWindowOpen('https://jira.corp.test/', false, ctx([], 'https://jira.corp.test'))).toBe('load-in-opener')
  })
  it('allows auth popups', () => {
    expect(decideWindowOpen('https://accounts.google.com/x', false, ctx())).toBe('auth-popup')
    expect(decideWindowOpen('https://login.microsoftonline.com/common', false, ctx())).toBe('auth-popup')
  })
  it('hands other safe URLs to the browser', () => {
    expect(decideWindowOpen('https://example.com/', false, ctx())).toBe('external')
    expect(decideWindowOpen('mailto:a@b.test', false, ctx())).toBe('external')
    expect(decideWindowOpen('http://accounts.google.com/x', false, ctx())).toBe('external')
  })
  it('denies everything else', () => {
    for (const url of ['smb://x/y', 'file:///etc/passwd', 'javascript:1', 'about:blank', '', 'data:text/html,x']) {
      expect(decideWindowOpen(url, false, ctx())).toBe('deny')
    }
    expect(decideWindowOpen('file:///app/dialog.html', false, ctx(['file:///app/dialog.html']))).toBe('deny')
  })
  it('never opens or loads remote content from confined content', () => {
    expect(decideWindowOpen('https://team.atlassian.net/', true, ctx())).toBe('external')
    expect(decideWindowOpen('https://accounts.google.com/x', true, ctx())).toBe('external')
    expect(decideWindowOpen('file:///app/dialog.html', true, ctx(['file:///app/dialog.html']))).toBe('deny')
    expect(decideWindowOpen('smb://x/y', true, ctx())).toBe('deny')
  })
})

describe('isPermissionAllowed', () => {
  it('allows exactly notifications, clipboard-sanitized-write and fullscreen', () => {
    expect([...ALLOWED_PERMISSIONS].sort()).toEqual(['clipboard-sanitized-write', 'fullscreen', 'notifications'])
    expect(Object.isFrozen(ALLOWED_PERMISSIONS)).toBe(true)
  })
  it('grants allowed permissions to in-app origins', () => {
    for (const permission of ALLOWED_PERMISSIONS) {
      expect(isPermissionAllowed(permission, 'https://team.atlassian.net/jira', undefined)).toBe(true)
    }
    expect(isPermissionAllowed('notifications', 'https://team.atlassian.net', 'https://team.atlassian.net/jira')).toBe(true)
    expect(isPermissionAllowed('notifications', 'https://jira.corp.test', undefined, 'https://jira.corp.test/')).toBe(true)
  })
  it('denies every other permission, even in-app', () => {
    for (const permission of ['media', 'openExternal', 'geolocation', 'clipboard-read', 'hid', 'usb', 'serial', 'display-capture', 'pointerLock', 'unknown']) {
      expect(isPermissionAllowed(permission, 'https://team.atlassian.net/jira', undefined)).toBe(false)
    }
  })
  it('denies allowed permissions to anything that is not in-app', () => {
    for (const origin of ['https://accounts.google.com', 'https://atlassian.net.evil.test', 'http://team.atlassian.net', 'file:///app/dialog.html', 'data:text/html,x', '', 'null']) {
      expect(isPermissionAllowed('notifications', origin, undefined)).toBe(false)
    }
  })
  it('denies an in-app frame embedded in content that is not in-app', () => {
    expect(isPermissionAllowed('notifications', 'https://team.atlassian.net', 'https://evil.test/')).toBe(false)
    expect(isPermissionAllowed('notifications', 'https://team.atlassian.net', '')).toBe(false)
  })
})
