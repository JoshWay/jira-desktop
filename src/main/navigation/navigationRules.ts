// Pure rules behind browser-parity navigation (spec R4): where Back / Forward may go, which page
// address may be copied or opened in the browser, the accelerators, and which swipe / app-command
// means Back or Forward. No electron imports, so it stays unit-testable; NavigationController.ts
// does the Electron wiring.
// codex:run npm test -- tests/unit/navigationRules.test.ts

export type HistoryStep = -1 | 1
export type NavigationCommand = 'back' | 'forward'

function webUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

// The address of a page a user can share: an http(s) page that is not one of the app's own local
// pages. Returns its parsed href, or null (the placeholder, about:blank, data:, error pages...).
// codex:run npm test -- tests/unit/navigationRules.test.ts
export function shareableUrl(url: string, isLocalPage: (url: string) => boolean): string | null {
  const parsed = webUrl(url)
  if (!parsed || isLocalPage(url)) return null
  return parsed.href
}

export interface HistoryRules {
  isLocalPage: (url: string) => boolean
  // Whether the navigation policy lets a content window show `url` now (the configured site may
  // have changed since the entry was made)
  isAllowed: (url: string) => boolean
}

// The history index Back (step -1) or Forward (step 1) goes to: the nearest entry that way that is
// a shareable web page the policy still allows, skipping the placeholder and the about:blank step
// main takes off it (main may load those, but going back through history would otherwise land on
// them). History navigation never passes through will-navigate, so this is the policy check for
// it. null when there is none, which is also when the menu item is disabled.
// codex:run npm test -- tests/unit/navigationRules.test.ts
export function historyTarget(entries: readonly string[], activeIndex: number, step: HistoryStep, rules: HistoryRules): number | null {
  if (!Number.isInteger(activeIndex) || activeIndex < 0 || activeIndex >= entries.length) return null
  for (let index = activeIndex + step; index >= 0 && index < entries.length; index += step) {
    const url = entries[index]
    if (shareableUrl(url, rules.isLocalPage) !== null && rules.isAllowed(url)) return index
  }
  return null
}

// Back / Forward accelerators: Cmd+[ / Cmd+] on macOS, Alt+Left / Alt+Right elsewhere
export function navigationAccelerators(platform: string): { back: string; forward: string } {
  return platform === 'darwin' ? { back: 'CmdOrCtrl+[', forward: 'CmdOrCtrl+]' } : { back: 'Alt+Left', forward: 'Alt+Right' }
}

// A macOS three-finger swipe (BrowserWindow 'swipe') or a Windows/Linux mouse or keyboard
// app-command (BrowserWindow 'app-command') as Back / Forward; anything else is ignored.
// codex:run npm test -- tests/unit/navigationRules.test.ts
export function navigationCommand(event: 'swipe' | 'app-command', value: string): NavigationCommand | null {
  if (event === 'swipe') {
    if (value === 'left') return 'back'
    if (value === 'right') return 'forward'
    return null
  }
  if (value === 'browser-backward') return 'back'
  if (value === 'browser-forward') return 'forward'
  return null
}
