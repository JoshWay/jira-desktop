// Pure URL policy. No electron imports, so it stays unit-testable.
// codex:run npm test -- tests/unit/urlPolicy.test.ts

export const APP_HOST_SUFFIXES: readonly string[] = ['atlassian.net', 'atlassian.com', 'bitbucket.org', 'trello.com']

export const AUTH_HOSTS: readonly string[] = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'okta.com',
  'oktapreview.com',
  'onelogin.com',
  'auth0.com',
  'duosecurity.com',
  'pingidentity.com'
]

export type NormalizeResult = { ok: true; url: string } | { ok: false; error: string }

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function cleanHost(host: string): string {
  const lower = host.toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

export function hostMatches(host: string, entry: string): boolean {
  const h = cleanHost(host)
  return h === entry || h.endsWith('.' + entry)
}

export function isInAppUrl(url: string, configuredSiteUrl?: string): boolean {
  const u = parse(url)
  if (!u) return false
  if (u.protocol === 'https:' && APP_HOST_SUFFIXES.some((s) => hostMatches(u.hostname, s))) return true
  if (!configuredSiteUrl) return false
  const site = parse(configuredSiteUrl)
  if (!site || (site.protocol !== 'https:' && site.protocol !== 'http:')) return false
  return u.origin === site.origin
}

export function isAuthUrl(url: string): boolean {
  const u = parse(url)
  return !!u && u.protocol === 'https:' && AUTH_HOSTS.some((h) => hostMatches(u.hostname, h))
}

export function isSafeExternalUrl(url: string): boolean {
  const u = parse(url)
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:')
}

// "host:8080/x" looks like a scheme but is a host with a port.
const HOST_WITH_PORT = /^[^/?#:@]+:\d+(?:[/?#]|$)/
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

export function normalizeJiraUrl(input: string): NormalizeResult {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'Enter your Jira address.' }

  let candidate = raw
  if (HAS_SCHEME.test(raw) && !HOST_WITH_PORT.test(raw)) {
    if (!/^https?:/i.test(raw)) return { ok: false, error: 'Only http and https addresses are supported.' }
  } else {
    candidate = 'https://' + raw
  }

  const u = parse(candidate)
  if (!u || !u.hostname) return { ok: false, error: 'That does not look like a valid address.' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'Only http and https addresses are supported.' }
  }
  if (u.username || u.password) return { ok: false, error: 'Remove the username and password from the address.' }
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') {
    return { ok: false, error: 'Enter the full address, such as your-team.atlassian.net.' }
  }

  if (hostMatches(u.hostname, 'atlassian.net') && u.pathname === '/' && !u.search && !u.hash) {
    return { ok: true, url: `${u.protocol}//${u.host}/jira` }
  }
  return { ok: true, url: u.href }
}
