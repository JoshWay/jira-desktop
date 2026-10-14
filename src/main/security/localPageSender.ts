// The sender check behind localPageIpc.ts, on structural types only (no electron imports), so it
// is unit-testable with plain fakes. Electron's IpcMainInvokeEvent and WebContents satisfy these.
// codex:run npm test -- tests/unit/localPageSender.test.ts
import { isSameLocalPage } from './navigationPolicy'

export interface SenderContents {
  isDestroyed(): boolean
}

export interface SenderFrame {
  readonly url: string
  readonly parent: unknown
}

export interface InvokeEventLike {
  readonly sender: unknown
  readonly senderFrame: SenderFrame | null
}

export interface ExpectedPage {
  contents: SenderContents
  // The page's URL as loaded (query and hash are ignored when matching)
  pageUrl: string
}

// True only for the main frame of `page.contents` while it shows `page.pageUrl`. Any other
// webContents, a subframe, the same contents after navigating elsewhere, a destroyed contents, or
// anything that throws on access (a disposed frame does) is refused.
export function isFromLocalPage(event: InvokeEventLike, page: ExpectedPage): boolean {
  try {
    if (page.contents.isDestroyed() || event.sender !== page.contents) return false
    const frame = event.senderFrame
    if (!frame || frame.parent !== null) return false
    return isSameLocalPage(frame.url, page.pageUrl)
  } catch {
    return false
  }
}
