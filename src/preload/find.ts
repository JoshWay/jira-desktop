// Preload for the local find bar page only (never for remote content, never session-wide). Runs
// sandboxed: it exposes exactly find/close/onResult/onActivate and never ipcRenderer or its events
// themselves. Main checks every call's sender (see security/localPageIpc.ts).
// codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
import { contextBridge, ipcRenderer } from 'electron'
import { FIND_CHANNELS } from '../shared/find'
import type { FindAPI, FindResult } from '../shared/find'

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

const findAPI: FindAPI = {
  // Copy only the known fields; main validates them again
  find: (query): Promise<void> =>
    ipcRenderer.invoke(FIND_CHANNELS.find, {
      text: String(query.text),
      forward: query.forward === true,
      newSession: query.newSession === true
    }),
  close: (): Promise<void> => ipcRenderer.invoke(FIND_CHANNELS.close),
  onResult: (listener): void => {
    ipcRenderer.on(FIND_CHANNELS.result, (_event, raw: Partial<FindResult> | null) => {
      listener({ activeMatchOrdinal: count(raw?.activeMatchOrdinal), matches: count(raw?.matches) })
    })
  },
  onActivate: (listener): void => {
    ipcRenderer.on(FIND_CHANNELS.activate, (_event, restart: unknown) => listener(restart === true))
  }
}

contextBridge.exposeInMainWorld('findAPI', findAPI)
