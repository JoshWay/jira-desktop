// Pure rules for what the main window loads (spec R3): which saved site URL may be loaded at
// startup, which failed loads show the error view, and what Retry loads. No electron imports, so
// it stays unit-testable; main passes in the local-page check from security/webContentsPolicy.ts.
// codex:run npm test -- tests/unit/mainWindowRules.test.ts
import { isAuthUrl, isInAppUrl, isNotASiteUrl, normalizeJiraUrl } from '../security/urlPolicy'

// Chromium's net::ERR_ABORTED: a load that was cancelled or superseded, not a failure
export const ERR_ABORTED = -3

// What the error view shows of a failed URL / error description (the real URL is still retried)
export const MAX_FAILED_URL_LENGTH = 2048
const MAX_ERROR_DESCRIPTION_LENGTH = 200

export interface LoadFailure {
  // Shown as text only
  failedUrl: string
  errorDescription: string
  // What Retry loads; undefined when there is nothing safe to retry (Retry then asks for a URL)
  retryUrl?: string
}

// settings.json is outside the app's control, and main's own loadURL bypasses the navigation
// policy, so the saved URL is re-validated as the dialog validates input: it must normalize to an
// http(s) site (no file:, javascript:, credentials...), must not be Atlassian's login or marketing
// page, and must not be one of the app's own local pages. Returns the normalized URL to load, or
// undefined (first-run setup).
// codex:run npm test -- tests/unit/mainWindowRules.test.ts
export function resolveSavedSiteUrl(raw: unknown, isLocalPage: (url: string) => boolean): string | undefined {
  if (typeof raw !== 'string') return undefined
  const result = normalizeJiraUrl(raw)
  if (!result.ok) return undefined
  // http(s) with a host, by the same rule that makes the configured site in-app
  if (!isInAppUrl(result.url, result.url) || isNotASiteUrl(result.url)) return undefined
  return isLocalPage(result.url) ? undefined : result.url
}

function isRemotePage(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

// A main-frame load of a remote page that failed for real. Aborted loads (superseded, stopped,
// turned into a download, or a redirect the policy prevented) are not failures, and the app's own
// pages never show the error view (which would loop if the placeholder itself failed).
// codex:run npm test -- tests/unit/mainWindowRules.test.ts
export function shouldShowLoadError(errorCode: number, isMainFrame: boolean, url: string, isLocalPage: (url: string) => boolean): boolean {
  if (!isMainFrame || errorCode === ERR_ABORTED) return false
  return isRemotePage(url) && !isLocalPage(url)
}

// Shown in the load-error view when the main window's load was cancelled with nothing to show:
// the policy sent a redirect (typically an SSO sign-in host it does not know) to the browser, or
// refused it. Not a connection problem, so it says what happened instead of ERR_ABORTED.
export const STRANDED_LOAD_DESCRIPTION = 'it redirected to a page that does not open in Jira Desktop; a sign-in page may have opened in your browser'

// After a site load was aborted: true when the main window is left with nothing remote committed
// (its URL is '', about:blank or one of the app's local pages) and no other load under way. The
// policy cancels a redirect it hands to the browser this way, and without the load-error view the
// window would stay blank (or, at startup, hidden: nothing ever paints). A load superseded by a
// newer one is not stranded (that one is still loading), nor is one from a page already showing.
// codex:run npm test -- tests/unit/mainWindowRules.test.ts
export function isStranded(committedUrl: string, isLoading: boolean, isLocalPage: (url: string) => boolean): boolean {
  if (isLoading) return false
  return committedUrl === '' || committedUrl === 'about:blank' || isLocalPage(committedUrl)
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Retry loads the failed URL only when the navigation policy would let the main window go there
// itself (in-app or an auth page); otherwise it loads the configured site.
// codex:run npm test -- tests/unit/mainWindowRules.test.ts
export function describeLoadFailure(failedUrl: string, errorDescription: string, siteUrl: string | undefined): LoadFailure {
  const retryUrl = isInAppUrl(failedUrl, siteUrl) || isAuthUrl(failedUrl) ? failedUrl : siteUrl
  const failure: LoadFailure = {
    failedUrl: cap(failedUrl, MAX_FAILED_URL_LENGTH),
    errorDescription: cap(errorDescription, MAX_ERROR_DESCRIPTION_LENGTH)
  }
  if (retryUrl !== undefined) failure.retryUrl = retryUrl
  return failure
}
