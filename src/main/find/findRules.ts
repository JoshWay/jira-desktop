// Pure rules behind the find bar (spec R4): validating the page's requests, the match counts
// passed back to it, and where the bar sits. No electron imports, so it stays unit-testable;
// FindBarController.ts does the Electron wiring.
// codex:run npm test -- tests/unit/findRules.test.ts
import { MAX_FIND_TEXT_LENGTH } from '../../shared/find'
import type { FindQuery, FindResult } from '../../shared/find'

export const FIND_BAR_SIZE = Object.freeze({ width: 380, height: 44, margin: 16 })

// The find bar's request, from IPC (untrusted): exactly a string of bounded length and two
// booleans, copied field by field. Anything else, including an object whose getters throw, is null.
// codex:run npm test -- tests/unit/findRules.test.ts
export function parseFindQuery(raw: unknown): FindQuery | null {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const { text, forward, newSession } = raw as Record<string, unknown>
    if (typeof text !== 'string' || text.length > MAX_FIND_TEXT_LENGTH) return null
    if (typeof forward !== 'boolean' || typeof newSession !== 'boolean') return null
    return { text, forward, newSession }
  } catch {
    return null
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

// A found-in-page result as the bar shows it: non-negative integers, the ordinal never past the count
// codex:run npm test -- tests/unit/findRules.test.ts
export function toFindResult(result: { activeMatchOrdinal?: unknown; matches?: unknown }): FindResult {
  const matches = count(result.matches)
  return { activeMatchOrdinal: Math.min(count(result.activeMatchOrdinal), matches), matches }
}

// Top right of the content area, never wider than it nor off its left edge
// codex:run npm test -- tests/unit/findRules.test.ts
export function findBarBounds(content: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const width = Math.max(0, Math.min(FIND_BAR_SIZE.width, content.width))
  const x = Math.max(0, content.width - width - FIND_BAR_SIZE.margin)
  return { x, y: 0, width, height: FIND_BAR_SIZE.height }
}
