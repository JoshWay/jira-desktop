// The contract between the dialog page (renderer), its preload and DialogController (main).
// No electron or DOM imports: it is typechecked under both tsconfig.node.json and tsconfig.web.json,
// and the renderer only ever imports its types.

export type DialogMode = 'set-url' | 'new-window'

export interface DialogInit {
  mode: DialogMode
  // set-url only: the site the app is configured for now
  currentUrl?: string
}

export const PRODUCT_CHOICES = Object.freeze(['auto', 'jira', 'confluence', 'bitbucket', 'trello'] as const)
export type ProductChoice = (typeof PRODUCT_CHOICES)[number]

export interface DialogSubmitPayload {
  url: string
  // new-window only
  product?: ProductChoice
  background?: boolean
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
