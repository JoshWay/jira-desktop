// Shapes shared by the Playwright side (app.ts) and the code injected into the Electron
// main process (intercept-main.ts). Type-only: nothing here exists at runtime.

// What the interceptor answers with. `network-error` makes the request fail (net::ERR_FAILED).
export type RouteResponse =
  | { kind?: 'body'; status?: number; contentType?: string; headers?: Record<string, string>; body: string }
  | { kind: 'network-error' }

// `url` is an exact URL, or a prefix when it ends with `*` (e.g. 'https://example.atlassian.net/*').
// The first matching route wins; unmatched requests get a tiny stub HTML page.
export interface Route {
  url: string
  response: RouteResponse
}

export interface InterceptedRequest {
  url: string
  method: string
  // 'default' for session.defaultSession, 'persist:<name>' for persistent partitions, else 'in-memory'
  session: string
  servedWith: 'route' | 'stub-page' | 'network-error'
}

// A request that bypassed the interceptor and hit the escape sink (the proxy every session uses).
export interface EscapedRequest {
  // First line of what Chromium sent the proxy, e.g. 'CONNECT example.com:443 HTTP/1.1'
  requestLine: string
}

export interface E2EMainState {
  requests: InterceptedRequest[]
  routes: Route[]
  // Recorded arguments of main-process functions replaced via stubMain(), keyed 'module.method'
  calls: Record<string, unknown[][]>
}

declare global {
  // Installed by intercept-main.ts in the Electron main process; read via electronApp.evaluate
  var __jiraDesktopE2E: E2EMainState | undefined
}
