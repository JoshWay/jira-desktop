// The dialog page: Set Jira URL / New Atlassian Window (from the menu), Welcome (first run) and
// the load-error view (Retry / Change URL). Runs sandboxed with no Node; its only bridge is
// window.dialogAPI from src/preload/dialog.ts. Everything it shows is set through textContent /
// value, never markup, so a hostile URL renders as plain text.
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
// codex:run npm run test:e2e -- tests/e2e/startup.spec.ts
import type { DialogAPI, DialogInit, DialogMode, DialogSubmitPayload, LoadErrorAction, ProductChoice } from '../shared/dialog'

declare global {
  interface Window {
    dialogAPI: DialogAPI
  }
}

interface Copy {
  title: string
  message?: string
  label: string
  placeholder: string
  submit: string
  cancel: string
}

const COPY: Record<DialogMode, Copy> = {
  'set-url': {
    title: 'Set Jira URL',
    label: "Enter your company's Jira address:",
    placeholder: 'your-team.atlassian.net',
    submit: 'Set URL',
    cancel: 'Cancel'
  },
  'new-window': {
    title: 'New Atlassian Window',
    label: 'Enter an Atlassian address:',
    placeholder: 'your-team.atlassian.net/wiki',
    submit: 'Open Window',
    cancel: 'Cancel'
  },
  welcome: {
    title: 'Welcome to Jira Desktop',
    message: 'Jira Desktop opens your Jira site in its own window. Which site should it open?',
    label: "Your company's Jira address:",
    placeholder: 'your-team.atlassian.net',
    submit: 'Open Jira',
    cancel: 'Not Now'
  },
  'load-error': {
    title: 'Couldn’t load Jira',
    label: '',
    placeholder: '',
    submit: 'Retry',
    cancel: 'Close'
  }
}

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`dialog markup is missing #${id}`)
  return found
}

const api = window.dialogAPI
const form = byId('dialog-form', HTMLFormElement)
const heading = byId('heading', HTMLHeadingElement)
const message = byId('message', HTMLParagraphElement)
const failedUrl = byId('failed-url', HTMLParagraphElement)
const urlFields = byId('url-fields', HTMLDivElement)
const urlLabel = byId('url-label', HTMLLabelElement)
const urlInput = byId('url', HTMLInputElement)
const newWindowFields = byId('new-window-fields', HTMLDivElement)
const productSelect = byId('product', HTMLSelectElement)
const backgroundCheckbox = byId('background', HTMLInputElement)
const errorText = byId('error', HTMLParagraphElement)
const cancelButton = byId('cancel', HTMLButtonElement)
const changeUrlButton = byId('change-url', HTMLButtonElement)
const submitButton = byId('submit', HTMLButtonElement)

let mode: DialogMode | null = null
let busy = false

function showError(text: string): void {
  errorText.textContent = text
  errorText.hidden = text === ''
  urlInput.setAttribute('aria-invalid', text === '' ? 'false' : 'true')
}

function setBusy(value: boolean): void {
  busy = value
  submitButton.disabled = value
  changeUrlButton.disabled = value
}

function cancel(): void {
  // Rejected only when the dialog is already closing; nothing to do then
  api.cancel().catch(() => {})
}

function loadErrorMessage(init: DialogInit): string {
  const reason = init.errorDescription ? ` (${init.errorDescription})` : ''
  return `Jira Desktop couldn’t load this address${reason}. Check your connection and try again, or change the address.`
}

async function start(): Promise<void> {
  const init = await api.getInit()
  mode = init.mode
  const copy = COPY[init.mode]
  document.title = copy.title
  heading.textContent = copy.title
  const text = init.mode === 'load-error' ? loadErrorMessage(init) : copy.message
  message.textContent = text ?? ''
  message.hidden = text === undefined
  failedUrl.textContent = init.failedUrl ?? ''
  failedUrl.hidden = init.mode !== 'load-error'
  urlFields.hidden = init.mode === 'load-error'
  urlLabel.textContent = copy.label
  urlInput.placeholder = copy.placeholder
  submitButton.textContent = copy.submit
  cancelButton.textContent = copy.cancel
  changeUrlButton.hidden = init.mode !== 'load-error'
  newWindowFields.hidden = init.mode !== 'new-window'
  if (init.currentUrl !== undefined) urlInput.value = init.currentUrl
  submitButton.disabled = false
  if (init.mode === 'load-error') {
    submitButton.focus()
  } else {
    urlInput.focus()
    urlInput.select()
  }
}

function send(payload: DialogSubmitPayload): void {
  if (mode === null || busy) return
  setBusy(true)
  api
    .submit(payload)
    .then((result) => {
      // On success main closes the window; leave the controls disabled until then
      if (result.ok) return
      showError(result.error)
      setBusy(false)
      urlInput.focus()
    })
    .catch(() => {
      showError('Something went wrong. Please try again.')
      setBusy(false)
    })
}

function payloadFor(current: DialogMode, action: LoadErrorAction): DialogSubmitPayload {
  if (current === 'load-error') return { action }
  if (current === 'new-window') {
    return { url: urlInput.value, product: productSelect.value as ProductChoice, background: backgroundCheckbox.checked }
  }
  return { url: urlInput.value }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (mode !== null) send(payloadFor(mode, 'retry'))
})
changeUrlButton.addEventListener('click', () => {
  if (mode === 'load-error') send({ action: 'change-url' })
})

urlInput.addEventListener('input', () => showError(''))
cancelButton.addEventListener('click', cancel)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancel()
})

start().catch(() => showError('Something went wrong. Close this window and try again.'))
