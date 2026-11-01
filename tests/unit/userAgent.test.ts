import { describe, expect, it } from 'vitest'
import { sanitizeUserAgent } from '../../src/main/navigation/userAgent'

const MAC_DEFAULT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jira-desktop-app/2.1.0 Chrome/146.0.7680.65 Electron/44.7.1 Safari/537.36'
const MAC_CLEAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.65 Safari/537.36'
const NAMES = ['Electron', 'jira-desktop-app', 'Jira Desktop']

describe('sanitizeUserAgent', () => {
  it("drops the Electron and app-name tokens from Electron's default UA, leaving a plain Chrome UA", () => {
    expect(sanitizeUserAgent(MAC_DEFAULT, NAMES)).toBe(MAC_CLEAN)
  })

  it('drops the productName token, which Electron writes with its spaces removed', () => {
    const packaged = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) JiraDesktop/2.1.0 Chrome/146.0.0.0 Electron/44.0.0 Safari/537.36'
    expect(sanitizeUserAgent(packaged, NAMES)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  })

  it('keeps every other token, including ones that merely contain a stripped name', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) NotElectron/1.0 Chrome/146.0.0.0 Electron/44.0.0-beta.1 Safari/537.36 Electronic/2'
    expect(sanitizeUserAgent(ua, NAMES)).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) NotElectron/1.0 Chrome/146.0.0.0 Safari/537.36 Electronic/2')
  })

  it('leaves text inside the platform comment alone', () => {
    const ua = 'Mozilla/5.0 (Electron/1 ; X11) Chrome/146.0.0.0 Electron/44.0.0 Safari/537.36'
    expect(sanitizeUserAgent(ua, ['Electron'])).toBe('Mozilla/5.0 (Electron/1 ; X11) Chrome/146.0.0.0 Safari/537.36')
  })

  it('treats names literally, never as patterns', () => {
    const ua = 'Mozilla/5.0 Chrome/146.0.0.0 a.b/1 axb/1 Safari/537.36'
    expect(sanitizeUserAgent(ua, ['a.b'])).toBe('Mozilla/5.0 Chrome/146.0.0.0 axb/1 Safari/537.36')
    expect(sanitizeUserAgent(ua, ['.*', '', '   '])).toBe(ua)
  })

  it('is a no-op on a UA that has nothing to strip, and is idempotent', () => {
    expect(sanitizeUserAgent(MAC_CLEAN, NAMES)).toBe(MAC_CLEAN)
    expect(sanitizeUserAgent(sanitizeUserAgent(MAC_DEFAULT, NAMES), NAMES)).toBe(MAC_CLEAN)
  })

  it('strips a token at the very start or end and repeated tokens', () => {
    expect(sanitizeUserAgent('Electron/44 Mozilla/5.0 Chrome/146 Electron/44 Electron/44', ['Electron'])).toBe('Mozilla/5.0 Chrome/146')
  })
})
