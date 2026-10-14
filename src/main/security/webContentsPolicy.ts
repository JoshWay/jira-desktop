// Electron wiring for the security boundary (spec R2). Every webContents the app ever creates,
// including auth popups and windows added later, gets the same navigation, window.open and
// <webview> policy; every session gets the same permission policy. The decisions themselves live
// in navigationPolicy.ts (pure); this file only applies them.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts
import { app, session, shell } from 'electron'
import type { Event, Session, WebContents, WebPreferences } from 'electron'
import { LocalPageRegistry, decideNavigation, decideWindowOpen, hasPrivilegedPrefs, isExpectedLoadAbort, isPermissionAllowed, toExternalHref } from './navigationPolicy'
import type { PolicyContext } from './navigationPolicy'

// App-owned pages (Task 5 dialogs, the dev server). Empty until something registers.
const localPages = new LocalPageRegistry()

export function registerLocalPage(url: string): void {
  localPages.register(url)
}

// The only path to shell.openExternal: http/https/mailto, and the parsed href, never the raw string.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
export function openExternalSafely(url: string): boolean {
  const href = toExternalHref(url)
  if (!href) return false
  shell.openExternal(href).catch((error: unknown) => console.error('openExternal failed:', error))
  return true
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

// Contents that hold any privilege (see hasPrivilegedPrefs), or show a local page, may never load
// remote content. Unknown prefs fail closed.
// codex:run npm test -- tests/unit/navigationPolicy.test.ts
// The dialog (dialogs/DialogController.ts) shows a registered local page, so it is confined.
// getLastWebPreferences is undocumented (Electron's own window.open inheritance uses it), hence
// the shim; if it ever disappears every contents becomes confined and the e2e suite fails loudly.
type WithPrefs = WebContents & { getLastWebPreferences?: () => WebPreferences | null }

function isConfined(contents: WebContents): boolean {
  if (hasPrivilegedPrefs((contents as WithPrefs).getLastWebPreferences?.())) return true
  return localPages.matches(contents.getURL())
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
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...AUTH_POPUP_WEB_PREFERENCES } } }
      case 'external':
        openExternalSafely(url)
        return { action: 'deny' }
      case 'deny':
        return { action: 'deny' }
    }
  })

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
