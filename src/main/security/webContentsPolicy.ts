// Electron wiring for the security boundary (spec R2). Every webContents the app ever creates,
// including auth popups and windows added later, gets the same navigation, window.open and
// <webview> policy; every session gets the same permission policy. The decisions themselves live
// in navigationPolicy.ts (pure); this file only applies them.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
import { app, session, shell } from 'electron'
import type { Event, Session, WebContents, WebPreferences } from 'electron'
import { LocalPageRegistry, decideNavigation, decideWindowOpen, isConfinedContents, isExpectedLoadAbort, isPermissionAllowed, toExternalHref } from './navigationPolicy'
import type { PolicyContext } from './navigationPolicy'
import { DropLog, TokenBucket } from './rateLimit'

// App-owned pages (Task 5 dialogs, the dev server). Empty until something registers.
const localPages = new LocalPageRegistry()

export function registerLocalPage(url: string): void {
  localPages.register(url)
}

// True for a URL of a registered local page (same matching the navigation policy uses)
export function isLocalPageUrl(url: string): boolean {
  return localPages.matches(url)
}

// Remote content can call window.open or navigate in a loop with no user gesture (Electron has no
// popup blocker), and every external open is a browser tab or a mail compose window. One app-wide
// budget, whoever asks: a short burst, then about one a second; the rest are dropped and logged.
const EXTERNAL_OPEN_BURST = 3
const EXTERNAL_OPENS_PER_SECOND = 1
const externalOpens = new TokenBucket({ burst: EXTERNAL_OPEN_BURST, refillPerSecond: EXTERNAL_OPENS_PER_SECOND })
const externalDrops = new DropLog('openExternal rate limit')

// The only path to shell.openExternal: http/https/mailto, and the parsed href, never the raw string.
// False when the URL is refused or the open was dropped by the rate limit. The rate limit is for
// page-driven opens only: a user's own menu action never draws from (or is refused by) the bucket.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts tests/unit/rateLimit.test.ts
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts tests/e2e/navigation.spec.ts
export function openExternalSafely(url: string, { userInitiated = false }: { userInitiated?: boolean } = {}): boolean {
  const href = toExternalHref(url)
  if (!href) return false
  if (!userInitiated && !externalOpens.tryTake()) {
    externalDrops.drop(href)
    return false
  }
  externalDrops.pass()
  shell.openExternal(href).catch((error: unknown) => console.error('openExternal failed:', error))
  return true
}

// Every auth-host window.open becomes a real window, and each popup gets this same policy, so a
// popup can open more popups: the cap is app-wide, never per opener, and counts chained popups.
// A popup holds a slot from the moment its window.open is allowed until its contents is destroyed.
const MAX_LIVE_AUTH_POPUPS = 3
const liveAuthPopups = new Set<WebContents>()
const authPopupDrops = new DropLog('auth popup cap')

// Allowed by the handler, window not created yet. Electron 44 creates the window before the next
// window.open reaches any handler, so this is at most one; it keeps the cap exact if creation ever
// becomes asynchronous. A reservation no window claims (the opener died first) expires, so a lost
// window cannot hold a slot for good. FIFO: a created window claims the oldest reservation.
const AUTH_POPUP_RESERVATION_MS = 10_000
const reservations: Array<() => void> = []

// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
function reserveAuthPopup(url: string): boolean {
  if (liveAuthPopups.size + reservations.length >= MAX_LIVE_AUTH_POPUPS) {
    authPopupDrops.drop(url)
    return false
  }
  authPopupDrops.pass()
  const release = (): void => {
    clearTimeout(timer)
    const index = reservations.indexOf(release)
    if (index !== -1) reservations.splice(index, 1)
  }
  const timer = setTimeout(release, AUTH_POPUP_RESERVATION_MS)
  reservations.push(release)
  return true
}

// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
function trackAuthPopup(popup: WebContents): void {
  reservations[0]?.()
  if (popup.isDestroyed()) return
  liveAuthPopups.add(popup)
  popup.once('destroyed', () => liveAuthPopups.delete(popup))
}

// Forced onto SSO popups so they can never inherit anything from their opener
const AUTH_POPUP_WEB_PREFERENCES: WebPreferences = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false
})

// Windows the app itself creates with a preload (the dialog now, Task 7's local pages later). This
// is the primary privilege signal: Electron 44 has no documented per-contents preload getter.
const privilegedContents = new WeakSet<WebContents>()

// Call right after creating any window that has a preload, before it loads anything. It is then
// confined to local pages for its whole life, whatever it shows.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
export function registerPrivilegedContents(contents: WebContents): void {
  privilegedContents.add(contents)
}

// Contents that hold any privilege, or show a local page, may never load remote content.
// Beyond the registry, as defence in depth: getLastWebPreferences is undocumented (Electron's own
// window.open inheritance uses it) and Electron 44 leaves the per-window `preload` out of it, so
// the preload comes from _getPreloadScript (undocumented too; Electron's sandboxed preload loader
// uses it). Missing getters, unknown prefs and getters that throw all mean confined.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
type WithInternals = WebContents & {
  getLastWebPreferences?: () => WebPreferences | null
  _getPreloadScript?: () => { filePath?: string } | null
}

function preloadOf(contents: WithInternals): string | undefined {
  if (typeof contents._getPreloadScript !== 'function') return 'unknown'
  const script = contents._getPreloadScript()
  return script ? (script.filePath ?? 'unknown') : undefined
}

function isConfined(contents: WebContents): boolean {
  const internals = contents as WithInternals
  return isConfinedContents(
    {
      registered: privilegedContents.has(contents),
      prefs: () => internals.getLastWebPreferences?.(),
      preload: () => preloadOf(internals),
      url: () => contents.getURL()
    },
    (url) => localPages.matches(url)
  )
}

// codex:run npm test -- tests/unit/navigationPolicy.test.ts
function logLoadFailure(error: unknown): void {
  if (isExpectedLoadAbort(error)) return
  console.error('in-app window.open load failed:', error)
}

function applyContentsPolicy(contents: WebContents, getConfiguredSiteUrl: () => string | undefined): void {
  const context = (): PolicyContext => ({ siteUrl: getConfiguredSiteUrl(), isLocalPage: (url) => localPages.matches(url) })

  // codex:run npm run test:e2e -- tests/e2e/security.spec.ts
  contents.setWindowOpenHandler(({ url }) => {
    switch (decideWindowOpen(url, isConfined(contents), context())) {
      case 'load-in-opener':
        // Current UX: in-app links that ask for a new window open in the window that asked
        setImmediate(() => {
          if (!contents.isDestroyed()) contents.loadURL(url).catch(logLoadFailure)
        })
        return { action: 'deny' }
      case 'auth-popup':
        if (!reserveAuthPopup(url)) return { action: 'deny' }
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...AUTH_POPUP_WEB_PREFERENCES } } }
      case 'external':
        openExternalSafely(url)
        return { action: 'deny' }
      case 'deny':
        return { action: 'deny' }
    }
  })

  // Only auth popups are ever allowed, so every window this contents creates is one
  contents.on('did-create-window', (win) => trackAuthPopup(win.webContents))

  // codex:run npm run test:e2e -- tests/e2e/security.spec.ts
  const guard = (event: Event<{ url: string; isMainFrame: boolean }>): void => {
    if (!event.isMainFrame) return
    const decision = decideNavigation(event.url, isConfined(contents), context())
    if (decision === 'allow') return
    event.preventDefault()
    if (decision === 'external') openExternalSafely(event.url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)

  contents.on('will-attach-webview', (event) => event.preventDefault())
}

// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
function applySessionPolicy(ses: Session, getConfiguredSiteUrl: () => string | undefined): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, contents.getURL(), getConfiguredSiteUrl()))
  })
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const embedding = details.embeddingOrigin ?? contents?.getURL()
    return isPermissionAllowed(permission, requestingOrigin, embedding, getConfiguredSiteUrl())
  })
  ses.setDevicePermissionHandler(() => false)
}

let installed = false

// Call once, before 'ready'. getConfiguredSiteUrl returns the user's Jira site (in-app by exact origin).
export function installWebContentsPolicy(getConfiguredSiteUrl: () => string | undefined): void {
  if (installed) throw new Error('installWebContentsPolicy must only be called once')
  installed = true

  app.on('web-contents-created', (_event, contents) => applyContentsPolicy(contents, getConfiguredSiteUrl))

  const secured = new WeakSet<Session>()
  const secure = (ses: Session): void => {
    if (secured.has(ses)) return
    secured.add(ses)
    applySessionPolicy(ses, getConfiguredSiteUrl)
  }
  app.on('session-created', secure)
  void app.whenReady().then(() => secure(session.defaultSession))
}
