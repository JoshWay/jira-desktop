import type { MessageBoxOptions } from 'electron'
import type { UpdateCheckResult } from 'electron-updater'

// The part of electron-updater's autoUpdater this controller uses. The feed comes from the
// app-update.yml electron-builder writes into a packaged app from build.publish (spec R5).
export interface UpdaterApi {
  autoDownload: boolean
  checkForUpdates(): Promise<UpdateCheckResult | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface SkippedVersionStore {
  get(): string | undefined
  set(version: string): void
}

export interface UpdateControllerOptions {
  // Unpackaged builds (npm run dev, e2e) have no app-update.yml and never check
  isPackaged: boolean
  appVersion: string
  // Called on first use only, so an unpackaged build never even constructs the updater
  getUpdater: () => UpdaterApi
  skippedVersion: SkippedVersionStore
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  // Decides which message a failed check shows; main passes process.platform
  platform: NodeJS.Platform
  // Opens RELEASES_URL in the browser; main passes openExternalSafely (the only path to the OS)
  openExternal: (url: string) => void
  startupDelayMs?: number
}

export type UpdateCheckKind = 'automatic' | 'manual'

export const UPDATE_PROMPT_BUTTONS: readonly string[] = Object.freeze(['Update Now', 'Remind Me Later', 'Skip This Version'])
const UPDATE_NOW = 0
const REMIND_LATER = 1
const SKIP_VERSION = 2

const DEFAULT_STARTUP_DELAY_MS = 3000

// Where a Mac build that cannot update itself sends the user. A constant: nothing from the
// network or from page content ever chooses the URL that is opened.
export const RELEASES_URL = 'https://github.com/JoshWay/jira-desktop/releases/latest'
export const MANUAL_UPDATE_BUTTONS: readonly string[] = Object.freeze(['Open Releases Page', 'OK'])
const OPEN_RELEASES_PAGE = 0

// electron-updater's GitHub provider turns a 404 for the release's channel file (latest-mac.yml)
// into this coded error. A release built without the macOS signing secrets omits that file on
// purpose (an unsigned Mac app cannot install an update), so on macOS this means "download it
// yourself", not a network problem. Only the code is trusted; the message is never shown.
// codex:run npm test -- tests/unit/UpdateController.test.ts
export function isMissingUpdateFeed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
}

// An automatic check stays quiet about the version the user skipped; a manual check (the user
// asked) offers it anyway. Any other version, newer included, is offered.
// codex:run npm test -- tests/unit/UpdateController.test.ts
export function shouldOfferUpdate(version: string, kind: UpdateCheckKind, skippedVersion: string | undefined): boolean {
  return kind === 'manual' || version !== skippedVersion
}

// Checks for, offers, downloads and installs updates. Nothing is downloaded until the user picks
// Update Now, and "Skip This Version" is remembered across restarts.
// codex:run npm test -- tests/unit/UpdateController.test.ts
export class UpdateController {
  private readonly options: UpdateControllerOptions
  private updater: UpdaterApi | null = null
  // One check (and the prompts and download that follow it) at a time
  private busy = false

  constructor(options: UpdateControllerOptions) {
    this.options = options
  }

  // One automatic check shortly after startup, in packaged builds only
  // codex:run npm test -- tests/unit/UpdateController.test.ts
  startAutomaticChecks(): void {
    if (!this.options.isPackaged) return
    setTimeout(() => void this.check('automatic'), this.options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS)
  }

  // codex:run npm test -- tests/unit/UpdateController.test.ts
  async check(kind: UpdateCheckKind): Promise<void> {
    if (!this.options.isPackaged) {
      if (kind === 'manual') await this.notify('Updates Unavailable', 'Updates are only available in packaged builds.', `This copy of Jira Desktop v${this.options.appVersion} is a development build.`)
      return
    }
    if (this.busy) return
    this.busy = true
    try {
      await this.runCheck(kind)
    } catch (error) {
      // A prompt that failed to show; nothing to tell the user through
      console.error('Update check failed:', error)
    } finally {
      this.busy = false
    }
  }

  private getUpdater(): UpdaterApi {
    if (!this.updater) {
      const updater = this.options.getUpdater()
      // The prompt decides whether to download
      updater.autoDownload = false
      // Failures also reject the call that caused them (handled there); without a listener the
      // emitter would throw in main
      updater.on('error', (error) => console.error('Auto-updater error:', error))
      this.updater = updater
    }
    return this.updater
  }

  private async runCheck(kind: UpdateCheckKind): Promise<void> {
    const updater = this.getUpdater()
    let result: UpdateCheckResult | null
    try {
      result = await updater.checkForUpdates()
    } catch (error) {
      console.error('Failed to check for updates:', error)
      if (kind !== 'manual') return
      // Only macOS releases may lack their feed on purpose; elsewhere it is a broken release
      if (this.options.platform === 'darwin' && isMissingUpdateFeed(error)) {
        await this.offerManualDownload()
        return
      }
      await this.notify('Update Check Failed', 'Unable to check for updates', 'There was a problem checking for updates. Please check your internet connection and try again later.', 'warning')
      return
    }

    if (!result || !result.isUpdateAvailable) {
      if (kind === 'manual') await this.notify('No Updates Available', 'You\'re running the latest version!', `Jira Desktop v${this.options.appVersion} is up to date. No new updates are available at this time.`)
      return
    }

    const version = result.updateInfo.version
    if (!shouldOfferUpdate(version, kind, this.options.skippedVersion.get())) {
      console.log(`Update ${version} was skipped by the user`)
      return
    }
    await this.offer(updater, version)
  }

  private async offer(updater: UpdaterApi, version: string): Promise<void> {
    const { response } = await this.options.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Jira Desktop v${version} is available!`,
      detail: `You're currently running v${this.options.appVersion}. Would you like to download and install the update?`,
      buttons: [...UPDATE_PROMPT_BUTTONS],
      defaultId: UPDATE_NOW,
      cancelId: REMIND_LATER
    })
    if (response === SKIP_VERSION) {
      this.options.skippedVersion.set(version)
      return
    }
    if (response !== UPDATE_NOW) return

    // Not awaited: it is only a notice, and the download runs while it is up
    void this.notify('Downloading Update', 'Downloading update...', 'The update is being downloaded in the background. You\'ll be notified when it\'s ready to install.')
    try {
      await updater.downloadUpdate()
    } catch (error) {
      console.error('Failed to download the update:', error)
      await this.notify('Update Failed', 'The update could not be downloaded', 'Please check your internet connection and try again later.', 'warning')
      return
    }

    const restart = await this.options.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded successfully!',
      detail: 'The update has been downloaded and is ready to install. Would you like to restart the app now?',
      buttons: ['Restart Now', 'Restart Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (restart.response === 0) updater.quitAndInstall()
  }

  // Reached only from a manual check the user started from the menu
  // codex:run npm test -- tests/unit/UpdateController.test.ts
  private async offerManualDownload(): Promise<void> {
    let response: number
    try {
      ;({ response } = await this.options.showMessageBox({
        type: 'info',
        title: 'Updates Are Manual on This Build',
        message: 'This Mac build cannot update itself.',
        detail: 'Download the latest release from GitHub, open the .dmg and drag Jira Desktop to Applications.',
        buttons: [...MANUAL_UPDATE_BUTTONS],
        defaultId: OPEN_RELEASES_PAGE,
        cancelId: 1
      }))
    } catch (error) {
      console.error('Failed to show the update message:', error)
      return
    }
    if (response === OPEN_RELEASES_PAGE) this.options.openExternal(RELEASES_URL)
  }

  private async notify(title: string, message: string, detail: string, type: MessageBoxOptions['type'] = 'info'): Promise<void> {
    try {
      await this.options.showMessageBox({ type, title, message, detail, buttons: ['OK'] })
    } catch (error) {
      console.error('Failed to show the update message:', error)
    }
  }
}
