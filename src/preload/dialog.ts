// Preload for the local dialog page only (never for remote content, never session-wide). Runs
// sandboxed: it exposes exactly getInit/submit/cancel and never ipcRenderer itself. Main checks
// every call's sender (see security/localPageIpc.ts).
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
import { contextBridge, ipcRenderer } from 'electron'
import { DIALOG_CHANNELS } from '../shared/dialog'
import type { DialogAPI, DialogInit, DialogSubmitResult } from '../shared/dialog'

const dialogAPI: DialogAPI = {
  getInit: (): Promise<DialogInit> => ipcRenderer.invoke(DIALOG_CHANNELS.getInit),
  // Copy only the known fields; main validates them again
  submit: (payload): Promise<DialogSubmitResult> =>
    ipcRenderer.invoke(DIALOG_CHANNELS.submit, { url: payload.url, product: payload.product, background: payload.background }),
  cancel: (): Promise<void> => ipcRenderer.invoke(DIALOG_CHANNELS.cancel)
}

contextBridge.exposeInMainWorld('dialogAPI', dialogAPI)
