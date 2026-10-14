// Pure decisions behind the webContents policy (webContentsPolicy.ts does the Electron wiring).
// No electron imports, so it stays unit-testable.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
import { isAuthUrl, isInAppUrl, isSafeExternalUrl } from './urlPolicy'

export const ALLOWED_PERMISSIONS: readonly string[] = Object.freeze(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

export interface PolicyContext {
  // The user's configured Jira site, if any (counts as in-app by exact origin)
  siteUrl?: string
  isLocalPage: (url: string) => boolean
}

export type NavigationDecision = 'allow' | 'external' | 'block'
export type WindowOpenDecision = 'load-in-opener' | 'auth-popup' | 'external' | 'deny'

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

// The subset of Electron's WebPreferences that grants a contents privilege
export interface PrivilegePrefs {
  preload?: string
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  nodeIntegrationInWorker?: boolean
  webviewTag?: boolean
  sandbox?: boolean
  contextIsolation?: boolean
}

// True when prefs give the page anything beyond a plain sandboxed, isolated renderer: a preload,
// Node in any context, <webview>, no sandbox or no isolation. Missing prefs count as privileged.
export function hasPrivilegedPrefs(prefs: PrivilegePrefs | null | undefined): boolean {
  if (!prefs) return true
  if (prefs.preload || prefs.nodeIntegration || prefs.nodeIntegrationInSubFrames || prefs.nodeIntegrationInWorker) return true
  if (prefs.webviewTag === true) return true
  return prefs.sandbox === false || prefs.contextIsolation === false
}

// What isConfinedContents needs to know about one webContents. The getters may throw (they read
// Electron internals), and `preload` returns undefined when the contents has none.
export interface ConfinementProbe {
  // Registered by the app as privileged (it created the window with a preload)
  registered: boolean
  prefs: () => PrivilegePrefs | null | undefined
  preload: () => string | undefined
  url: () => string
}

// Confined: registered as privileged, privileged by its prefs or preload, or showing a local page.
// Any getter that throws makes the contents confined (fail closed), never an exception.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
export function isConfinedContents(probe: ConfinementProbe, isLocalPage: (url: string) => boolean): boolean {
  if (probe.registered) return true
  try {
    const prefs = probe.prefs()
    if (hasPrivilegedPrefs(prefs && { ...prefs, preload: prefs.preload || probe.preload() })) return true
    return isLocalPage(probe.url())
  } catch {
    return true
  }
}

// A loadURL rejection with ERR_ABORTED means the load was cancelled (superseded or stopped), which
// is expected; any other rejection is a real failure. (On Electron 44 a redirect the policy
// prevents resolves loadURL rather than rejecting.)
export function isExpectedLoadAbort(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_ABORTED'
}

// A file: URL's path with a Windows drive letter in Chromium's canonical case. Node's
// pathToFileURL keeps the case it is given (file:///c:/...) while Chromium's canonicalizer
// uppercases the drive letter (file:///C:/...), so both sides of a comparison go through this.
// Only the drive letter: the rest of the path stays case-sensitive, as Chromium leaves it.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
function canonicalFilePath(pathname: string): string {
  return pathname.replace(/^\/([a-z]):/, (_, drive: string) => `/${drive.toUpperCase()}:`)
}

// The identity of an app-owned page: exact origin for http(s) (the dev server), exact path for
// file: (packaged builds). Query and hash never matter. Anything else cannot be a local page.
export function localPageKey(url: string): string | null {
  const u = parse(url)
  if (!u) return null
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
  if (u.protocol === 'file:') return `file://${u.host}${canonicalFilePath(u.pathname)}`
  return null
}

// The exact page a local-page IPC sender must be showing: scheme, host and path (query and hash
// ignored). Stricter than localPageKey, which accepts any path on the dev server's origin.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
export function isSameLocalPage(url: string, pageUrl: string): boolean {
  const path = (value: string): string | null => {
    const u = parse(value)
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:')) return null
    return `${u.protocol}//${u.host}${u.protocol === 'file:' ? canonicalFilePath(u.pathname) : u.pathname}`
  }
  const actual = path(url)
  return actual !== null && actual === path(pageUrl)
}

export class LocalPageRegistry {
  private readonly keys = new Set<string>()

  register(url: string): void {
    const key = localPageKey(url)
    if (!key) throw new Error(`not a local page URL: ${url}`)
    this.keys.add(key)
  }

  matches(url: string): boolean {
    const key = localPageKey(url)
    return key !== null && this.keys.has(key)
  }
}

// What shell.openExternal may receive: the parsed href of an http/https/mailto URL, never the
// raw string (the WHATWG parser strips leading whitespace and tabs, so the two can differ).
export function toExternalHref(url: string): string | null {
  if (!isSafeExternalUrl(url)) return null
  return parse(url)?.href ?? null
}

// `confined` contents are app-owned or privileged (a registered local page, or prefs with a
// preload, Node or no sandbox). They may move between local pages only, never to remote content,
// so remote content can never inherit their privileges. Remote content may never reach a local page.
export function decideNavigation(url: string, confined: boolean, ctx: PolicyContext): NavigationDecision {
  if (confined) {
    if (ctx.isLocalPage(url)) return 'allow'
    return isSafeExternalUrl(url) ? 'external' : 'block'
  }
  if (ctx.isLocalPage(url)) return 'block'
  if (isInAppUrl(url, ctx.siteUrl) || isAuthUrl(url)) return 'allow'
  return isSafeExternalUrl(url) ? 'external' : 'block'
}

export function decideWindowOpen(url: string, confined: boolean, ctx: PolicyContext): WindowOpenDecision {
  if (ctx.isLocalPage(url)) return 'deny'
  if (confined) return isSafeExternalUrl(url) ? 'external' : 'deny'
  if (isInAppUrl(url, ctx.siteUrl)) return 'load-in-opener'
  if (isAuthUrl(url)) return 'auth-popup'
  return isSafeExternalUrl(url) ? 'external' : 'deny'
}

// Only the allow-listed permissions, only for in-app origins. When the request comes from a frame
// embedded in another document, that document must be in-app too.
export function isPermissionAllowed(permission: string, requestingUrl: string, embeddingUrl: string | undefined, siteUrl?: string): boolean {
  if (!ALLOWED_PERMISSIONS.includes(permission)) return false
  if (!isInAppUrl(requestingUrl, siteUrl)) return false
  return embeddingUrl === undefined || isInAppUrl(embeddingUrl, siteUrl)
}
