import { test as base, expect, _electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EscapedRequest, InterceptedRequest, Route, StubSpec } from './types'

export type { EscapedRequest, InterceptedRequest, Route, RouteResponse, StubSpec } from './types'
export { expect }

const repoRoot = resolve(__dirname, '../../..')
const interceptModule = resolve(__dirname, 'intercept-main.ts')

// The Jira site a launch is configured for unless the test says otherwise (see LaunchOptions.settings).
// Served by the interceptor like any other URL.
export const E2E_SITE_URL = 'https://e2e.atlassian.net/jira'
const DEFAULT_SETTINGS = Object.freeze({ jiraUrl: E2E_SITE_URL })

// Loopback proxy that every app session is pointed at. The interceptor answers http/https
// itself, so the only traffic that reaches this server is traffic that escaped it. Nothing is
// forwarded: the request is recorded and refused.
export class EscapeSink {
  private readonly server: Server
  private readonly sockets: Set<Socket>
  readonly port: number
  readonly escaped: EscapedRequest[]

  private constructor(server: Server, sockets: Set<Socket>, port: number, escaped: EscapedRequest[]) {
    this.server = server
    this.sockets = sockets
    this.port = port
    this.escaped = escaped
  }

  static async start(): Promise<EscapeSink> {
    const escaped: EscapedRequest[] = []
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let head = ''
      socket.on('data', (chunk) => {
        if (head.includes('\r\n')) return
        head += chunk.toString('latin1')
        const end = head.indexOf('\r\n')
        if (end === -1) return
        escaped.push({ requestLine: head.slice(0, end) })
        socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('escape sink has no port')
    return new EscapeSink(server, sockets, address.port, escaped)
  }

  // Empties and returns what escaped so far (for tests that provoke an escape on purpose)
  drain(): EscapedRequest[] {
    return this.escaped.splice(0)
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((done) => this.server.close(() => done()))
  }
}

export interface LaunchOptions {
  // Reuse an existing profile (relaunch/persistence tests); by default a fresh temp dir is used
  userDataDir?: string
  // settings.json to write into the profile before launch (replacing any there). null writes
  // nothing: with a fresh profile that is a first run (no saved site). Left out, a fresh profile
  // gets { jiraUrl: E2E_SITE_URL } and a reused userDataDir is left as it is.
  settings?: Record<string, unknown> | null
  // Routes the interceptor serves from the first request on; see Route in types.ts
  routes?: Route[]
  // Main-process stubs applied before the app's main module runs, on top of the defaults
  // (shell.openExternal, shell.openPath, dialog.showErrorBox are always recorders)
  stubs?: StubSpec[]
  env?: Record<string, string>
}

export class LaunchedApp {
  readonly electronApp: ElectronApplication
  readonly userDataDir: string
  // Snapshot of main-process state taken at close(), so it stays readable afterwards
  private final: { requests: InterceptedRequest[]; windowFocusEvents: number } | null = null

  constructor(electronApp: ElectronApplication, userDataDir: string) {
    this.electronApp = electronApp
    this.userDataDir = userDataDir
  }

  // Every http/https request the interceptor has served, in order
  async requests(): Promise<InterceptedRequest[]> {
    if (this.final) return this.final.requests
    return this.electronApp.evaluate(() => globalThis.__jiraDesktopE2E!.requests)
  }

  // How often any window gained focus (the launchApp fixture requires 0 unless headed)
  async windowFocusEvents(): Promise<number> {
    if (this.final) return this.final.windowFocusEvents
    return this.electronApp.evaluate(() => globalThis.__jiraDesktopE2E!.windowFocusEvents)
  }

  // Replaces the route table for subsequent requests
  async setRoutes(routes: Route[]): Promise<void> {
    await this.electronApp.evaluate((_, next) => {
      globalThis.__jiraDesktopE2E!.routes = next
    }, routes)
  }

  // Stubs a main-process function after launch (see StubSpec); use LaunchOptions.stubs for
  // anything the app may call during startup
  async stubMain(spec: StubSpec): Promise<void> {
    await this.electronApp.evaluate((_, next) => globalThis.__jiraDesktopE2E!.stub(next), spec)
  }

  // Arguments of every call to a stubbed function (defaults included)
  async stubCalls(moduleName: string, method: string): Promise<unknown[][]> {
    const key = `${moduleName}.${method}`
    return this.electronApp.evaluate((_, k) => globalThis.__jiraDesktopE2E!.calls[k] ?? [], key)
  }

  // Quits the app, keeping the request log readable afterwards. Safe to call twice.
  async close(): Promise<void> {
    if (this.final) return
    this.final = await this.electronApp
      .evaluate(() => ({ requests: globalThis.__jiraDesktopE2E!.requests, windowFocusEvents: globalThis.__jiraDesktopE2E!.windowFocusEvents }))
      .catch(() => ({ requests: [], windowFocusEvents: 0 }))
    await this.electronApp.close()
  }
}

// `-r` runs the interceptor in the main process before the app's main module loads
const APP_ARGS = ['-r', interceptModule, repoRoot]

function appEnv(sink: EscapeSink, userDataDir: string, opts: LaunchOptions): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...opts.env,
    JIRA_DESKTOP_E2E: '1',
    JIRA_DESKTOP_USER_DATA_DIR: userDataDir,
    JIRA_DESKTOP_E2E_SINK_PORT: String(sink.port),
    JIRA_DESKTOP_E2E_ROUTES: JSON.stringify(opts.routes ?? []),
    JIRA_DESKTOP_E2E_STUBS: JSON.stringify(opts.stubs ?? [])
  }
}

async function launch(sink: EscapeSink, userDataDir: string, opts: LaunchOptions): Promise<LaunchedApp> {
  const electronApp = await _electron.launch({ args: APP_ARGS, cwd: repoRoot, env: appEnv(sink, userDataDir, opts) })
  return new LaunchedApp(electronApp, userDataDir)
}

export interface InstanceExit {
  code: number | null
  signal: NodeJS.Signals | null
  // True when it was still running after the timeout and had to be killed
  killed: boolean
}

// Starts the app once more against `userDataDir` as a plain process (not through Playwright,
// which cannot attach to a process that quits during startup), with the same interceptor, and
// resolves when it exits. Killed if it is still running after timeoutMs.
export async function runAnotherInstance(sink: EscapeSink, userDataDir: string, timeoutMs = 30_000): Promise<InstanceExit> {
  const electronBinary = createRequire(__filename)('electron') as string
  const child = spawn(electronBinary, APP_ARGS, { cwd: repoRoot, env: appEnv(sink, userDataDir, {}), stdio: 'ignore' })
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    child.kill('SIGKILL')
  }, timeoutMs)
  return new Promise((done, fail) => {
    child.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, killed })
    })
  })
}

interface Fixtures {
  escapeSink: EscapeSink
  launchApp: (opts?: LaunchOptions) => Promise<LaunchedApp>
}

export const test = base.extend<Fixtures>({
  // One sink per test, shared by every launch in it. Teardown fails the test if anything escaped.
  escapeSink: async ({}, use, testInfo) => {
    const sink = await EscapeSink.start()
    await use(sink)
    await sink.close()
    await testInfo.attach('escaped-requests.json', { body: JSON.stringify(sink.escaped, null, 2), contentType: 'application/json' })
    expect(sink.escaped, 'requests escaped the e2e interceptor').toEqual([])
  },

  launchApp: async ({ escapeSink }, use, testInfo) => {
    const launched: LaunchedApp[] = []
    const ownedDirs = new Set<string>()
    await use(async (opts = {}) => {
      let userDataDir = opts.userDataDir
      if (!userDataDir) {
        userDataDir = await mkdtemp(join(tmpdir(), 'jira-desktop-e2e-'))
        ownedDirs.add(userDataDir)
      }
      const settings = opts.settings === undefined ? (opts.userDataDir ? null : DEFAULT_SETTINGS) : opts.settings
      if (settings) await writeFile(join(userDataDir, 'settings.json'), JSON.stringify(settings))
      const app = await launch(escapeSink, userDataDir, opts)
      launched.push(app)
      return app
    })
    const log: InterceptedRequest[][] = []
    const focusEvents: number[] = []
    for (const app of launched) {
      await app.close()
      log.push(await app.requests())
      focusEvents.push(await app.windowFocusEvents())
    }
    await testInfo.attach('intercepted-requests.json', { body: JSON.stringify(log, null, 2), contentType: 'application/json' })
    await testInfo.attach('window-focus-events.json', { body: JSON.stringify(focusEvents), contentType: 'application/json' })
    for (const dir of ownedDirs) await rm(dir, { recursive: true, force: true })
    if (process.env.JIRA_DESKTOP_E2E_HEADED !== '1') {
      expect(focusEvents.every((count) => count === 0), `a window took focus (per launch: ${focusEvents})`).toBe(true)
    }
  }
})
