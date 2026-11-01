// codex:run npm test -- tests/unit/assembleRelease.test.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLATFORM_FILES, planRelease } from '../../scripts/assemble-release.mjs'

const LINUX = ['Jira-Desktop-2.2.0-linux-x86_64.AppImage', 'Jira-Desktop-2.2.0-linux-amd64.deb', 'Jira-Desktop-2.2.0-linux-x86_64.rpm', 'latest-linux.yml']
const WINDOWS = ['Jira-Desktop-2.2.0-win-x64.exe', 'Jira-Desktop-2.2.0-win-x64.exe.blockmap', 'latest.yml']
const MAC_UNSIGNED = ['Jira-Desktop-2.2.0-mac-arm64.dmg', 'Jira-Desktop-2.2.0-mac-x64.dmg', 'Jira-Desktop-2.2.0-mac-arm64.zip', 'Jira-Desktop-2.2.0-mac-x64.zip', 'Jira-Desktop-2.2.0-mac-arm64.dmg.blockmap']
const MAC_SIGNED = [...MAC_UNSIGNED, 'latest-mac.yml', 'Jira-Desktop-2.2.0-mac-arm64.zip.blockmap']

const names = (plan: ReturnType<typeof planRelease>): string[] => plan.take.map((file) => file.name).sort()

describe('planRelease', () => {
  it('takes every platform\'s files for an unsigned Mac build, with no Mac feed', () => {
    const plan = planRelease({ linux: LINUX, windows: WINDOWS, mac: MAC_UNSIGNED })
    expect(plan.errors).toEqual([])
    expect(names(plan)).toEqual([...LINUX, ...WINDOWS, ...MAC_UNSIGNED].sort())
  })

  it('takes the Mac feed when the signed build supplied it', () => {
    const plan = planRelease({ linux: LINUX, windows: WINDOWS, mac: MAC_SIGNED })
    expect(plan.errors).toEqual([])
    expect(plan.take).toContainEqual({ platform: 'mac', name: 'latest-mac.yml' })
  })

  it('never takes a file from the wrong platform\'s packages', () => {
    const plan = planRelease({ linux: [...LINUX, 'latest-mac.yml', 'evil.dmg', 'evil.exe'], windows: [...WINDOWS, 'latest-linux.yml'], mac: MAC_UNSIGNED })
    expect(plan.errors).toEqual([])
    expect(names(plan)).not.toContain('latest-mac.yml')
    expect(names(plan)).not.toContain('evil.dmg')
    expect(names(plan)).not.toContain('evil.exe')
    expect(plan.take.filter((file) => file.name === 'latest-linux.yml')).toEqual([{ platform: 'linux', name: 'latest-linux.yml' }])
  })

  it('fails when a required file is missing, wildcard or literal', () => {
    expect(planRelease({ linux: LINUX, windows: ['latest.yml'], mac: MAC_UNSIGNED }).errors).toEqual(['no \\.exe$ file in the windows packages'])
    expect(planRelease({ linux: LINUX.filter((name) => name !== 'latest-linux.yml'), windows: WINDOWS, mac: MAC_UNSIGNED }).errors).toEqual(['no ^latest-linux\\.yml$ file in the linux packages'])
    expect(planRelease({ linux: LINUX, windows: WINDOWS }).errors).toEqual(['no \\.dmg$ file in the mac packages', 'no \\.zip$ file in the mac packages'])
  })

  it('gives every release file exactly one platform, so no two legs can supply the same name', () => {
    for (const name of [...LINUX, ...WINDOWS, ...MAC_SIGNED]) {
      const owners = Object.entries(PLATFORM_FILES).filter(([, rules]) => [...rules.required, ...rules.optional].some((pattern) => pattern.test(name)))
      expect(owners.map(([platform]) => platform), name).toHaveLength(1)
    }
  })
})

describe('assemble-release.mjs', () => {
  let work: string | undefined
  afterEach(() => {
    if (work) rmSync(work, { recursive: true, force: true })
    work = undefined
  })

  function artifacts(listings: Record<string, string[]>): string {
    work = mkdtempSync(join(tmpdir(), 'assemble-'))
    for (const [platform, files] of Object.entries(listings)) {
      mkdirSync(join(work, 'artifacts', platform), { recursive: true })
      for (const file of files) writeFileSync(join(work, 'artifacts', platform, file), platform)
    }
    return work
  }

  const run = (dir: string) => execFileSync(process.execPath, ['scripts/assemble-release.mjs', join(dir, 'artifacts'), join(dir, 'release')], { encoding: 'utf8' })

  it('copies exactly the planned files into a new release directory', () => {
    const dir = artifacts({ linux: [...LINUX, 'latest-mac.yml'], windows: WINDOWS, mac: MAC_SIGNED })
    run(dir)
    expect(readdirSync(join(dir, 'release')).sort()).toEqual([...LINUX, ...WINDOWS, ...MAC_SIGNED].sort())
  })

  it('exits non-zero and copies nothing when a required file is missing', () => {
    const dir = artifacts({ linux: LINUX, windows: ['latest.yml'], mac: MAC_UNSIGNED })
    expect(() => run(dir)).toThrow()
    expect(() => readdirSync(join(dir, 'release'))).toThrow()
  })
})
