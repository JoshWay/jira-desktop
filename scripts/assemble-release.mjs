// Release assembly for .github/workflows/release.yml (the `release` job).
// Each platform's packages arrive as their own artifact. Only that platform's own file types are
// taken from it, so no build leg can publish another platform's installer or update feed (a
// latest-mac.yml from the Linux leg, say), and a file name supplied by two platforms is an error.
//
// Usage: node scripts/assemble-release.mjs <artifacts dir> <release dir>
//        (<artifacts dir> holds linux/, windows/ and mac/; <release dir> must not exist yet)
// codex:run npm test -- tests/unit/assembleRelease.test.ts

import { copyFileSync, constants, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// required: at least one file of each must be present; optional: taken when present
export const PLATFORM_FILES = Object.freeze({
  linux: { required: [/\.AppImage$/, /\.deb$/, /\.rpm$/, /^latest-linux\.yml$/], optional: [/\.AppImage\.blockmap$/] },
  windows: { required: [/\.exe$/, /^latest\.yml$/], optional: [/\.exe\.blockmap$/] },
  // latest-mac.yml and the zip blockmaps exist only for a signed, verified Mac build
  mac: { required: [/\.dmg$/, /\.zip$/], optional: [/^latest-mac\.yml$/, /\.dmg\.blockmap$/, /\.zip\.blockmap$/] }
})

/**
 * @param {Record<string, string[]>} listings file names in each platform's artifact
 * @returns {{ take: { platform: string, name: string }[], errors: string[] }}
 */
export function planRelease(listings) {
  const take = []
  const errors = []
  const supplier = new Map()
  for (const [platform, rules] of Object.entries(PLATFORM_FILES)) {
    const names = listings[platform] ?? []
    for (const pattern of rules.required) {
      if (!names.some((name) => pattern.test(name))) errors.push(`no ${pattern.source} file in the ${platform} packages`)
    }
    for (const name of names) {
      // Anything that is not this platform's own file type is left behind
      if (![...rules.required, ...rules.optional].some((pattern) => pattern.test(name))) continue
      if (supplier.has(name)) {
        errors.push(`${name} came from both the ${supplier.get(name)} and the ${platform} packages`)
        continue
      }
      supplier.set(name, platform)
      take.push({ platform, name })
    }
  }
  return { take, errors }
}

function filesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return []
  }
}

function main() {
  const [artifacts, releaseDir] = process.argv.slice(2)
  if (!artifacts || !releaseDir) {
    console.log('usage: node scripts/assemble-release.mjs <artifacts dir> <release dir>')
    process.exit(2)
  }
  const listings = Object.fromEntries(Object.keys(PLATFORM_FILES).map((platform) => [platform, filesIn(join(artifacts, platform))]))
  const { take, errors } = planRelease(listings)
  for (const error of errors) console.log(`::error title=Release files::${error}`)
  if (errors.length > 0) process.exit(1)
  // A fresh directory, and COPYFILE_EXCL: nothing already there is ever overwritten
  mkdirSync(releaseDir)
  for (const { platform, name } of take) {
    copyFileSync(join(artifacts, platform, name), join(releaseDir, name), constants.COPYFILE_EXCL)
    console.log(`${platform}: ${name}`)
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) main()
