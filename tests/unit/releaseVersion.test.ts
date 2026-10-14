// codex:run npm test -- tests/unit/releaseVersion.test.ts
import { describe, expect, it } from 'vitest'
import { releaseInfo } from '../../scripts/release-version.mjs'

describe('releaseInfo', () => {
  it('accepts a tag that is v + the package version', () => {
    expect(releaseInfo('v2.2.0', '2.2.0')).toEqual({ version: '2.2.0', prerelease: false })
  })

  it('refuses a tag that disagrees with package.json', () => {
    expect(() => releaseInfo('v2.2.0', '2.1.0')).toThrow(/does not match package.json version "2.1.0"/)
    expect(() => releaseInfo('v2.2.0-rc.1', '2.2.0')).toThrow(/does not match/)
    expect(() => releaseInfo('v2.2.0', '2.2.0-rc.1')).toThrow(/does not match/)
  })

  it('refuses tags that are not v + semver', () => {
    for (const tag of ['2.2.0', 'version-2.2.0', 'v2.2', 'v02.2.0', 'v2.2.0-', 'v', '']) {
      expect(() => releaseInfo(tag, tag.replace(/^v/, ''))).toThrow()
    }
  })

  it('marks semver pre-releases as prereleases', () => {
    for (const v of ['2.2.0-rc.1', '2.2.0-beta', '3.0.0-alpha.2', '2.2.0-0', '2.2.0-rc.1+build.5']) {
      expect(releaseInfo(`v${v}`, v).prerelease).toBe(true)
    }
  })

  it('does not decide prerelease by substring', () => {
    // Build metadata is not a pre-release, even when it contains a hyphen or "rc"
    expect(releaseInfo('v2.2.0+build-rc', '2.2.0+build-rc').prerelease).toBe(false)
    expect(releaseInfo('v12.0.0', '12.0.0').prerelease).toBe(false)
  })
})
