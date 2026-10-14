// Drives the app's local dialog (src/main/dialogs/DialogController.ts) from e2e specs.
import type { Page } from '@playwright/test'
import { expect } from './app'
import type { LaunchedApp } from './app'

// The built page, loaded from file:// (the dev server is never used in e2e)
export const DIALOG_PAGE = /^file:\/\/.*\/dist\/renderer\/dialog\.html$/

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
