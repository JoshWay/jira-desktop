// IPC for app-owned local pages (spec R2: every handler checks the sender is the expected local
// window). A local page is a sandboxed, isolated window with its own minimal preload showing one
// file from the app bundle (or the dev server), registered with registerLocalPage and
// registerPrivilegedContents; see dialogs/DialogController.ts for the pattern.
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { isFromLocalPage } from './localPageSender'

export interface LocalPage {
  contents: WebContents
  // The page's URL as loaded (query and hash are ignored when matching)
  pageUrl: string
}

// Registers `channel` once. Each call is answered only when `currentPage()` is open and the call
// comes from its main frame (see isFromLocalPage); otherwise the invoke rejects. `args` are
// untrusted and the handler validates them.
// codex:run npm test -- tests/unit/localPageSender.test.ts
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
export function handleFromLocalPage<P extends LocalPage, R>(
  channel: string,
  currentPage: () => P | null,
  handler: (page: P, ...args: unknown[]) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const page = currentPage()
    if (!page || !isFromLocalPage(event, page)) throw new Error(`${channel}: sender is not the expected local page`)
    return handler(page, ...args)
  })
}
