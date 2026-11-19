import { caseyText } from './deployment-text.js';


let _store = null
let _closed = false

export function setCaseStore(store) { _store = store; _closed = false }

export function getCaseStore() {
  if (!_store) throw new Error(_closed
    ? caseyText("src/case-runtime.js#w0")
    : caseyText("src/case-runtime.js#w1"))
  return _store
}

export function resetCaseStore() { _store = null; _closed = true }
