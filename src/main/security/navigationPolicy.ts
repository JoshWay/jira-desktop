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

// The identity of an app-owned page: exact origin for http(s) (the dev server), exact path for
// file: (packaged builds). Query and hash never matter. Anything else cannot be a local page.
export function localPageKey(url: string): string | null {
  const u = parse(url)
  if (!u) return null
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
  if (u.protocol === 'file:') return `file://${u.host}${u.pathname}`
  return null
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
