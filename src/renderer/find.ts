// The find bar page (spec R4): an input, the match count, previous / next and close. Runs
// sandboxed with no Node; its only bridge is window.findAPI from src/preload/find.ts. Enter finds
// the next match, Shift+Enter the previous one, Esc closes the bar (main then clears the page's
// find highlight). The count is set with textContent, never markup.
// codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
import { MAX_FIND_TEXT_LENGTH, matchCountText } from '../shared/find'
import type { FindAPI, FindResult } from '../shared/find'

declare global {
  interface Window {
    findAPI: FindAPI
  }
}

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`find bar markup is missing #${id}`)
  return found
}

const form = byId('find-form', HTMLFormElement)
const input = byId('query', HTMLInputElement)
const count = byId('count', HTMLSpanElement)
const previous = byId('previous', HTMLButtonElement)
const next = byId('next', HTMLButtonElement)
const close = byId('close', HTMLButtonElement)

// The text of the search the page last started; null when none is running
let searched: string | null = null
let lastResult: FindResult | null = null

function render(): void {
  count.textContent = matchCountText(lastResult, input.value !== '')
}

// A new search when the text changed since the last one, else the next / previous match
// codex:run npm run test:e2e -- tests/e2e/navigation.spec.ts
function search(forward: boolean): void {
  const text = input.value.slice(0, MAX_FIND_TEXT_LENGTH)
  const newSession = text !== searched
  searched = text
  if (newSession) lastResult = null
  render()
  window.findAPI.find({ text, forward, newSession }).catch(() => {})
}

function closeBar(): void {
  window.findAPI.close().catch(() => {})
}

window.findAPI.onResult((result) => {
  lastResult = result
  render()
})

// Opened (again) with Cmd/Ctrl+F: select the text. After a close (main ended the search, whoever
// closed the bar) it searches for that text again from the start.
window.findAPI.onActivate((restart) => {
  if (restart) {
    searched = null
    lastResult = null
    render()
  }
  input.focus()
  input.select()
  if (restart && input.value !== '') search(true)
})

input.addEventListener('input', () => search(true))
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  search(!event.shiftKey)
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing) return
  event.preventDefault()
  closeBar()
})
form.addEventListener('submit', (event) => event.preventDefault())
previous.addEventListener('click', () => search(false))
next.addEventListener('click', () => search(true))
close.addEventListener('click', () => closeBar())

render()
