// The dialog page (Set Jira URL / New Atlassian Window). Runs sandboxed with no Node; its only
// bridge is window.dialogAPI from src/preload/dialog.ts. Everything it shows is set through
// textContent / value, never markup, so a hostile URL renders as plain text.
// codex:run npm run test:e2e -- tests/e2e/dialog.spec.ts
import type { DialogAPI, DialogMode, DialogSubmitPayload, ProductChoice } from '../shared/dialog'

declare global {
  interface Window {
    dialogAPI: DialogAPI
  }
}

const COPY: Record<DialogMode, { title: string; label: string; placeholder: string; submit: string }> = {
  'set-url': {
    title: 'Set Jira URL',
    label: "Enter your company's Jira address:",
    placeholder: 'your-team.atlassian.net',
    submit: 'Set URL'
  },
  'new-window': {
    title: 'New Atlassian Window',
    label: 'Enter an Atlassian address:',
    placeholder: 'your-team.atlassian.net/wiki',
    submit: 'Open Window'
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
const urlLabel = byId('url-label', HTMLLabelElement)
const urlInput = byId('url', HTMLInputElement)
const newWindowFields = byId('new-window-fields', HTMLDivElement)
const productSelect = byId('product', HTMLSelectElement)
const backgroundCheckbox = byId('background', HTMLInputElement)
const errorText = byId('error', HTMLParagraphElement)
const cancelButton = byId('cancel', HTMLButtonElement)
const submitButton = byId('submit', HTMLButtonElement)

let mode: DialogMode | null = null
let busy = false

function showError(message: string): void {
  errorText.textContent = message
  errorText.hidden = message === ''
  urlInput.setAttribute('aria-invalid', message === '' ? 'false' : 'true')
}

function cancel(): void {
  // Rejected only when the dialog is already closing; nothing to do then
  api.cancel().catch(() => {})
}

async function start(): Promise<void> {
  const init = await api.getInit()
  mode = init.mode
  const copy = COPY[init.mode]
  document.title = copy.title
  heading.textContent = copy.title
  urlLabel.textContent = copy.label
  urlInput.placeholder = copy.placeholder
  submitButton.textContent = copy.submit
  newWindowFields.hidden = init.mode !== 'new-window'
  if (init.currentUrl !== undefined) urlInput.value = init.currentUrl
  submitButton.disabled = false
  urlInput.focus()
  urlInput.select()
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (mode === null || busy) return
  busy = true
  submitButton.disabled = true
  const payload: DialogSubmitPayload =
    mode === 'new-window'
      ? { url: urlInput.value, product: productSelect.value as ProductChoice, background: backgroundCheckbox.checked }
      : { url: urlInput.value }
  api
    .submit(payload)
    .then((result) => {
      // On success main closes the window; leave the controls disabled until then
      if (result.ok) return
      showError(result.error)
      busy = false
      submitButton.disabled = false
      urlInput.focus()
    })
    .catch(() => {
      showError('Something went wrong. Please try again.')
      busy = false
      submitButton.disabled = false
    })
})

urlInput.addEventListener('input', () => showError(''))
cancelButton.addEventListener('click', cancel)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancel()
})

start().catch(() => showError('Something went wrong. Close this window and try again.'))
