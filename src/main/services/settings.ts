import { StorageService } from './StorageService'
import type { StorageData } from './StorageService'

export type ThemeSource = 'system' | 'light' | 'dark'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface MainWindowState {
  bounds: WindowBounds
  isMaximized: boolean
}

// User settings persisted in settings.json (spec R3). Every field is optional: a missing field
// means "not set yet". To add a setting, add an optional field here and a check in sanitizeSettings.
export interface Settings {
  jiraUrl?: string
  themeSource?: ThemeSource
  mainWindow?: MainWindowState
}

export type SettingsStore = StorageService<Settings>

export const SETTINGS_FILE = 'settings.json'

const THEME_SOURCES: readonly ThemeSource[] = Object.freeze(['system', 'light', 'dark'])

// Drops known fields whose stored value has the wrong shape, so the typed accessors never return
// one. Unknown fields are kept, so a newer version's settings survive a run of an older one.
// codex:run npm test -- tests/unit/StorageService.test.ts
export function sanitizeSettings(raw: StorageData): Settings {
  const settings: StorageData = { ...raw }
  if (!isString(raw.jiraUrl)) delete settings.jiraUrl
  if (!THEME_SOURCES.includes(raw.themeSource as ThemeSource)) delete settings.themeSource
  if (!isMainWindowState(raw.mainWindow)) delete settings.mainWindow
  return settings as Settings
}

// Call after app.setPath('userData') has been applied (the store loads synchronously)
export function createSettingsStore(): SettingsStore {
  return new StorageService<Settings>(SETTINGS_FILE, { sanitize: sanitizeSettings })
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isMainWindowState(value: unknown): value is MainWindowState {
  if (typeof value !== 'object' || value === null) return false
  const { bounds, isMaximized } = value as Record<string, unknown>
  if (typeof isMaximized !== 'boolean') return false
  if (typeof bounds !== 'object' || bounds === null) return false
  const { x, y, width, height } = bounds as Record<string, unknown>
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
}
