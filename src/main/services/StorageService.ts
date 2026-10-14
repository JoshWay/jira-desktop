import { app } from 'electron'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type StorageData = Record<string, unknown>

export interface StorageOptions<T extends object> {
  // Shape check for what is read from disk. The file is outside the app's control, so a typed
  // store should drop fields that do not match T instead of handing them to callers.
  sanitize?: (raw: StorageData) => T
}

export const STORAGE_DEBOUNCE_MS = 250

// A small JSON document in userData (spec R3).
// - Loads synchronously in the constructor, so a reader can never run before the data is there.
// - A missing file starts empty. A corrupt file (unparseable, or not a JSON object) is renamed to
//   `<file>.corrupt-<n>` so it is never overwritten, then the store starts empty.
// - Writes are atomic (write `<file>.tmp`, fsync, rename over the file) and debounced; flush()
//   writes any pending change immediately and is called on quit.
// - Values are stored and returned as JSON copies, so memory always matches what is on disk.
// codex:run npm test -- tests/unit/StorageService.test.ts
export class StorageService<T extends object = StorageData> {
  private readonly filePath: string
  private data: StorageData
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(fileName: string = 'app-data.json', options: StorageOptions<T> = {}) {
    this.filePath = join(app.getPath('userData'), fileName)
    const raw = this.load()
    this.data = (options.sanitize ? options.sanitize(raw) : raw) as StorageData
    // A sanitizer may blank a field to undefined; keep the in-memory view equal to what JSON writes
    this.data = copy(this.data)
  }

  public get<K extends keyof T & string>(key: K): T[K] | undefined
  public get<K extends keyof T & string>(key: K, defaultValue: Exclude<T[K], undefined>): Exclude<T[K], undefined>
  public get<K extends keyof T & string>(key: K, defaultValue?: T[K]): T[K] | undefined {
    if (!Object.hasOwn(this.data, key)) return defaultValue
    return copy(this.data[key]) as T[K]
  }

  public set<K extends keyof T & string>(key: K, value: T[K]): void {
    if (value === undefined) {
      this.delete(key)
      return
    }
    this.data[key] = copy(value)
    this.changed()
  }

  public delete(key: keyof T & string): void {
    if (!Object.hasOwn(this.data, key)) return
    delete this.data[key]
    this.changed()
  }

  public has(key: keyof T & string): boolean {
    return Object.hasOwn(this.data, key)
  }

  public clear(): void {
    this.data = {}
    this.changed()
  }

  public getAll(): Partial<T> {
    return copy(this.data) as Partial<T>
  }

  // Writes any pending change now (synchronously) and cancels the debounced write
  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    try {
      this.write()
      this.dirty = false
    } catch (error) {
      // Stay dirty: the next set() or flush() tries again
      console.error(`Failed to save ${this.filePath}:`, error)
    }
  }

  private changed(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, STORAGE_DEBOUNCE_MS)
    // A pending save must not keep the process alive on its own; quit paths call flush()
    this.timer.unref?.()
  }

  private load(): StorageData {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`${this.filePath} does not exist yet; starting with empty data`)
      } else {
        console.warn(`Could not read ${this.filePath}; starting with empty data:`, error)
      }
      return {}
    }

    try {
      const parsed: unknown = JSON.parse(text)
      if (isPlainObject(parsed)) return parsed
    } catch {
      // Falls through to quarantine
    }
    const quarantined = this.quarantine()
    console.warn(`${this.filePath} is corrupt; ${quarantined ? `moved it to ${quarantined}` : 'could not move it aside'} and starting with empty data`)
    return {}
  }

  private quarantine(): string | null {
    let n = 1
    while (existsSync(`${this.filePath}.corrupt-${n}`)) n++
    const target = `${this.filePath}.corrupt-${n}`
    try {
      renameSync(this.filePath, target)
      return target
    } catch (error) {
      console.warn(`Failed to quarantine ${this.filePath}:`, error)
      return null
    }
  }

  private write(): void {
    const tmp = `${this.filePath}.tmp`
    mkdirSync(dirname(this.filePath), { recursive: true })
    try {
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf-8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.filePath)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
      throw error
    }
  }
}

function isPlainObject(value: unknown): value is StorageData {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function copy<V>(value: V): V {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}
