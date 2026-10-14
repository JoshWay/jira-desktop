// Pure rules behind DialogController: what a submit may contain and which URLs each mode accepts.
// No electron imports, so it stays unit-testable.
// codex:run npm test -- tests/unit/dialogRules.test.ts
import { LOAD_ERROR_ACTIONS, PRODUCT_CHOICES } from '../../shared/dialog'
import type { LoadErrorAction, ProductChoice, UrlDialogMode } from '../../shared/dialog'
import { isInAppUrl, isNotASiteUrl, normalizeJiraUrl } from '../security/urlPolicy'
import type { NormalizeResult } from '../security/urlPolicy'

// Matches the input's maxlength; anything longer did not come from the page
export const MAX_URL_LENGTH = 2048

export const NOT_IN_APP_ERROR = 'Only Atlassian addresses, or your own Jira site, can open in a new window.'

export const NOT_A_SITE_ERROR = "That is Atlassian's own page. Enter your Jira site, such as your-team.atlassian.net."

export interface UrlSubmit {
  url: string
  // new-window only
  product?: ProductChoice
  background?: boolean
}

function isOneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value)
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

// The submit payload of an address mode as main accepts it, or null when it is malformed (never
// user error: the page cannot produce it, so the caller rejects the call instead of showing a
// message). welcome sends exactly what set-url sends.
export function parseSubmitPayload(mode: UrlDialogMode, raw: unknown): UrlSubmit | null {
  if (!isRecord(raw)) return null
  const { url, product, background } = raw
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
  if (mode !== 'new-window') return { url }
  if (!isOneOf(PRODUCT_CHOICES, product) || typeof background !== 'boolean') return null
  return { url, product, background }
}

// The load-error submit: exactly one known action, nothing else kept
// codex:run npm test -- tests/unit/dialogRules.test.ts
export function parseLoadErrorSubmit(raw: unknown): { action: LoadErrorAction } | null {
  if (!isRecord(raw) || !isOneOf(LOAD_ERROR_ACTIONS, raw.action)) return null
  return { action: raw.action }
}

// set-url and welcome accept any address normalizeJiraUrl accepts (self-hosted sites included)
// except Atlassian's login and marketing pages, which are never a site. new-window also requires
// the result to be in-app, so it can never open an arbitrary site in an app window.
// codex:run npm test -- tests/unit/dialogRules.test.ts
export function validateDialogUrl(mode: UrlDialogMode, input: string, configuredSiteUrl?: string): NormalizeResult {
  const result = normalizeJiraUrl(input)
  if (!result.ok) return result
  if (mode !== 'new-window') return isNotASiteUrl(result.url) ? { ok: false, error: NOT_A_SITE_ERROR } : result
  return isInAppUrl(result.url, configuredSiteUrl) ? result : { ok: false, error: NOT_IN_APP_ERROR }
}
