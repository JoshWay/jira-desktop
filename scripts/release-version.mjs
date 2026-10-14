// Release tag guard for .github/workflows/release.yml (spec R5).
// A tag build must be tagged exactly `v` + package.json `version`, or the published feed
// (latest*.yml) would carry a different version than the release it sits in. Whether the release
// is a prerelease comes from the semver pre-release part of that version, not a substring of the ref.
//
// Usage: node scripts/release-version.mjs [tag]   (tag defaults to $GITHUB_REF_NAME)
// Writes `version=` and `prerelease=` to $GITHUB_OUTPUT when it is set.
// codex:run npm test -- tests/unit/releaseVersion.test.ts

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * @param {string} tag the pushed tag name, e.g. `v2.2.0` or `v2.2.0-rc.1`
 * @param {string} packageVersion package.json `version`
 * @returns {{ version: string, prerelease: boolean }}
 */
export function releaseInfo(tag, packageVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`Release tags must look like v<version>, got "${tag}"`)
  }
  const version = tag.slice(1)
  const match = SEMVER.exec(version)
  if (!match) {
    throw new Error(`Tag "${tag}" is not v followed by a semantic version`)
  }
  if (version !== packageVersion) {
    throw new Error(
      `Tag "${tag}" does not match package.json version "${packageVersion}". ` +
        `Bump package.json to ${version} (or tag v${packageVersion}) and tag again.`
    )
  }
  // Group 4 is the pre-release identifiers; build metadata (after +) never makes a prerelease
  return { version, prerelease: match[4] !== undefined }
}

function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  let info
  try {
    info = releaseInfo(tag, pkg.version)
  } catch (error) {
    console.log(`::error title=Release version mismatch::${error.message}`)
    process.exit(1)
  }
  console.log(`Releasing ${info.version} (prerelease: ${info.prerelease})`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${info.version}\nprerelease=${info.prerelease}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
