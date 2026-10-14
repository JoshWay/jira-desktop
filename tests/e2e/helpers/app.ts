import { test as base, expect, _electron } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EscapedRequest, InterceptedRequest, Route } from './types'

export type { EscapedRequest, InterceptedRequest, Route, RouteResponse } from './types'
export { expect }

const repoRoot = resolve(__dirname, '../../..')
const interceptModule = resolve(__dirname, 'intercept-main.ts')

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
  // Routes the interceptor serves from the first request on; see Route in types.ts
  routes?: Route[]
  env?: Record<string, string>
}

export class LaunchedApp {
  readonly electronApp: ElectronApplication
  readonly userDataDir: string
  private finalRequests: InterceptedRequest[] | null = null

  constructor(electronApp: ElectronApplication, userDataDir: string) {
    this.electronApp = electronApp
    this.userDataDir = userDataDir
  }

  // Every http/https request the interceptor has served, in order
  async requests(): Promise<InterceptedRequest[]> {
    if (this.finalRequests) return this.finalRequests
    return this.electronApp.evaluate(() => globalThis.__jiraDesktopE2E!.requests)
  }

  // Replaces the route table for subsequent requests
  async setRoutes(routes: Route[]): Promise<void> {
    await this.electronApp.evaluate((_, next) => {
      globalThis.__jiraDesktopE2E!.routes = next
    }, routes)
  }

  // Replaces electron[moduleName][method] in the main process with a recorder that returns
  // `returnValue` (wrapped in a Promise when `async`). Read the calls back with stubCalls().
  async stubMain(moduleName: string, method: string, returnValue?: unknown, opts: { async?: boolean } = {}): Promise<void> {
    await this.electronApp.evaluate((electron, args) => {
      const state = globalThis.__jiraDesktopE2E!
      const key = `${args.moduleName}.${args.method}`
      const target = (electron as unknown as Record<string, Record<string, unknown>>)[args.moduleName]
      state.calls[key] = []
      target[args.method] = (...callArgs: unknown[]) => {
        state.calls[key].push(callArgs)
        return args.async ? Promise.resolve(args.returnValue) : args.returnValue
      }
    }, { moduleName, method, returnValue, async: opts.async ?? false })
  }

  async stubCalls(moduleName: string, method: string): Promise<unknown[][]> {
    const key = `${moduleName}.${method}`
    return this.electronApp.evaluate((_, k) => globalThis.__jiraDesktopE2E!.calls[k] ?? [], key)
  }

  // Quits the app, keeping the request log readable afterwards. Safe to call twice.
  async close(): Promise<void> {
    if (this.finalRequests) return
    this.finalRequests = await this.requests().catch(() => [])
    await this.electronApp.close()
  }
}

async function launch(sink: EscapeSink, userDataDir: string, opts: LaunchOptions): Promise<LaunchedApp> {
  const electronApp = await _electron.launch({
    // `-r` runs the interceptor in the main process before the app's main module loads
    args: ['-r', interceptModule, repoRoot],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...opts.env,
      JIRA_DESKTOP_E2E: '1',
      JIRA_DESKTOP_USER_DATA_DIR: userDataDir,
      JIRA_DESKTOP_E2E_SINK_PORT: String(sink.port),
      JIRA_DESKTOP_E2E_ROUTES: JSON.stringify(opts.routes ?? [])
    }
  })
  return new LaunchedApp(electronApp, userDataDir)
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
      const app = await launch(escapeSink, userDataDir, opts)
      launched.push(app)
      return app
    })
    const log: InterceptedRequest[][] = []
    for (const app of launched) {
      await app.close()
      log.push(await app.requests())
    }
    await testInfo.attach('intercepted-requests.json', { body: JSON.stringify(log, null, 2), contentType: 'application/json' })
    for (const dir of ownedDirs) await rm(dir, { recursive: true, force: true })
  }
})
