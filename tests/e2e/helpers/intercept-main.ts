// Injected into the Electron main process with `-r` by app.ts, so it runs before the app's own
// main module. Electron's Node strips the TypeScript types, so keep this file to erasable syntax.
//
// It makes e2e runs offline:
//   1. every session (default and partitions) answers http/https itself via protocol.handle,
//      so no request served by the app's normal flow reaches the network stack;
//   2. every session's proxy is the test's escape sink on loopback, so anything that still
//      bypasses (1) lands in the sink, is recorded as escaped, and never leaves the machine;
//   3. functions that hand work to the OS (opening the real browser or a file) or block on a
//      modal are replaced with recorders before the app's code runs; see DEFAULT_STUBS;
//   4. Chromium's own OS hand-off for schemes it cannot load (smb:, vscode:, ...) is refused on
//      every session whatever permission handler the app installs; see guardExternalProtocols.
//
// It also keeps runs off the user's screen (see stayOutOfTheWay): no Dock icon or menu-bar
// takeover on macOS, every window is made unable to take focus the moment it is created, shown
// inactive, fully transparent, click-through and pushed off-screen, and focus()/moveTop() do
// nothing. Windows really are shown (isVisible() is true), so they are not background-throttled.
// Set JIRA_DESKTOP_E2E_HEADED=1 to get normal, visible, focusable windows for debugging.
import * as electron from 'electron'
import { app, BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { basename } from 'node:path'
import type { E2EMainState, InterceptedRequest, Route, RouteResponse, StubSpec } from './types'

if (process.env.JIRA_DESKTOP_E2E !== '1') {
  throw new Error('intercept-main must only be loaded with JIRA_DESKTOP_E2E=1')
}

const sinkPort = Number(process.env.JIRA_DESKTOP_E2E_SINK_PORT)
if (!Number.isInteger(sinkPort) || sinkPort <= 0) {
  throw new Error('JIRA_DESKTOP_E2E_SINK_PORT must be the escape sink port')
}

// Chromium switches must be set before 'ready'. `<-loopback>` removes the implicit loopback
// bypass so even localhost traffic is visible to the sink; the resolver rule means a request
// that somehow skipped the proxy still cannot resolve a hostname.
app.commandLine.appendSwitch('proxy-server', `http://127.0.0.1:${sinkPort}`)
app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>')
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1')
// Chromium's component updater phones home (redirector.gvt1.com) on Linux CI runners. It is
// browser background traffic, not the app's; switch it off so the sink stays strict for the rest.
// codex:run npm run test:e2e -- tests/e2e/harness.spec.ts
app.commandLine.appendSwitch('disable-component-update')
// Capture devices are Chromium's fakes, so a media-permission regression can never open the real
// microphone or camera or raise a macOS privacy prompt. Deliberately NOT use-fake-ui-for-media-stream:
// that auto-accepts and would bypass the app's permission handler the media tests assert on.
// codex:run npm run test:e2e -- tests/e2e/security.spec.ts tests/e2e/harness.spec.ts
app.commandLine.appendSwitch('use-fake-device-for-media-stream')

const headed = process.env.JIRA_DESKTOP_E2E_HEADED === '1'

function keepOffScreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // macOS clamps positions so a sliver stays on a display; opacity 0 + click-through hide that
  win.setPosition(-32000, 32000)
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
}

function stayOutOfTheWay(): void {
  // Allowed before 'ready' (verified on Electron 44): no Dock icon, no menu bar, no activation
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')

  const proto = BrowserWindow.prototype
  proto.show = function (this: BrowserWindow) {
    this.showInactive()
    keepOffScreen(this)
  }
  proto.focus = function () {}
  proto.moveTop = function () {}
  // Every window, including window.open children that Electron constructs internally. This event
  // fires inside the constructor, before the native show that a window created with the default
  // show: true gets (and options like center: true are applied after it too). With another app
  // frontmost, that native show made the window key (browser-window-focus), and closing a key
  // window handed key status to the next one; a non-focusable window can do neither.
  //
  // The constructor also places the window after this event: center: true, centring when no x/y
  // is given, cascading for window.open children. That emits 'move' synchronously, inside the
  // constructor and before its native show, and no 'show' event follows that show. So until the
  // constructor has returned (the first microtask after this event), every move it makes is
  // undone as it happens, which keeps the native show off-screen too; then it is pushed off once
  // more for platforms whose placement emits no synchronous 'move'.
  // codex:run npm run test:e2e -- tests/e2e/harness.spec.ts
  app.on('browser-window-created', (_, win) => {
    state.createdBounds[win.id] = win.getBounds()
    win.setFocusable(false)
    keepOffScreen(win)
    let moving = false
    const undoConstructorMove = (): void => {
      if (moving) return
      // Where the constructor put it (recorded for tests before it is undone)
      state.createdBounds[win.id] = win.getBounds()
      moving = true
      try {
        keepOffScreen(win)
      } finally {
        moving = false
      }
    }
    win.on('move', undoConstructorMove)
    queueMicrotask(() => {
      win.off('move', undoConstructorMove)
      keepOffScreen(win)
    })
    win.on('show', () => keepOffScreen(win))
  })
}

if (!headed) stayOutOfTheWay()

// Always on: the real versions would open the user's browser or files (traffic the sink cannot
// see) or block the main process on a modal until the test times out.
const DEFAULT_STUBS: StubSpec[] = [
  { module: 'shell', method: 'openExternal', async: true },
  { module: 'shell', method: 'openPath', returnValue: '', async: true },
  { module: 'dialog', method: 'showErrorBox' }
]

const state: E2EMainState = {
  requests: [],
  routes: JSON.parse(process.env.JIRA_DESKTOP_E2E_ROUTES ?? '[]') as Route[],
  calls: {},
  windowFocusEvents: 0,
  createdBounds: {},
  stub
}
globalThis.__jiraDesktopE2E = state

function stub(spec: StubSpec): void {
  const target = (electron as unknown as Record<string, Record<string, unknown> | undefined>)[spec.module]
  if (!target || typeof target[spec.method] !== 'function') {
    throw new Error(`cannot stub electron.${spec.module}.${spec.method}: not a function`)
  }
  const key = `${spec.module}.${spec.method}`
  const calls: unknown[][] = (state.calls[key] = [])
  target[spec.method] = (...args: unknown[]) => {
    calls.push(args)
    return spec.async ? Promise.resolve(spec.returnValue) : spec.returnValue
  }
}

// Launch-time stubs (LaunchOptions.stubs) are applied after the defaults so they can override them
const launchStubs = JSON.parse(process.env.JIRA_DESKTOP_E2E_STUBS ?? '[]') as StubSpec[]
for (const spec of [...DEFAULT_STUBS, ...launchStubs]) stub(spec)

function findRoute(url: string): Route | undefined {
  return state.routes.find((route) =>
    route.url.endsWith('*') ? url.startsWith(route.url.slice(0, -1)) : url === route.url
  )
}

function stubPage(url: string): RouteResponse {
  const host = new URL(url).host.replace(/[^a-z0-9.:-]/gi, '')
  return { body: `<!doctype html><title>E2E stub</title><p>e2e stub for ${host}</p>` }
}

function sessionLabel(ses: Session): string {
  if (ses === session.defaultSession) return 'default'
  return ses.storagePath ? `persist:${basename(ses.storagePath)}` : 'in-memory'
}

function respond(request: Request, ses: Session): Response {
  const route = findRoute(request.url)
  const response = route?.response ?? stubPage(request.url)
  const servedWith: InterceptedRequest['servedWith'] =
    response.kind === 'network-error' ? 'network-error' : route ? 'route' : 'stub-page'
  state.requests.push({ url: request.url, method: request.method, session: sessionLabel(ses), servedWith })

  if (response.kind === 'network-error') return Response.error()
  return new Response(response.body, {
    status: response.status ?? 200,
    headers: { 'content-type': response.contentType ?? 'text/html; charset=utf-8', ...response.headers }
  })
}

// A navigation to a scheme Chromium cannot load goes straight to the OS once the session grants
// the 'openExternal' permission (Electron grants it when no handler is set), bypassing the
// shell.openExternal recorder. So on every session that grant is always refused. The app's own
// handler still decides first, and its verdict is recorded with the URL as [externalURL, granted]
// (granted is true when no handler is set, Electron's default); read it with
// stubCalls('permission', 'openExternal').
function guardExternalProtocols(ses: Session): void {
  type Handler = Parameters<Session['setPermissionRequestHandler']>[0]
  const setHandler = ses.setPermissionRequestHandler.bind(ses)
  const wrap = (handler: Handler): NonNullable<Handler> => (contents, permission, callback, details) => {
    if (permission !== 'openExternal') {
      if (handler) handler(contents, permission, callback, details)
      else callback(true)
      return
    }
    const externalURL = 'externalURL' in details ? details.externalURL : undefined
    const refuse = (appGranted: boolean): void => {
      ;(state.calls['permission.openExternal'] ??= []).push([externalURL, appGranted])
      callback(false)
    }
    if (handler) handler(contents, permission, refuse, details)
    else refuse(true)
  }
  ses.setPermissionRequestHandler = (handler) => setHandler(wrap(handler))
  setHandler(wrap(null))
}

const intercepted = new WeakSet<Session>()
function intercept(ses: Session): void {
  if (intercepted.has(ses)) return
  intercepted.add(ses)
  guardExternalProtocols(ses)
  for (const scheme of ['https', 'http']) {
    ses.protocol.handle(scheme, (request) => respond(request, ses))
  }
}

app.on('browser-window-focus', () => {
  state.windowFocusEvents++
})

// Partition sessions (e.g. WindowManager's) are created lazily; intercept them as they appear,
// before any request can be made on them.
app.on('session-created', intercept)
// Registered before the app's own whenReady callbacks, so it runs before the first loadURL.
void app.whenReady().then(() => intercept(session.defaultSession))
