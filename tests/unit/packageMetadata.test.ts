// codex:run npm test -- tests/unit/packageMetadata.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const readme = readFileSync(new URL('README.md', root), 'utf8')

describe('package metadata', () => {
  // Electron names the user-data folder from the top-level productName, falling back to name;
  // electron-builder's build.productName never reaches the packaged package.json (spec R6)
  it('keeps the user-data folder name that existing profiles live in', () => {
    // A top-level productName would move every user's settings, cookies and login to a new,
    // empty folder. Ship a profile migration before removing this guard.
    expect(pkg.productName).toBeUndefined()
    expect(pkg.name).toBe('jira-desktop-app')
  })

  it('documents the real user-data folder on every platform', () => {
    const folder = pkg.productName ?? pkg.name
    expect(readme).toContain(`~/Library/Application Support/${folder}`)
    expect(readme).toContain(`%APPDATA%\\${folder}`)
    expect(readme).toContain(`~/.config/${folder}`)
  })

  // deb/rpm packages carry homepage as their project URL
  it('points homepage and repository at the repo the releases publish to', () => {
    const [publish] = pkg.build.publish
    const repo = `https://github.com/${publish.owner}/${publish.repo}`
    expect(pkg.homepage).toBe(repo)
    expect(pkg.repository).toEqual({ type: 'git', url: `git+${repo}.git` })
  })
})
