// macOS update feed check for .github/workflows/release.yml ("Verify the shipped macOS apps").
// latest-mac.yml is what installed Mac copies trust: electron-updater downloads the zip it names and
// accepts it only when the SHA-512 matches. So the feed must be for this version and list exactly
// the zips that were just verified, each with its own hash. Parsed as YAML, not matched as text.
//
// Usage: node scripts/release-feed.mjs <latest-mac.yml> <version> <zip>...
// codex:run npm test -- tests/unit/releaseFeed.test.ts

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

/** SHA-512 of a file's bytes, base64, as electron-builder writes it into latest*.yml */
export function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

/**
 * @param {string} feedText the contents of latest-mac.yml
 * @param {string} version the version being released (package.json `version`)
 * @param {{ name: string, sha512: string }[]} zips the verified zips: file name and SHA-512 (base64)
 * @returns {string[]} what is wrong with the feed; empty when it is right
 */
export function checkMacFeed(feedText, version, zips) {
  let feed
  try {
    // FAILSAFE: every scalar stays a string, so a version like 2.10 is never read as a number
    feed = yaml.load(feedText, { schema: yaml.FAILSAFE_SCHEMA })
  } catch (error) {
    return [`is not valid YAML (${error instanceof Error ? error.message.split('\n')[0] : 'parse error'})`]
  }
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) return ['is not a YAML mapping']

  const errors = []
  if (feed.version !== version) errors.push(`is for version ${JSON.stringify(feed.version)}, expected ${JSON.stringify(version)}`)
  if (!Array.isArray(feed.files)) return [...errors, 'has no files list']

  // The zips are what MacUpdater downloads; .dmg entries are listed too, but never installed
  const listed = new Map()
  for (const entry of feed.files) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.sha512 !== 'string') {
      errors.push('has a files entry without a url and a sha512')
      continue
    }
    if (!entry.url.endsWith('.zip')) continue
    if (listed.has(entry.url)) errors.push(`lists ${entry.url} twice`)
    listed.set(entry.url, entry.sha512)
  }

  const verified = new Map(zips.map((zip) => [zip.name, zip.sha512]))
  for (const [name, sha512] of verified) {
    if (!listed.has(name)) errors.push(`does not list ${name}`)
    else if (listed.get(name) !== sha512) errors.push(`lists ${name} with a SHA-512 that is not its own`)
  }
  for (const name of listed.keys()) {
    if (!verified.has(name)) errors.push(`lists ${name}, which is not one of the verified zips`)
  }
  // Older updaters read the top-level path/sha512 instead of files: when it names a zip, the same rule holds
  if (typeof feed.path === 'string' && feed.path.endsWith('.zip') && verified.get(feed.path) !== feed.sha512) {
    errors.push(`has a top-level path/sha512 (${feed.path}) that does not match a verified zip`)
  }
  return errors
}

function main() {
  const [feedPath, version, ...zipPaths] = process.argv.slice(2)
  if (!feedPath || !version || zipPaths.length === 0) {
    console.log('usage: node scripts/release-feed.mjs <latest-mac.yml> <version> <zip>...')
    process.exit(2)
  }
  const zips = zipPaths.map((path) => ({ name: basename(path), sha512: sha512Base64(readFileSync(path)) }))
  const errors = checkMacFeed(readFileSync(feedPath, 'utf8'), version, zips)
  for (const error of errors) console.log(`::error title=macOS update feed::${feedPath} ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log(`${feedPath} is for ${version} and lists exactly the ${zips.length} verified zips with their SHA-512`)
}

// Compare real paths: argv[1] may reach the script through a symlink or a relative path
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) main()
