// Pure rules behind DialogController: what a submit may contain and which URLs each mode accepts.
// No electron imports, so it stays unit-testable.
// codex:run npm test -- tests/unit/dialogRules.test.ts
import { PRODUCT_CHOICES } from '../../shared/dialog'
import type { DialogMode, DialogSubmitPayload, ProductChoice } from '../../shared/dialog'
import { isInAppUrl, normalizeJiraUrl } from '../security/urlPolicy'
import type { NormalizeResult } from '../security/urlPolicy'

// Matches the input's maxlength; anything longer did not come from the page
export const MAX_URL_LENGTH = 2048

export const NOT_IN_APP_ERROR = 'Only Atlassian addresses, or your own Jira site, can open in a new window.'

function isProductChoice(value: unknown): value is ProductChoice {
  return typeof value === 'string' && (PRODUCT_CHOICES as readonly string[]).includes(value)
}

// The submit payload as main accepts it, or null when it is malformed (never user error: the page
// cannot produce it, so the caller rejects the call instead of showing a message).
export function parseSubmitPayload(mode: DialogMode, raw: unknown): DialogSubmitPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { url, product, background } = raw as Record<string, unknown>
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
  if (mode === 'set-url') return { url }
  if (!isProductChoice(product) || typeof background !== 'boolean') return null
  return { url, product, background }
}

// set-url accepts any address normalizeJiraUrl accepts (self-hosted sites included). new-window
// also requires the result to be in-app, so it can never open an arbitrary site in an app window.
export function validateDialogUrl(mode: DialogMode, input: string, configuredSiteUrl?: string): NormalizeResult {
  const result = normalizeJiraUrl(input)
  if (!result.ok || mode === 'set-url') return result
  return isInAppUrl(result.url, configuredSiteUrl) ? result : { ok: false, error: NOT_IN_APP_ERROR }
}
