// codex:run npm test -- tests/unit/releaseFeed.test.ts
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { checkMacFeed, sha512Base64 } from '../../scripts/release-feed.mjs'

// The feeds are rendered with electron-builder's own serializer, so the tests read what CI reads
const require = createRequire(import.meta.url)
const { serializeToYaml } = require('builder-util/out/util') as { serializeToYaml: (value: unknown) => string }

const ARM = { name: 'Jira-Desktop-2.2.0-mac-arm64.zip', sha512: sha512Base64('arm64 zip bytes') }
const X64 = { name: 'Jira-Desktop-2.2.0-mac-x64.zip', sha512: sha512Base64('x64 zip bytes') }
const DMG = { name: 'Jira-Desktop-2.2.0-mac-arm64.dmg', sha512: sha512Base64('dmg bytes') }

function feed(overrides: Record<string, unknown> = {}, files = [ARM, X64, DMG]): string {
  return serializeToYaml({
    version: '2.2.0',
    files: files.map((file) => ({ url: file.name, sha512: file.sha512, size: 1 })),
    path: files[0]!.name,
    sha512: files[0]!.sha512,
    releaseDate: '2026-10-29T00:00:00.000Z',
    ...overrides
  })
}

describe('checkMacFeed', () => {
  it('accepts a feed for this version that lists exactly the verified zips', () => {
    expect(checkMacFeed(feed(), '2.2.0', [ARM, X64])).toEqual([])
  })

  it('accepts a prerelease version and keeps versions as strings', () => {
    expect(checkMacFeed(feed({ version: '2.2.0-rc.1' }), '2.2.0-rc.1', [ARM, X64])).toEqual([])
    expect(checkMacFeed('version: 2.10\nfiles: []\n', '2.10', [])).toEqual([])
  })

  it('refuses a feed for another version', () => {
    expect(checkMacFeed(feed(), '2.3.0', [ARM, X64])).toEqual(['is for version "2.2.0", expected "2.3.0"'])
  })

  it('refuses swapped hashes: each zip must carry its own', () => {
    const swapped = feed({}, [{ ...ARM, sha512: X64.sha512 }, { ...X64, sha512: ARM.sha512 }, DMG])
    expect(checkMacFeed(swapped, '2.2.0', [ARM, X64])).toEqual([
      `lists ${ARM.name} with a SHA-512 that is not its own`,
      `lists ${X64.name} with a SHA-512 that is not its own`,
      expect.stringContaining('top-level path/sha512')
    ])
  })

  it('refuses a zip changed after the feed was written', () => {
    const changed = { ...X64, sha512: sha512Base64('x64 zip bytes, tampered') }
    expect(checkMacFeed(feed(), '2.2.0', [ARM, changed])).toEqual([`lists ${X64.name} with a SHA-512 that is not its own`])
  })

  it('refuses a feed that leaves out a verified zip or adds an unverified one', () => {
    expect(checkMacFeed(feed({}, [ARM, DMG]), '2.2.0', [ARM, X64])).toEqual([`does not list ${X64.name}`])
    const extra = { name: 'Jira-Desktop-2.2.0-mac-universal.zip', sha512: sha512Base64('other') }
    expect(checkMacFeed(feed({}, [ARM, X64, extra]), '2.2.0', [ARM, X64])).toEqual([`lists ${extra.name}, which is not one of the verified zips`])
  })

  it('refuses a zip listed twice', () => {
    expect(checkMacFeed(feed({}, [ARM, X64, ARM]), '2.2.0', [ARM, X64])).toEqual([`lists ${ARM.name} twice`])
  })

  it('ignores .dmg entries, which the updater never installs', () => {
    const otherDmg = { ...DMG, sha512: sha512Base64('anything') }
    expect(checkMacFeed(feed({}, [ARM, X64, otherDmg]), '2.2.0', [ARM, X64])).toEqual([])
  })

  it('refuses malformed feeds', () => {
    expect(checkMacFeed('version: [', '2.2.0', [])[0]).toMatch(/^is not valid YAML/)
    expect(checkMacFeed('- a\n- b\n', '2.2.0', [])).toEqual(['is not a YAML mapping'])
    expect(checkMacFeed('version: 2.2.0\n', '2.2.0', [ARM])).toEqual(['has no files list'])
    expect(checkMacFeed('version: 2.2.0\nfiles:\n  - url: a.zip\n', '2.2.0', [])).toEqual(['has a files entry without a url and a sha512'])
  })
})
