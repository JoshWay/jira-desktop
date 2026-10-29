// Pure URL policy. No electron imports, so it stays unit-testable.
// codex:run npm test -- tests/unit/urlPolicy.test.ts

export const APP_HOST_SUFFIXES: readonly string[] = Object.freeze(['atlassian.net', 'atlassian.com', 'bitbucket.org', 'trello.com'])

export const AUTH_HOSTS: readonly string[] = Object.freeze([
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
])

// Atlassian's marketing apex and account/login host: in-app, but never a user's Jira site, so the
// app never starts on (or saves as the site) its login or marketing page (spec R3)
export const NOT_SITE_HOSTS: readonly string[] = Object.freeze(['atlassian.net', 'www.atlassian.net', 'id.atlassian.com'])

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

function isAppHost(host: string): boolean {
  return APP_HOST_SUFFIXES.some((s) => hostMatches(host, s))
}

export function isInAppUrl(url: string, configuredSiteUrl?: string): boolean {
  const u = parse(url)
  if (!u) return false
  const appHost = isAppHost(u.hostname)
  if (u.protocol === 'https:' && appHost) return true
  // Plaintext is never in-app for Atlassian hosts, whatever the configured site says.
  if (appHost || !configuredSiteUrl) return false
  const site = parse(configuredSiteUrl)
  if (!site || (site.protocol !== 'https:' && site.protocol !== 'http:')) return false
  return (
    u.protocol === site.protocol &&
    u.port === site.port &&
    cleanHost(u.hostname) === cleanHost(site.hostname)
  )
}

// Exact host match only: team.atlassian.net and jira.atlassian.com are sites
// codex:run npm test -- tests/unit/urlPolicy.test.ts
export function isNotASiteUrl(url: string): boolean {
  const u = parse(url)
  return !!u && NOT_SITE_HOSTS.includes(cleanHost(u.hostname))
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
  const host = cleanHost(u.hostname)
  if (host.endsWith('.') || host.includes('..') || host.startsWith('.')) {
    return { ok: false, error: 'That does not look like a valid address.' }
  }
  // The dot rule catches a bare name typed in place of a site ("intranet"). A bracketed IPv6
  // literal has no dots either, but it is a complete address the parser has already validated,
  // and a self-hosted site may be one (isInAppUrl matches IPv6 origins), so it passes.
  // codex:run npm test -- tests/unit/urlPolicy.test.ts
  const ipv6Literal = host.startsWith('[') && host.endsWith(']')
  if (!host.includes('.') && host !== 'localhost' && !ipv6Literal) {
    return { ok: false, error: 'Enter the full address, such as your-team.atlassian.net.' }
  }
  u.hostname = host
  // Atlassian hosts are always https; upgrade rather than reject.
  if (isAppHost(host)) u.protocol = 'https:'

  if (hostMatches(host, 'atlassian.net') && u.pathname === '/' && !u.search && !u.hash) {
    return { ok: true, url: `${u.protocol}//${u.host}/jira` }
  }
  return { ok: true, url: u.href }
}
