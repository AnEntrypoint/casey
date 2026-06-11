// case-runtime.js  --  process-wide singleton holding the initialized CaseStore.
//
// freddie discovers plugins by scanning directories and importing their
// plugin.js. A plugin therefore can't be handed the CaseStore as an argument -- 
// it has to reach a shared instance. The CLI calls setCaseStore() after
// init(), and the case-tools plugin calls getCaseStore() lazily inside its
// handlers (by which time the store exists).

let _store = null

export function setCaseStore(store) { _store = store }

export function getCaseStore() {
  if (!_store) throw new Error('CaseStore not initialised  --  casey must call setCaseStore() at boot')
  return _store
}

export function hasCaseStore() { return !!_store }
