// Injected into the Electron main process with `-r` by app.ts, so it runs before the app's own
// main module. Electron's Node strips the TypeScript types, so keep this file to erasable syntax.
//
// It makes e2e runs offline:
//   1. every session (default and partitions) answers http/https itself via protocol.handle,
//      so no request served by the app's normal flow reaches the network stack;
//   2. every session's proxy is the test's escape sink on loopback, so anything that still
//      bypasses (1) lands in the sink, is recorded as escaped, and never leaves the machine.
import { app, session } from 'electron'
import type { Session } from 'electron'
import { basename } from 'node:path'
import type { E2EMainState, InterceptedRequest, Route, RouteResponse } from './types'

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

const state: E2EMainState = {
  requests: [],
  routes: JSON.parse(process.env.JIRA_DESKTOP_E2E_ROUTES ?? '[]') as Route[],
  calls: {}
}
globalThis.__jiraDesktopE2E = state

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

const intercepted = new WeakSet<Session>()
function intercept(ses: Session): void {
  if (intercepted.has(ses)) return
  intercepted.add(ses)
  for (const scheme of ['https', 'http']) {
    ses.protocol.handle(scheme, (request) => respond(request, ses))
  }
}

// Partition sessions (e.g. WindowManager's) are created lazily; intercept them as they appear,
// before any request can be made on them.
app.on('session-created', intercept)
// Registered before the app's own whenReady callbacks, so it runs before the first loadURL.
void app.whenReady().then(() => intercept(session.defaultSession))
