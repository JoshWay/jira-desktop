import { describe, expect, it } from 'vitest'
import {
  APP_HOST_SUFFIXES,
  AUTH_HOSTS,
  hostMatches,
  isAuthUrl,
  isInAppUrl,
  isSafeExternalUrl,
  normalizeJiraUrl
} from '../../src/main/security/urlPolicy'

describe('constants', () => {
  it('exposes the allow lists verbatim', () => {
    expect(APP_HOST_SUFFIXES).toEqual(['atlassian.net', 'atlassian.com', 'bitbucket.org', 'trello.com'])
    expect(AUTH_HOSTS).toEqual([
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
  })
})

describe('hostMatches', () => {
  it('matches exact and subdomain hosts', () => {
    expect(hostMatches('atlassian.net', 'atlassian.net')).toBe(true)
    expect(hostMatches('x.atlassian.net', 'atlassian.net')).toBe(true)
  })
  it('is case-insensitive and ignores a trailing dot', () => {
    expect(hostMatches('X.Atlassian.NET.', 'atlassian.net')).toBe(true)
  })
  it('rejects look-alikes', () => {
    expect(hostMatches('evilatlassian.net', 'atlassian.net')).toBe(false)
    expect(hostMatches('atlassian.net.evil.io', 'atlassian.net')).toBe(false)
  })
})

describe('isInAppUrl', () => {
  it.each([
    ['https://acme.atlassian.net/jira', true],
    ['https://atlassian.net', true],
    ['https://id.atlassian.com/login', true],
    ['https://bitbucket.org/x', true],
    ['https://trello.com/b/1', true],
    ['https://x.atlassian.net.', true],
    ['https://X.ATLASSIAN.NET/', true],
    ['https://x.atlassian.net:8443/', true],
    ['https://atlassian.net.evil.io', false],
    ['https://evilatlassian.net', false],
    ['https://evil.com/?atlassian.net', false],
    ['https://evil.com/#atlassian.net', false],
    ['https://u@evil.com@x.atlassian.net.evil.io/', false],
    ['http://x.atlassian.net', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
    ['', false]
  ])('%s -> %s (no configured site)', (url, expected) => {
    expect(isInAppUrl(url)).toBe(expected)
  })

  it('allows the configured self-hosted origin', () => {
    const site = 'https://jira.corp.example/'
    expect(isInAppUrl('https://jira.corp.example/browse/A-1', site)).toBe(true)
    expect(isInAppUrl('https://JIRA.corp.example:443/x', site)).toBe(true)
    expect(isInAppUrl('https://jira.corp.example/', undefined)).toBe(false)
  })
  it('does not widen to sibling hosts, other ports or subdomains of the configured site', () => {
    const site = 'https://jira.corp.example/'
    expect(isInAppUrl('https://other.corp.example/', site)).toBe(false)
    expect(isInAppUrl('https://corp.example/', site)).toBe(false)
    expect(isInAppUrl('https://a.jira.corp.example/', site)).toBe(false)
    expect(isInAppUrl('https://jira.corp.example:8443/', site)).toBe(false)
  })
  it('honours a configured port', () => {
    const site = 'https://jira.corp.example:8443/'
    expect(isInAppUrl('https://jira.corp.example:8443/x', site)).toBe(true)
    expect(isInAppUrl('https://jira.corp.example/x', site)).toBe(false)
  })
  it('allows http only when the configured site is http', () => {
    const site = 'http://localhost:8080/'
    expect(isInAppUrl('http://localhost:8080/x', site)).toBe(true)
    expect(isInAppUrl('https://localhost:8080/x', site)).toBe(false)
    expect(isInAppUrl('http://localhost:9090/x', site)).toBe(false)
    expect(isInAppUrl('http://x.atlassian.net', site)).toBe(false)
  })
  it('matches a trailing-dot configured host by origin only if the URL parses the same', () => {
    const site = 'https://jira.corp.example./'
    expect(isInAppUrl('https://jira.corp.example./x', site)).toBe(true)
  })
  it('matches IPv6 literal configured origins', () => {
    const site = 'http://[::1]:8080/'
    expect(isInAppUrl('http://[::1]:8080/x', site)).toBe(true)
    expect(isInAppUrl('http://[::1]:8081/x', site)).toBe(false)
  })
  it('ignores an invalid configured site', () => {
    expect(isInAppUrl('https://acme.atlassian.net/', 'garbage')).toBe(true)
    expect(isInAppUrl('https://jira.corp.example/', 'garbage')).toBe(false)
  })
})

describe('isAuthUrl', () => {
  it.each([
    ['https://accounts.google.com/o/oauth2', true],
    ['https://login.microsoftonline.com/x', true],
    ['https://acme.okta.com/app', true],
    ['https://acme.auth0.com/', true],
    ['https://api-1.duosecurity.com/', true],
    ['https://okta.com.evil.io/', false],
    ['https://evilokta.com/', false],
    ['http://acme.okta.com/', false],
    ['https://evil.com/?accounts.google.com', false],
    ['nope', false]
  ])('%s -> %s', (url, expected) => {
    expect(isAuthUrl(url)).toBe(expected)
  })
})

describe('isSafeExternalUrl', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com', true],
    ['mailto:a@b.co', true],
    ['MAILTO:a@b.co', true],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['smb://host/share', false],
    ['data:text/html,hi', false],
    ['ftp://example.com', false],
    ['', false],
    ['not a url', false]
  ])('%s -> %s', (url, expected) => {
    expect(isSafeExternalUrl(url)).toBe(expected)
  })
})

describe('normalizeJiraUrl', () => {
  const ok = (input: string) => {
    const r = normalizeJiraUrl(input)
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
    return r.url
  }
  const err = (input: string) => {
    const r = normalizeJiraUrl(input)
    if (r.ok) throw new Error(`expected error, got ${r.url}`)
    return r.error
  }

  it('adds https and /jira to a bare cloud root', () => {
    expect(ok('acme.atlassian.net')).toBe('https://acme.atlassian.net/jira')
    expect(ok('  acme.atlassian.net/  ')).toBe('https://acme.atlassian.net/jira')
    expect(ok('https://acme.atlassian.net')).toBe('https://acme.atlassian.net/jira')
  })
  it('accepts mixed-case scheme and lower-cases host', () => {
    expect(ok('HTTPS://Acme.atlassian.net')).toBe('https://acme.atlassian.net/jira')
  })
  it('preserves deep links, query and hash', () => {
    expect(ok('acme.atlassian.net/browse/ABC-1?x=1#c')).toBe('https://acme.atlassian.net/browse/ABC-1?x=1#c')
    expect(ok('https://acme.atlassian.net/jira/software/projects/A/boards/1')).toBe(
      'https://acme.atlassian.net/jira/software/projects/A/boards/1'
    )
  })
  it('leaves self-hosted URLs unchanged', () => {
    expect(ok('https://jira.corp.example/')).toBe('https://jira.corp.example/')
    expect(ok('jira.corp.example:8443/jira')).toBe('https://jira.corp.example:8443/jira')
  })
  it('allows http and localhost', () => {
    expect(ok('http://jira.corp.example/')).toBe('http://jira.corp.example/')
    expect(ok('localhost:8080')).toBe('https://localhost:8080/')
    expect(ok('http://localhost:8080/')).toBe('http://localhost:8080/')
  })
  it('rejects empty input', () => {
    expect(err('')).toBeTruthy()
    expect(err('   ')).toBeTruthy()
  })
  it('rejects non-http(s) schemes', () => {
    for (const s of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.example.com', 'smb://host/share', 'data:text/html,x']) {
      expect(err(s)).toBeTruthy()
    }
  })
  it('rejects credentials', () => {
    expect(err('https://u:p@acme.atlassian.net')).toBeTruthy()
    expect(err('https://u@acme.atlassian.net')).toBeTruthy()
    expect(err('u:p@acme.atlassian.net')).toBeTruthy()
  })
  it('rejects hosts without a dot except localhost', () => {
    expect(err('intranet')).toBeTruthy()
    expect(err('https://jira/')).toBeTruthy()
  })
  it('rejects unparseable input', () => {
    expect(err('https://')).toBeTruthy()
    expect(err('http://exa mple.com')).toBeTruthy()
  })
})
