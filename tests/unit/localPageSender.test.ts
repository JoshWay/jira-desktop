import { describe, expect, it } from 'vitest'
import { findLocalPageSender, isFromLocalPage } from '../../src/main/security/localPageSender'
import type { SenderContents, SenderFrame } from '../../src/main/security/localPageSender'

const PAGE_URL = 'file:///app/dist/renderer/dialog.html'

function contents(destroyed = false): SenderContents {
  return { isDestroyed: () => destroyed }
}

function frame(url: string, parent: unknown = null): SenderFrame {
  return { url, parent }
}

describe('isFromLocalPage', () => {
  it("accepts the expected contents' main frame on the expected page (query and hash ignored)", () => {
    const dialog = contents()
    expect(isFromLocalPage({ sender: dialog, senderFrame: frame(PAGE_URL) }, { contents: dialog, pageUrl: PAGE_URL })).toBe(true)
    expect(isFromLocalPage({ sender: dialog, senderFrame: frame(`${PAGE_URL}?again#x`) }, { contents: dialog, pageUrl: PAGE_URL })).toBe(true)
  })

  it('refuses any other contents, even on the same page', () => {
    const dialog = contents()
    expect(isFromLocalPage({ sender: contents(), senderFrame: frame(PAGE_URL) }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
    expect(isFromLocalPage({ sender: undefined, senderFrame: frame(PAGE_URL) }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
  })

  it('refuses a subframe and a missing frame', () => {
    const dialog = contents()
    expect(isFromLocalPage({ sender: dialog, senderFrame: frame(PAGE_URL, frame(PAGE_URL)) }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
    expect(isFromLocalPage({ sender: dialog, senderFrame: null }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
  })

  it('refuses the right contents once it has navigated to another page', () => {
    const dialog = contents()
    for (const url of ['https://team.atlassian.net/', 'file:///app/dist/renderer/welcome.html', 'about:blank', '']) {
      expect(isFromLocalPage({ sender: dialog, senderFrame: frame(url) }, { contents: dialog, pageUrl: PAGE_URL }), url).toBe(false)
    }
  })

  it('refuses a destroyed contents', () => {
    const dialog = contents(true)
    expect(isFromLocalPage({ sender: dialog, senderFrame: frame(PAGE_URL) }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
  })

  it('refuses, rather than throws, when the frame or contents throw on access (a disposed frame does)', () => {
    const dialog = contents()
    const disposed = {
      get url(): string { throw new Error('Render frame was disposed') },
      get parent(): unknown { throw new Error('Render frame was disposed') }
    }
    expect(isFromLocalPage({ sender: dialog, senderFrame: disposed }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
    const urlThrows = { parent: null, get url(): string { throw new Error('disposed') } }
    expect(isFromLocalPage({ sender: dialog, senderFrame: urlThrows }, { contents: dialog, pageUrl: PAGE_URL })).toBe(false)
    const broken: SenderContents = { isDestroyed: () => { throw new Error('gone') } }
    expect(isFromLocalPage({ sender: broken, senderFrame: frame(PAGE_URL) }, { contents: broken, pageUrl: PAGE_URL })).toBe(false)
  })
})

describe('findLocalPageSender', () => {
  const FIND_URL = 'file:///app/dist/renderer/find.html'

  it('returns the one open page the call comes from', () => {
    const a = { contents: contents(), pageUrl: FIND_URL, name: 'a' }
    const b = { contents: contents(), pageUrl: FIND_URL, name: 'b' }
    expect(findLocalPageSender({ sender: b.contents, senderFrame: frame(FIND_URL) }, [a, b])).toBe(b)
    expect(findLocalPageSender({ sender: a.contents, senderFrame: frame(FIND_URL) }, [a, b])).toBe(a)
  })

  it('returns null for any sender that is not one of them, as isFromLocalPage would refuse it', () => {
    const a = { contents: contents(), pageUrl: FIND_URL }
    const destroyed = { contents: contents(true), pageUrl: FIND_URL }
    expect(findLocalPageSender({ sender: contents(), senderFrame: frame(FIND_URL) }, [a])).toBeNull()
    expect(findLocalPageSender({ sender: a.contents, senderFrame: frame(FIND_URL, frame(FIND_URL)) }, [a])).toBeNull()
    expect(findLocalPageSender({ sender: a.contents, senderFrame: frame('https://team.atlassian.net/') }, [a])).toBeNull()
    expect(findLocalPageSender({ sender: destroyed.contents, senderFrame: frame(FIND_URL) }, [destroyed])).toBeNull()
    expect(findLocalPageSender({ sender: a.contents, senderFrame: frame(FIND_URL) }, [])).toBeNull()
  })
})
