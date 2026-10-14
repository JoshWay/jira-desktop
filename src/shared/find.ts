// The contract between the find bar page (renderer), its preload and FindBarController (main).
// No electron or DOM imports: it is typechecked under both tsconfig.node.json and tsconfig.web.json.
// codex:run npm test -- tests/unit/findRules.test.ts

// Longest text the find bar searches for (main refuses longer)
export const MAX_FIND_TEXT_LENGTH = 1000

// One search request. newSession starts a new search (new or changed text); otherwise it moves to
// the next (forward) or previous match of the current one. Main maps it onto findInPage.
export interface FindQuery {
  text: string
  forward: boolean
  newSession: boolean
}

// From the target page's found-in-page events: activeMatchOrdinal is 1-based, 0 for none
export interface FindResult {
  activeMatchOrdinal: number
  matches: number
}

// Exposed by src/preload/find.ts as window.findAPI; nothing else is exposed
export interface FindAPI {
  find(query: FindQuery): Promise<void>
  // Closes the bar and clears the page's find highlight
  close(): Promise<void>
  // Match counts for the current search
  onResult(listener: (result: FindResult) => void): void
  // The bar was opened or asked for again: focus and select the input. restart is true when it had
  // been closed (main ended the search then), so the page searches its text again from the start.
  onActivate(listener: (restart: boolean) => void): void
}

export const FIND_CHANNELS = Object.freeze({
  find: 'find:query',
  close: 'find:close',
  result: 'find:result',
  activate: 'find:activate'
} as const)

// What the bar shows next to the input
// codex:run npm test -- tests/unit/findRules.test.ts
export function matchCountText(result: FindResult | null, hasQuery: boolean): string {
  if (!hasQuery || !result) return ''
  if (result.matches === 0) return 'No matches'
  return `${result.activeMatchOrdinal} of ${result.matches}`
}
