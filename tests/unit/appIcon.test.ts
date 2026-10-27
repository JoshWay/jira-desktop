import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { appIconPath, productIconPath, resourcesDir } from '../../src/main/services/appIcon'

// A packaged app: extraResources copies resources/ to <resourcesPath>/resources
const PACKAGED = { isPackaged: true, resourcesPath: join('/Applications', 'Jira Desktop.app', 'Contents', 'Resources'), appPath: join('/Applications', 'Jira Desktop.app', 'Contents', 'Resources', 'app.asar') }
// Development and e2e: the app path is the repo root
const DEV = { isPackaged: false, resourcesPath: join('/repo', 'node_modules', 'electron', 'dist', 'Resources'), appPath: join('/repo') }

describe('resourcesDir', () => {
  it('is <resourcesPath>/resources in a packaged app (never inside app.asar)', () => {
    expect(resourcesDir(PACKAGED)).toBe(join(PACKAGED.resourcesPath, 'resources'))
  })

  it('is <appPath>/resources when not packaged', () => {
    expect(resourcesDir(DEV)).toBe(join('/repo', 'resources'))
  })
})

describe('appIconPath', () => {
  it('resolves icon.png from the packaged resources', () => {
    expect(appIconPath(PACKAGED)).toBe(join(PACKAGED.resourcesPath, 'resources', 'icon.png'))
  })

  it('resolves icon.png from the repo when not packaged', () => {
    expect(appIconPath(DEV)).toBe(join('/repo', 'resources', 'icon.png'))
  })
})

describe('productIconPath', () => {
  const existing = (paths: string[]) => (path: string) => paths.includes(path)

  it('uses the product icon when it exists', () => {
    const jira = join(PACKAGED.resourcesPath, 'resources', 'jira-icon.png')
    expect(productIconPath(PACKAGED, 'jira-icon.png', existing([jira]))).toBe(jira)
  })

  it('falls back to the app icon when the product icon does not exist', () => {
    expect(productIconPath(PACKAGED, 'jira-icon.png', existing([]))).toBe(appIconPath(PACKAGED))
    expect(productIconPath(DEV, 'confluence-icon.png', existing([appIconPath(DEV)]))).toBe(appIconPath(DEV))
  })

  it('never looks outside the resources directory', () => {
    const outside = join('/repo', 'secret.png')
    const seen: string[] = []
    const exists = (path: string) => {
      seen.push(path)
      return path === outside
    }
    expect(productIconPath(DEV, join('..', 'secret.png'), exists)).toBe(appIconPath(DEV))
    expect(seen).toEqual([join('/repo', 'resources', 'secret.png')])
  })

  it('falls back to the app icon for an empty or dot-only icon name', () => {
    expect(productIconPath(DEV, '', () => true)).toBe(appIconPath(DEV))
    expect(productIconPath(DEV, '..', () => true)).toBe(appIconPath(DEV))
    expect(productIconPath(DEV, '.', () => true)).toBe(appIconPath(DEV))
  })
})
