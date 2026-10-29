import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageBoxOptions } from 'electron'
import { UPDATE_PROMPT_BUTTONS, UpdateController } from '../../src/main/updates/UpdateController'
import type { UpdateControllerOptions, UpdaterApi } from '../../src/main/updates/UpdateController'

const UPDATE_NOW = UPDATE_PROMPT_BUTTONS.indexOf('Update Now')
const LATER = UPDATE_PROMPT_BUTTONS.indexOf('Remind Me Later')
const SKIP = UPDATE_PROMPT_BUTTONS.indexOf('Skip This Version')

// A stand-in for electron-updater's autoUpdater: checkForUpdates answers with `available`
class FakeUpdater implements UpdaterApi {
  autoDownload = true
  autoInstallOnAppQuit = true
  available: string | null = null
  checkError: Error | null = null
  downloadError: Error | null = null
  checks = 0
  downloads = 0
  installs = 0
  errorListeners: ((error: Error) => void)[] = []

  async checkForUpdates() {
    this.checks++
    if (this.checkError) throw this.checkError
    const version = this.available ?? '2.1.0'
    return { isUpdateAvailable: this.available !== null, updateInfo: { version } } as Awaited<ReturnType<UpdaterApi['checkForUpdates']>>
  }

  async downloadUpdate() {
    this.downloads++
    if (this.downloadError) throw this.downloadError
    return ['/tmp/update.zip']
  }

  quitAndInstall() {
    this.installs++
  }

  on(event: 'error', listener: (error: Error) => void) {
    if (event === 'error') this.errorListeners.push(listener)
    return this
  }
}

let updater: FakeUpdater
let skipped: string | undefined
let boxes: MessageBoxOptions[]
let answers: number[]
let getUpdater: ReturnType<typeof vi.fn<() => UpdaterApi>>

function controller(overrides: Partial<UpdateControllerOptions> = {}): UpdateController {
  return new UpdateController({
    isPackaged: true,
    appVersion: '2.1.0',
    getUpdater,
    skippedVersion: {
      get: () => skipped,
      set: (version) => { skipped = version }
    },
    showMessageBox: async (options) => {
      boxes.push(options)
      return { response: answers.shift() ?? 0 }
    },
    ...overrides
  })
}

beforeEach(() => {
  updater = new FakeUpdater()
  skipped = undefined
  boxes = []
  answers = []
  getUpdater = vi.fn(() => updater)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UpdateController in an unpackaged build', () => {
  it('never touches the updater and schedules no automatic check', () => {
    vi.useFakeTimers()
    controller({ isPackaged: false }).startAutomaticChecks()
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(getUpdater).not.toHaveBeenCalled()
  })

  it('answers a manual check with a message, without checking', async () => {
    await controller({ isPackaged: false }).check('manual')
    expect(getUpdater).not.toHaveBeenCalled()
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.message).toMatch(/packaged/i)
  })
})

describe('UpdateController setup', () => {
  it('turns off automatic download, so nothing is fetched before the user says so', async () => {
    updater.available = '2.2.0'
    answers = [LATER]
    await controller().check('automatic')
    expect(updater.autoDownload).toBe(false)
    expect(updater.downloads).toBe(0)
  })

  it('listens for updater errors (an unhandled EventEmitter error would crash main)', async () => {
    await controller().check('automatic')
    expect(updater.errorListeners).toHaveLength(1)
    expect(() => updater.errorListeners[0]!(new Error('boom'))).not.toThrow()
  })

  it('checks once, a few seconds after startup', async () => {
    vi.useFakeTimers()
    controller({ startupDelayMs: 3000 }).startAutomaticChecks()
    await vi.advanceTimersByTimeAsync(2999)
    expect(updater.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checks).toBe(1)
  })
})

describe('UpdateController prompts', () => {
  it('says nothing when an automatic check finds no update', async () => {
    await controller().check('automatic')
    expect(updater.checks).toBe(1)
    expect(boxes).toEqual([])
  })

  it('says the app is up to date after a manual check finds no update', async () => {
    await controller().check('manual')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.title).toBe('No Updates Available')
  })

  it('says the check failed only for a manual check', async () => {
    updater.checkError = new Error('offline')
    await controller().check('automatic')
    expect(boxes).toEqual([])
    await controller().check('manual')
    expect(boxes.map((box) => box.title)).toEqual(['Update Check Failed'])
  })

  it('offers an available update with Update Now, Remind Me Later and Skip This Version', async () => {
    updater.available = '2.2.0'
    answers = [LATER]
    await controller().check('automatic')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.buttons).toEqual(['Update Now', 'Remind Me Later', 'Skip This Version'])
    expect(boxes[0]!.message).toContain('2.2.0')
    expect(boxes[0]!.cancelId).toBe(LATER)
  })

  it('downloads on Update Now, then installs on Restart Now', async () => {
    updater.available = '2.2.0'
    answers = [UPDATE_NOW, 0, 0]
    await controller().check('automatic')
    expect(updater.downloads).toBe(1)
    expect(boxes.map((box) => box.title)).toEqual(['Update Available', 'Downloading Update', 'Update Ready'])
    expect(updater.installs).toBe(1)
  })

  it('does not install on Restart Later', async () => {
    updater.available = '2.2.0'
    answers = [UPDATE_NOW, 0, 1]
    await controller().check('automatic')
    expect(updater.installs).toBe(0)
  })

  it('reports a failed download', async () => {
    updater.available = '2.2.0'
    updater.downloadError = new Error('disk full')
    answers = [UPDATE_NOW, 0]
    await controller().check('automatic')
    expect(boxes.map((box) => box.title)).toEqual(['Update Available', 'Downloading Update', 'Update Failed'])
    expect(updater.installs).toBe(0)
  })

  it('never rejects when a prompt cannot be shown', async () => {
    updater.available = '2.2.0'
    const failing = controller({ showMessageBox: async () => { throw new Error('no window') } })
    await expect(failing.check('automatic')).resolves.toBeUndefined()
    // and the next check still runs
    await failing.check('automatic')
    expect(updater.checks).toBe(2)
  })

  it('runs one check at a time', async () => {
    const updates = controller()
    await Promise.all([updates.check('automatic'), updates.check('manual')])
    expect(updater.checks).toBe(1)
  })
})

describe('UpdateController Skip This Version', () => {
  it('remembers the skipped version', async () => {
    updater.available = '2.2.0'
    answers = [SKIP]
    await controller().check('automatic')
    expect(skipped).toBe('2.2.0')
    expect(updater.downloads).toBe(0)
  })

  it('suppresses that version on later automatic checks', async () => {
    skipped = '2.2.0'
    updater.available = '2.2.0'
    await controller().check('automatic')
    expect(updater.checks).toBe(1)
    expect(boxes).toEqual([])
  })

  it('still offers a newer version', async () => {
    skipped = '2.2.0'
    updater.available = '2.3.0'
    answers = [LATER]
    await controller().check('automatic')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.message).toContain('2.3.0')
  })

  it('still offers the skipped version when the user checks manually', async () => {
    skipped = '2.2.0'
    updater.available = '2.2.0'
    answers = [LATER]
    await controller().check('manual')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.title).toBe('Update Available')
  })
})
