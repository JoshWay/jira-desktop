import { describe, expect, it } from 'vitest'
import { MAX_URL_LENGTH, NOT_A_SITE_ERROR, NOT_IN_APP_ERROR, parseLoadErrorSubmit, parseSubmitPayload, validateDialogUrl } from '../../src/main/dialogs/dialogRules'

describe('parseSubmitPayload', () => {
  it('accepts a set-url payload and keeps only the url', () => {
    expect(parseSubmitPayload('set-url', { url: 'team.atlassian.net', product: undefined, background: undefined })).toEqual({ url: 'team.atlassian.net' })
    expect(parseSubmitPayload('set-url', { url: '', product: 'jira', background: true, extra: 1 })).toEqual({ url: '' })
  })

  it('accepts a welcome payload exactly like set-url', () => {
    expect(parseSubmitPayload('welcome', { url: 'team.atlassian.net', product: 'jira', background: true })).toEqual({ url: 'team.atlassian.net' })
    expect(parseSubmitPayload('welcome', { url: 42 })).toBeNull()
  })

  it('accepts a new-window payload with a known product and a boolean background', () => {
    expect(parseSubmitPayload('new-window', { url: 'x', product: 'confluence', background: false })).toEqual({ url: 'x', product: 'confluence', background: false })
    expect(parseSubmitPayload('new-window', { url: 'x', product: 'auto', background: true })).toEqual({ url: 'x', product: 'auto', background: true })
  })

  it('rejects anything the page cannot produce', () => {
    for (const raw of [undefined, null, 'https://team.atlassian.net', 42, [], ['https://team.atlassian.net'], {}, { url: 42 }, { url: null }, { url: ['x'] }]) {
      expect(parseSubmitPayload('set-url', raw), JSON.stringify(raw)).toBeNull()
    }
    for (const raw of [
      { url: 'x' },
      { url: 'x', product: 'jira' },
      { url: 'x', product: 'teams', background: false },
      { url: 'x', product: 'JIRA', background: false },
      { url: 'x', product: 'toString', background: false },
      { url: 'x', product: 'jira', background: 'yes' }
    ]) {
      expect(parseSubmitPayload('new-window', raw), JSON.stringify(raw)).toBeNull()
    }
  })

  it('rejects a URL longer than the input allows', () => {
    const long = 'https://team.atlassian.net/' + 'a'.repeat(MAX_URL_LENGTH)
    expect(parseSubmitPayload('set-url', { url: long })).toBeNull()
    expect(parseSubmitPayload('set-url', { url: long.slice(0, MAX_URL_LENGTH) })).toEqual({ url: long.slice(0, MAX_URL_LENGTH) })
  })
})

describe('parseLoadErrorSubmit', () => {
  it('accepts exactly the two actions and keeps only the action', () => {
    expect(parseLoadErrorSubmit({ action: 'retry' })).toEqual({ action: 'retry' })
    expect(parseLoadErrorSubmit({ action: 'change-url', url: 'https://evil.test/' })).toEqual({ action: 'change-url' })
  })

  it('rejects anything the page cannot produce', () => {
    for (const raw of [undefined, null, 'retry', [], {}, { action: 'RETRY' }, { action: 'toString' }, { action: 'quit' }, { action: ['retry'] }, { url: 'https://acme.atlassian.net/' }]) {
      expect(parseLoadErrorSubmit(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('validateDialogUrl', () => {
  it('set-url and welcome refuse the Atlassian login and marketing pages as a site', () => {
    for (const mode of ['set-url', 'welcome'] as const) {
      for (const input of ['atlassian.net', 'https://id.atlassian.com/login', 'www.atlassian.net']) {
        expect(validateDialogUrl(mode, input), `${mode} ${input}`).toEqual({ ok: false, error: NOT_A_SITE_ERROR })
      }
    }
    // A new window may still open them (they are in-app)
    expect(validateDialogUrl('new-window', 'https://id.atlassian.com/login')).toEqual({ ok: true, url: 'https://id.atlassian.com/login' })
  })

  it('welcome accepts what set-url accepts, without the in-app restriction', () => {
    expect(validateDialogUrl('welcome', 'team.atlassian.net')).toEqual({ ok: true, url: 'https://team.atlassian.net/jira' })
    expect(validateDialogUrl('welcome', 'https://jira.corp.test/')).toEqual({ ok: true, url: 'https://jira.corp.test/' })
    expect(validateDialogUrl('welcome', 'file:///etc/passwd')).toEqual({ ok: false, error: 'Only http and https addresses are supported.' })
  })

  it('set-url accepts any address normalizeJiraUrl accepts, normalized', () => {
    expect(validateDialogUrl('set-url', 'team.atlassian.net')).toEqual({ ok: true, url: 'https://team.atlassian.net/jira' })
    expect(validateDialogUrl('set-url', 'https://jira.corp.test/')).toEqual({ ok: true, url: 'https://jira.corp.test/' })
  })

  it('passes normalizeJiraUrl errors through unchanged', () => {
    expect(validateDialogUrl('set-url', '  ')).toEqual({ ok: false, error: 'Enter your Jira address.' })
    expect(validateDialogUrl('new-window', 'javascript:alert(1)')).toEqual({ ok: false, error: 'Only http and https addresses are supported.' })
  })

  it('new-window requires the address to be in-app', () => {
    expect(validateDialogUrl('new-window', 'team.atlassian.net/wiki')).toEqual({ ok: true, url: 'https://team.atlassian.net/wiki' })
    expect(validateDialogUrl('new-window', 'https://example.com/')).toEqual({ ok: false, error: NOT_IN_APP_ERROR })
    expect(validateDialogUrl('new-window', 'https://atlassian.net.evil.test/')).toEqual({ ok: false, error: NOT_IN_APP_ERROR })
  })

  it('new-window treats the configured site as in-app, by exact origin', () => {
    const site = 'https://jira.corp.test/'
    expect(validateDialogUrl('new-window', 'https://jira.corp.test/browse/X-1', site)).toEqual({ ok: true, url: 'https://jira.corp.test/browse/X-1' })
    expect(validateDialogUrl('new-window', 'https://other.corp.test/', site)).toEqual({ ok: false, error: NOT_IN_APP_ERROR })
  })

  it('normalizes markup characters away', () => {
    const result = validateDialogUrl('set-url', 'https://x.atlassian.net/"><img src=x onerror=alert(1)>')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).not.toMatch(/[<>"]/)
  })
})
