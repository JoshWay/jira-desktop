import { describe, expect, it } from 'vitest'
import { MAX_FAILED_URL_LENGTH, STRANDED_LOAD_DESCRIPTION, describeLoadFailure, isStranded, resolveSavedSiteUrl, shouldShowLoadError } from '../../src/main/services/mainWindowRules'

const DIALOG_PAGE = 'file:///app/dist/renderer/dialog.html'
const isLocalPage = (url: string): boolean => url.startsWith('file:///app/dist/renderer/') || url.startsWith('http://localhost:5173/')

describe('resolveSavedSiteUrl', () => {
  it('returns a saved URL that is already normalized', () => {
    expect(resolveSavedSiteUrl('https://acme.atlassian.net/jira', isLocalPage)).toBe('https://acme.atlassian.net/jira')
    expect(resolveSavedSiteUrl('https://jira.corp.test/browse/X-1', isLocalPage)).toBe('https://jira.corp.test/browse/X-1')
    expect(resolveSavedSiteUrl('http://jira.corp.test:8080/', isLocalPage)).toBe('http://jira.corp.test:8080/')
  })

  it('normalizes a hand-edited URL the way the dialog would', () => {
    expect(resolveSavedSiteUrl('acme.atlassian.net', isLocalPage)).toBe('https://acme.atlassian.net/jira')
    expect(resolveSavedSiteUrl('  HTTP://Acme.Atlassian.NET/  ', isLocalPage)).toBe('https://acme.atlassian.net/jira')
  })

  it('refuses anything a poisoned settings file could use to load something other than a site', () => {
    for (const raw of [
      undefined,
      null,
      42,
      {},
      ['https://acme.atlassian.net/jira'],
      '',
      '   ',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'about:blank',
      'https://user:pw@acme.atlassian.net/',
      'intranet',
      // Never a site: the startup URL is never the login page or the marketing apex
      'https://id.atlassian.com/login',
      'https://atlassian.net/jira',
      'atlassian.net',
      DIALOG_PAGE,
      // Under `npm run dev` the local pages are served from the dev server
      'http://localhost:5173/dialog.html'
    ]) {
      expect(resolveSavedSiteUrl(raw, isLocalPage), JSON.stringify(raw)).toBeUndefined()
    }
  })
})

describe('shouldShowLoadError', () => {
  it('reports a failed main-frame load of a site', () => {
    expect(shouldShowLoadError(-2, true, 'https://acme.atlassian.net/jira', isLocalPage)).toBe(true)
    expect(shouldShowLoadError(-105, true, 'https://jira.corp.test/', isLocalPage)).toBe(true)
    expect(shouldShowLoadError(-379, true, 'http://jira.corp.test:8080/', isLocalPage)).toBe(true)
  })

  it('ignores aborted loads (-3), subframes, and anything that is not a remote http(s) page', () => {
    expect(shouldShowLoadError(-3, true, 'https://acme.atlassian.net/jira', isLocalPage)).toBe(false)
    expect(shouldShowLoadError(-2, false, 'https://acme.atlassian.net/jira', isLocalPage)).toBe(false)
    for (const url of [DIALOG_PAGE, 'file:///app/dist/renderer/placeholder.html', 'http://localhost:5173/placeholder.html', 'about:blank', 'chrome-error://chromewebdata/', '', 'not a url']) {
      expect(shouldShowLoadError(-2, true, url, isLocalPage), url).toBe(false)
    }
  })
})

// codex:run npm test -- tests/unit/mainWindowRules.test.ts
describe('isStranded', () => {
  it('reports a main window left with nothing remote committed and nothing loading', () => {
    // Startup (nothing committed yet), after leaving the placeholder, and on a local page
    for (const committed of ['', 'about:blank', 'file:///app/dist/renderer/placeholder.html', 'http://localhost:5173/placeholder.html']) {
      expect(isStranded(committed, false, isLocalPage), committed).toBe(true)
    }
  })

  it('ignores a load superseded by one still running, and a page that is already showing', () => {
    expect(isStranded('', true, isLocalPage)).toBe(false)
    expect(isStranded('about:blank', true, isLocalPage)).toBe(false)
    expect(isStranded('https://acme.atlassian.net/jira', false, isLocalPage)).toBe(false)
    expect(isStranded('https://evil.test/', false, isLocalPage)).toBe(false)
  })

  it('has a description that fits the error view uncut', () => {
    expect(describeLoadFailure('https://jira.corp.test/', STRANDED_LOAD_DESCRIPTION, 'https://jira.corp.test/').errorDescription).toBe(STRANDED_LOAD_DESCRIPTION)
  })
})

describe('describeLoadFailure', () => {
  const site = 'https://jira.corp.test/'

  it('retries the failed URL when it is in-app or an auth page', () => {
    expect(describeLoadFailure('https://acme.atlassian.net/browse/X-1', 'ERR_FAILED', site)).toEqual({
      failedUrl: 'https://acme.atlassian.net/browse/X-1',
      errorDescription: 'ERR_FAILED',
      retryUrl: 'https://acme.atlassian.net/browse/X-1'
    })
    expect(describeLoadFailure('https://jira.corp.test/browse/X-1', 'ERR_FAILED', site).retryUrl).toBe('https://jira.corp.test/browse/X-1')
    expect(describeLoadFailure('https://accounts.google.com/o/oauth2', 'ERR_FAILED', site).retryUrl).toBe('https://accounts.google.com/o/oauth2')
  })

  it('retries the configured site for any other URL, and has no retry without a site', () => {
    expect(describeLoadFailure('https://evil.test/', 'ERR_FAILED', site).retryUrl).toBe(site)
    expect(describeLoadFailure('https://atlassian.net.evil.test/', 'ERR_FAILED', site).retryUrl).toBe(site)
    expect(describeLoadFailure('https://evil.test/', 'ERR_FAILED', undefined).retryUrl).toBeUndefined()
  })

  it('caps what it shows, but retries the real URL', () => {
    const long = 'https://acme.atlassian.net/' + 'a'.repeat(5000)
    const failure = describeLoadFailure(long, 'E'.repeat(500), site)
    expect(failure.failedUrl).toHaveLength(MAX_FAILED_URL_LENGTH)
    expect(failure.failedUrl.endsWith('…')).toBe(true)
    expect(failure.errorDescription.length).toBeLessThanOrEqual(200)
    expect(failure.retryUrl).toBe(long)
  })
})
