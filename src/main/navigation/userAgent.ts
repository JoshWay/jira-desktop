// The user agent the app presents (spec R4). Electron's default UA carries an `Electron/<v>` token
// and an `<app name>/<v>` token after the Chrome token; Google's sign-in refuses embedded browsers
// that advertise themselves that way, so both are dropped and the rest is Chrome's own UA.
// No electron imports, so it stays unit-testable; main.ts applies it to app.userAgentFallback.
// codex:run npm test -- tests/unit/userAgent.test.ts

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Removes every whole `<name>/<version>` product token for each of `productNames` (spaces in a
// name are removed first, as Electron does when it writes the app's token). Tokens inside the
// parenthesised platform comment, and tokens that only contain a name (`NotElectron/1`), are kept.
// codex:run npm test -- tests/unit/userAgent.test.ts
export function sanitizeUserAgent(userAgent: string, productNames: readonly string[]): string {
  const names = [...new Set(productNames.map((name) => name.replace(/\s+/g, '')).filter((name) => name !== ''))]
  if (names.length === 0) return userAgent

  const pattern = new RegExp(`^(?:${names.map(escapeRegExp).join('|')})/[^\\s()]+$`)
  // Split into whole (…) comments (an unclosed one runs to the end) and the product tokens between
  // them, so a comment's contents are never touched and no character is lost
  const parts = userAgent.match(/\([^)]*\)?|[^\s(]+/g) ?? []
  return parts.filter((part) => !pattern.test(part)).join(' ')
}
