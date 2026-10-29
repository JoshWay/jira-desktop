// Drives the app's local dialog (src/main/dialogs/DialogController.ts) from e2e specs.
import type { Page } from '@playwright/test'
import { expect } from './app'
import type { LaunchedApp } from './app'

// The built page, loaded from file:// (the dev server is never used in e2e)
export const DIALOG_PAGE = /^file:\/\/.*\/dist\/renderer\/dialog\.html$/
// The static page the main window shows while no site is loaded (first run, load failure)
export const PLACEHOLDER_PAGE = /^file:\/\/.*\/dist\/renderer\/placeholder\.html$/

export const DIALOG_CHANNELS = ['dialog:get-init', 'dialog:submit', 'dialog:cancel'] as const

export type AppMenuLabel = 'Set Jira URL...' | 'New Atlassian Window...'

// Clicks an item of the app's first ("Jira Desktop") menu, as the user would
export async function clickAppMenu(app: LaunchedApp, label: string): Promise<void> {
  await app.electronApp.evaluate(({ Menu }, itemLabel) => {
    const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === itemLabel)
    if (!item) throw new Error(`no menu item ${itemLabel}`)
    ;(item.click as () => void)()
  }, label)
}

// Opens the dialog from the menu and waits until the page has loaded its init data
export async function openDialog(app: LaunchedApp, label: AppMenuLabel): Promise<Page> {
  const opened = app.electronApp.waitForEvent('window')
  await clickAppMenu(app, label)
  const page = await opened
  await expect(page).toHaveURL(DIALOG_PAGE)
  await expect(page.locator('#submit')).toBeEnabled()
  return page
}

// Waits for the app to open the dialog by itself (welcome, load-error) and for its init data
export async function waitForDialog(app: LaunchedApp): Promise<Page> {
  const find = (): Page | undefined => app.electronApp.windows().find((p) => !p.isClosed() && DIALOG_PAGE.test(p.url()))
  await expect.poll(() => find() !== undefined).toBe(true)
  const page = find()!
  await expect(page.locator('#submit')).toBeEnabled()
  return page
}

// Clicks a menu item by its labels from the menu bar down, e.g. ['View', 'Appearance', 'Dark']
export async function clickMenu(app: LaunchedApp, path: string[]): Promise<void> {
  await app.electronApp.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()!.items
    let item: Electron.MenuItem | undefined
    for (const label of labels) {
      item = items.find((i) => i.label === label)
      if (!item) throw new Error(`no menu item ${labels.join(' > ')}`)
      items = item.submenu?.items ?? []
    }
    ;(item!.click as () => void)()
  }, path)
}

// Runs an action that makes main close the dialog (Cancel, Escape, Enter, a successful Submit) and
// waits for the close. Playwright waits for Chromium's input ack, and under load the window can be
// destroyed first, so the action rejecting with "…has been closed" is expected and ignored.
export async function closeVia(page: Page, action: () => Promise<unknown>): Promise<void> {
  const done = page.isClosed() ? Promise.resolve() : page.waitForEvent('close')
  done.catch(() => {})
  await action().catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error
  })
  await done
}
