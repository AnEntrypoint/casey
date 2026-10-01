

let _store = null
let _closed = false

export function setCaseStore(store) { _store = store; _closed = false }

export function getCaseStore() {
  if (!_store) throw new Error(_closed
    ? 'CaseStore was closed (stop called?)'
    : 'CaseStore not initialised  --  casey must call setCaseStore() at boot')
  return _store
}

export function resetCaseStore() { _store = null; _closed = true }
