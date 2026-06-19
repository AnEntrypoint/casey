// case-runtime.js  --  process-wide singleton holding the initialized CaseStore.
//
// freddie discovers plugins by scanning directories and importing their
// plugin.js. A plugin therefore can't be handed the CaseStore as an argument -- 
// it has to reach a shared instance. The CLI calls setCaseStore() after
// init(), and the case-tools plugin calls getCaseStore() lazily inside its
// handlers (by which time the store exists).

let _store = null
let _closed = false

export function setCaseStore(store) { _store = store; _closed = false }

export function getCaseStore() {
  if (!_store) throw new Error(_closed
    ? 'CaseStore was closed (stop called?)'
    : 'CaseStore not initialised  --  casey must call setCaseStore() at boot')
  return _store
}

// Clear the singleton on shutdown so a second createCasey() in the same process
// (notably back-to-back tests) starts from a fresh store rather than a stale,
// already-closed handle. casey.stop() calls this after store.close().
export function resetCaseStore() { _store = null; _closed = true }
