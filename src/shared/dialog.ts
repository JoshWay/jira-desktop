// The contract between the dialog page (renderer), its preload and DialogController (main).
// No electron or DOM imports: it is typechecked under both tsconfig.node.json and tsconfig.web.json,
// and the renderer only ever imports its types.

// set-url / new-window: opened from the menu. welcome (first run, no saved site) and load-error
// (the main window failed to load) are opened by the app itself.
export type DialogMode = 'set-url' | 'new-window' | 'welcome' | 'load-error'
// The modes that ask for an address
export type UrlDialogMode = Exclude<DialogMode, 'load-error'>

export interface DialogInit {
  mode: DialogMode
  // set-url only: the site the app is configured for now
  currentUrl?: string
  // load-error only: what failed, shown as text
  failedUrl?: string
  errorDescription?: string
}

export const PRODUCT_CHOICES = Object.freeze(['auto', 'jira', 'confluence', 'bitbucket', 'trello'] as const)
export type ProductChoice = (typeof PRODUCT_CHOICES)[number]

// load-error: Retry (reload what failed) or Change URL (open the set-url dialog)
export const LOAD_ERROR_ACTIONS = Object.freeze(['retry', 'change-url'] as const)
export type LoadErrorAction = (typeof LOAD_ERROR_ACTIONS)[number]

// Which fields a mode sends: set-url / welcome send url; new-window adds product and background;
// load-error sends only action. Main validates the shape per mode (dialogRules.ts).
export interface DialogSubmitPayload {
  url?: string
  product?: ProductChoice
  background?: boolean
  action?: LoadErrorAction
}

// ok: false carries a user-facing message the page shows inline (the dialog stays open)
export type DialogSubmitResult = { ok: true } | { ok: false; error: string }

// Exposed by src/preload/dialog.ts as window.dialogAPI; nothing else is exposed
export interface DialogAPI {
  getInit(): Promise<DialogInit>
  submit(payload: DialogSubmitPayload): Promise<DialogSubmitResult>
  cancel(): Promise<void>
}

export const DIALOG_CHANNELS = Object.freeze({
  getInit: 'dialog:get-init',
  submit: 'dialog:submit',
  cancel: 'dialog:cancel'
} as const)
