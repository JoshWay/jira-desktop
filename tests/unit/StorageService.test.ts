import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// app.getPath('userData') points at a fresh temp dir per test
const env = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => { if (name !== 'userData') throw new Error(`unexpected path ${name}`); return env.userData } }
}))

// Counts real renames so a test can tell how many writes reached the disk
const renames = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => { renames.count++; return actual.renameSync(from, to) }
  }
})

import { StorageService } from '../../src/main/services/StorageService'
import { createSettingsStore, sanitizeSettings, SETTINGS_FILE } from '../../src/main/services/settings'
import type { Settings } from '../../src/main/services/settings'

interface TestData {
  name?: string
  count?: number
  nested?: { list: number[] }
}

const FILE = 'test-store.json'
const filePath = () => join(env.userData, FILE)
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8'))

let root: string
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jira-desktop-storage-'))
  env.userData = root
  renames.count = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('StorageService load', () => {
  it('starts empty with a warning when the file is missing, and creates nothing', () => {
    const store = new StorageService<TestData>(FILE)
    expect(store.getAll()).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(FILE)
    expect(readdirSync(env.userData)).toEqual([])
  })

  it('loads synchronously: values are readable as soon as the constructor returns', () => {
    writeFileSync(filePath(), JSON.stringify({ name: 'saved', count: 3 }))
    const store = new StorageService<TestData>(FILE)
    expect(store.get('name')).toBe('saved')
    expect(store.get('count', 0)).toBe(3)
    expect(warn).not.toHaveBeenCalled()
  })

  it('quarantines a corrupt file as *.corrupt-<n> and starts empty', () => {
    writeFileSync(filePath(), '{"name": "trunc')
    const store = new StorageService<TestData>(FILE)
    expect(store.getAll()).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(existsSync(filePath())).toBe(false)
    expect(readFileSync(`${filePath()}.corrupt-1`, 'utf-8')).toBe('{"name": "trunc')
  })

  it('never overwrites an earlier quarantined file', () => {
    writeFileSync(`${filePath()}.corrupt-1`, 'first')
    writeFileSync(filePath(), 'second')
    new StorageService<TestData>(FILE)
    expect(readFileSync(`${filePath()}.corrupt-1`, 'utf-8')).toBe('first')
    expect(readFileSync(`${filePath()}.corrupt-2`, 'utf-8')).toBe('second')
  })

  it.each([['an array', '[1,2]'], ['null', 'null'], ['a number', '42'], ['a string', '"x"'], ['empty', '']])(
    'treats valid-or-empty JSON that is %s as corrupt',
    (_label, content) => {
      writeFileSync(filePath(), content)
      const store = new StorageService<TestData>(FILE)
      expect(store.getAll()).toEqual({})
      expect(existsSync(`${filePath()}.corrupt-1`)).toBe(true)
    }
  )

  it('applies the sanitizer to what it reads from disk', () => {
    writeFileSync(filePath(), JSON.stringify({ name: 7, count: 2 }))
    const store = new StorageService<TestData>(FILE, {
      sanitize: (raw) => (typeof raw.name === 'string' ? raw : { ...raw, name: undefined }) as TestData
    })
    expect(store.has('name')).toBe(false)
    expect(store.get('count')).toBe(2)
  })
})

describe('StorageService writes', () => {
  it('round-trips through the file', () => {
    const store = new StorageService<TestData>(FILE)
    store.set('name', 'jira')
    store.set('nested', { list: [1, 2, 3] })
    store.flush()
    expect(readJson(filePath())).toEqual({ name: 'jira', nested: { list: [1, 2, 3] } })

    const reloaded = new StorageService<TestData>(FILE)
    expect(reloaded.get('name')).toBe('jira')
    expect(reloaded.get('nested')).toEqual({ list: [1, 2, 3] })
  })

  it('writes atomically: tmp file then rename, leaving no .tmp behind', () => {
    writeFileSync(filePath(), JSON.stringify({ name: 'old' }))
    writeFileSync(`${filePath()}.tmp`, 'stale leftover from a crash')
    const store = new StorageService<TestData>(FILE)
    store.set('name', 'new')
    store.flush()
    expect(renames.count).toBe(1)
    expect(readdirSync(env.userData).sort()).toEqual([FILE])
    expect(readJson(filePath())).toEqual({ name: 'new' })
  })

  it('debounces writes by 250ms and coalesces a burst into one write', () => {
    vi.useFakeTimers()
    const store = new StorageService<TestData>(FILE)
    store.set('name', 'a')
    store.set('count', 1)
    vi.advanceTimersByTime(100)
    store.set('count', 2)
    store.delete('name')
    vi.advanceTimersByTime(249)
    expect(existsSync(filePath())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(renames.count).toBe(1)
    expect(readJson(filePath())).toEqual({ count: 2 })
    vi.advanceTimersByTime(5000)
    expect(renames.count).toBe(1)
  })

  it('flush writes immediately and cancels the pending debounced write', () => {
    vi.useFakeTimers()
    const store = new StorageService<TestData>(FILE)
    store.set('count', 5)
    store.flush()
    expect(readJson(filePath())).toEqual({ count: 5 })
    expect(renames.count).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(renames.count).toBe(1)
  })

  it('flush is a no-op when nothing changed', () => {
    writeFileSync(filePath(), JSON.stringify({ count: 1 }))
    const store = new StorageService<TestData>(FILE)
    store.flush()
    expect(renames.count).toBe(0)
  })

  it('clear empties the store and persists it', () => {
    writeFileSync(filePath(), JSON.stringify({ count: 1 }))
    const store = new StorageService<TestData>(FILE)
    store.clear()
    store.flush()
    expect(readJson(filePath())).toEqual({})
  })

  it('setting undefined removes the key', () => {
    const store = new StorageService<TestData>(FILE)
    store.set('name', 'x')
    store.set('name', undefined)
    expect(store.has('name')).toBe(false)
    store.flush()
    expect(readJson(filePath())).toEqual({})
  })

  it('stores copies, so callers cannot mutate persisted state behind its back', () => {
    const store = new StorageService<TestData>(FILE)
    const nested = { list: [1] }
    store.set('nested', nested)
    nested.list.push(2)
    store.get('nested')!.list.push(3)
    expect(store.get('nested')).toEqual({ list: [1] })
  })

  it('a failed write is logged, does not throw, and is retried on the next flush', () => {
    // userData is a regular file, so the write cannot create anything under it
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, '')
    env.userData = blocker
    const store = new StorageService<TestData>(FILE)
    store.set('name', 'kept')
    expect(() => store.flush()).not.toThrow()
    expect(error).toHaveBeenCalled()

    // Same store, now pointed at a writable location: the dirty data is still pending
    rmSync(blocker)
    mkdirSync(blocker)
    store.flush()
    expect(readJson(join(blocker, FILE))).toEqual({ name: 'kept' })
  })
})

describe('Settings', () => {
  it('lives in settings.json with typed accessors that round-trip', () => {
    const settings = createSettingsStore()
    settings.set('jiraUrl', 'https://acme.atlassian.net/jira')
    settings.set('themeSource', 'dark')
    settings.set('mainWindow', { bounds: { x: 10, y: 20, width: 1200, height: 900 }, isMaximized: true })
    settings.flush()
    expect(SETTINGS_FILE).toBe('settings.json')
    expect(readJson(join(env.userData, SETTINGS_FILE))).toEqual({
      jiraUrl: 'https://acme.atlassian.net/jira',
      themeSource: 'dark',
      mainWindow: { bounds: { x: 10, y: 20, width: 1200, height: 900 }, isMaximized: true }
    })

    const reloaded = createSettingsStore()
    const theme: Settings['themeSource'] = reloaded.get('themeSource')
    expect(theme).toBe('dark')
    expect(reloaded.get('jiraUrl')).toBe('https://acme.atlassian.net/jira')
    expect(reloaded.get('mainWindow')?.isMaximized).toBe(true)
  })

  it('drops known fields with the wrong shape and keeps unknown fields for other versions', () => {
    const raw = {
      jiraUrl: 42,
      themeSource: 'purple',
      mainWindow: { bounds: { x: 0, y: 0, width: 'wide', height: 900 }, isMaximized: false },
      fromNewerVersion: 'keep me'
    }
    expect(sanitizeSettings(raw)).toEqual({ fromNewerVersion: 'keep me' })
  })

  it('keeps valid fields', () => {
    const raw = {
      jiraUrl: 'https://acme.atlassian.net/jira',
      themeSource: 'system',
      mainWindow: { bounds: { x: -50, y: 0, width: 800, height: 600 }, isMaximized: false }
    }
    expect(sanitizeSettings(raw)).toEqual(raw)
  })

  it.each([
    ['not an object', 'big'],
    ['bounds missing', { isMaximized: true }],
    ['non-finite coordinate', { bounds: { x: null, y: 0, width: 800, height: 600 }, isMaximized: false }],
    ['isMaximized not boolean', { bounds: { x: 0, y: 0, width: 800, height: 600 }, isMaximized: 'yes' }]
  ])('drops mainWindow when %s', (_label, mainWindow) => {
    expect(sanitizeSettings({ mainWindow })).toEqual({})
  })

  it('sanitizes on load', () => {
    writeFileSync(join(env.userData, SETTINGS_FILE), JSON.stringify({ themeSource: 'purple', jiraUrl: 'https://a.atlassian.net/jira' }))
    const settings = createSettingsStore()
    expect(settings.get('themeSource')).toBeUndefined()
    expect(settings.get('jiraUrl')).toBe('https://a.atlassian.net/jira')
  })
})
