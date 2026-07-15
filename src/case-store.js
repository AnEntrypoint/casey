// case-store.js  --  casey's wrapper over thatcher (the system of record).
//
// Single chokepoint for every case mutation, so the timeline stays append-only
// and each change becomes an audited `event` row.
//
// Only the public Thatcher instance methods are used. Importing thatcher's deep
// internals (getDatabase, workflow-engine) forks the module graph into a second
// instance with its own DB handle, making the real tables invisible. So the
// workflow graph is parsed from the config here, and transitions apply via the
// public update() rather than thatcher's own transition()/getAvailableTransitions():
// casey owns transition authority (P10) and its config does not carry the fields
// thatcher's workflow engine assumes -- `order` (its edges collapse to backward),
// `last_transition_at` (a 5-minute LOCKOUT_SECONDS gate), and the `entry`/`readonly`
// stage constraints -- and casey's own transition() adds the no-op skip, the
// append-only audited event, and the onTransition contact-notify that thatcher's
// bare status write does not.

import { createThatcher } from 'thatcher'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DEFAULT_THRESHOLDS } from './case-health.js'
import { mergeThresholds } from './thresholds.js'
import fs from 'node:fs'
import yaml from 'js-yaml'
import { buildCaseMachine, canTransition, nextStates } from './case-machine.js'
import { tokens } from './correlate.js'

// Principals casey acts as. role:agent satisfies normal requires_role gates.
export const AGENT_USER = { id: 'casey-agent', role: 'agent' }
export const SYSTEM_USER = { id: 'casey-system', role: 'admin' }

// Fields only casey's own system code may write (computed FROM other fields,
// never hand-typed or agent-composed) -- see thatcher.config.yml's matching
// comment. A contact-authored text field the structural-automation invariant
// protects in the OTHER direction (below).
export const DERIVED_ONLY_FIELDS = new Set(['normalized_location', 'geocell', 'cluster_id', 'dedupe_score'])
// Contact-authored free text a SYSTEM actor must never originate -- the sweep/
// notifier/other background system code may tag/observe/reclassify, but must
// never fabricate what a person supposedly said. Mirrors DERIVED_ONLY_FIELDS'
// protection in the opposite direction: one guard, two rules, same chokepoint.
export const SYSTEM_FORBIDDEN_FIELDS = new Set(['report', 'summary', 'subject'])

// One chokepoint both updateCase-family writers call before touching thatcher.
// Returns an error string on a violation, or null when the patch is clean.
function writeGuardViolation(patch, user) {
  if (!patch || typeof patch !== 'object') return null
  const isSystemActor = user?.id === SYSTEM_USER.id
  const keys = Object.keys(patch)
  if (!isSystemActor) {
    const derivedTouched = keys.filter(k => DERIVED_ONLY_FIELDS.has(k))
    if (derivedTouched.length) {
      return `writeGuard: only casey's own system code may write derived field(s): ${derivedTouched.join(', ')}`
    }
  } else {
    const forbiddenTouched = keys.filter(k => SYSTEM_FORBIDDEN_FIELDS.has(k))
    if (forbiddenTouched.length) {
      return `writeGuard: the system actor may never write contact-authored field(s): ${forbiddenTouched.join(', ')}`
    }
  }
  return null
}

export const REPORT_KEYS = new Set(['species', 'symptoms', 'location', 'how_to_find', 'affected_count', 'dead_count', 'onset', 'suspected_disease', 'recent_movement', 'identifying_traits', 'access_notes', 'farmer_available', 'contact_fallback', 'photos', 'audio', 'notes',
  // People on site for a field-worker report: who the worker spoke to and their
  // link to the owner, plus the owner's identity/contact -- so an absent owner with
  // a relative present is still captured. Reported by the worker, model- or
  // pending-ask-captured (no deterministic extractor).
  'present_person', 'present_person_relation', 'owner_name', 'owner_contact', 'language_detected',
  // A SECOND distinct site/herd within the same visit (species/location/count
  // fields above stay the primary site) -- append-only, see mergeReport.
  'sites'])

// Same fields, ordered for stable display/fill-rate rendering (dashboard).
export const REPORT_KEY_ORDER = ['species', 'symptoms', 'affected_count', 'dead_count', 'onset',
  'suspected_disease', 'recent_movement', 'location', 'how_to_find', 'access_notes',
  'farmer_available', 'contact_fallback', 'identifying_traits', 'photos', 'audio', 'notes',
  'present_person', 'present_person_relation', 'owner_name', 'owner_contact', 'language_detected', 'sites']

export class CaseStore {
  constructor(opts = {}) {
    this.configPath = opts.config || path.resolve(process.cwd(), 'thatcher.config.yml')
    // The DB lives at <cwd>/data/app.db and is cwd-bound: thatcher primes its
    // better-sqlite3 handle by calling getDatabase() argless during init
    // (index.js initDatabase -> database-core.migrate), which resolves
    // <cwd>/data/app.db and caches it; importing getDatabase ourselves to
    // pre-seed a different path forks thatcher's module graph into a second
    // handle (see file header), so the ONLY safe relocation is the process cwd.
    // test.js therefore runs from an isolated temp cwd so a run never wipes a
    // live ./data. dataDir is exposed for diagnostics (doctor/up print it).
    this.dataDir = path.resolve(process.cwd(), 'data')
    this.workflow = opts.workflow || 'case_lifecycle'
    this.log = opts.log || null
    // Optional hook fired AFTER a real stage change commits:
    //   onTransition({ caseRow, from, to, user, reason }) -> Promise|void
    // Best-effort: failures are caught and logged, never block the transition.
    // Null in the dashboard-only and test wirings, so transition() must tolerate it.
    this.onTransition = opts.onTransition || null
    this.thatcher = null
    this._wf = null            // parsed workflow stage graph
    this._fieldEnums = null    // entity.field -> options[] (case_type/priority/etc), from the same config
    this._machine = null       // xstate machine built from _wf (transition authority)
    this._locks = new Map()    // per-conversation find-or-create serialization
  }

  async init() {
    if (this.thatcher) return this
    if (!fs.existsSync(this.configPath)) throw new Error(`casey config not found: ${this.configPath}`)
    // Parse + validate the config before booting thatcher so a malformed config
    // fails fast with a clear message instead of a cryptic runtime error later.
    const cfg = yaml.load(fs.readFileSync(this.configPath, 'utf8'))
    this._wf = this._validateConfig(cfg)
    this._fieldEnums = this._parseFieldEnums(cfg)
    // The lifecycle is now a real xstate machine built from the same graph: it,
    // not bespoke array checks, is the authority on whether a transition is legal.
    this._machine = buildCaseMachine(this._wf)

    fs.mkdirSync(this.dataDir, { recursive: true })
    this.thatcher = createThatcher({
      config: this.configPath,
      server: { hotReload: false },
    })
    await this.thatcher.init()
    return this
  }

  // Read, parse, and validate the config WITHOUT booting thatcher or touching a
  // DB. Returns the parsed workflow stage graph; throws a descriptive Error on
  // any structural problem. Lets `casey doctor` run the same graph validation
  // `init()` runs, without creating ./data or a live store. Pure read.
  validateConfig() {
    if (!fs.existsSync(this.configPath)) throw new Error(`casey config not found: ${this.configPath}`)
    return this._validateConfig(yaml.load(fs.readFileSync(this.configPath, 'utf8')))
  }

  // Validate the config and return the parsed workflow stage graph. Throws a
  // descriptive error on any structural problem.
  _validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') throw new Error('casey config is empty or not an object')
    for (const ent of ['case', 'event', 'contact']) {
      if (!cfg.entities?.[ent]) throw new Error(`casey config: missing required entity "${ent}"`)
    }
    const wfDef = cfg.workflows?.[this.workflow]
    if (!wfDef) throw new Error(`casey config: missing workflow "${this.workflow}"`)
    const stages = wfDef.stages || []
    if (!stages.length) throw new Error(`casey config: workflow "${this.workflow}" has no stages`)
    const names = new Set(stages.map(s => s.name))
    const graph = {}
    for (const s of stages) {
      if (!s.name) throw new Error('casey config: a workflow stage has no name')
      for (const t of [...(s.forward || []), ...(s.backward || [])]) {
        if (!names.has(t)) throw new Error(`casey config: stage "${s.name}" references unknown target "${t}"`)
      }
      graph[s.name] = { forward: s.forward || [], backward: s.backward || [], requires_role: s.requires_role || [] }
    }
    // case.status enum should cover every workflow stage, else transitions write
    // values the column rejects.
    const statusOpts = cfg.entities.case.fields?.status?.options
    if (Array.isArray(statusOpts)) {
      for (const n of names) if (!statusOpts.includes(n)) throw new Error(`casey config: case.status enum is missing stage "${n}"`)
    }
    this._validateFieldDefs(cfg)
    this._validateRowAccessAndSort(cfg)
    return graph
  }

  // Broader structural validation over every declared entity.field beyond the
  // workflow-stage-coverage check above: a field definition must be an object
  // with a recognised `type`, an `enum` field must declare a non-empty
  // `options` array, and the required system columns (id/created_at/
  // created_by/updated_at, matching _system_fields in the config) must be
  // present on every entity -- thatcher's write engine always writes these,
  // so a missing one fails obscurely at first insert rather than at boot.
  _validateFieldDefs(cfg) {
    const KNOWN_TYPES = new Set(['id', 'text', 'textarea', 'number', 'enum', 'timestamp', 'boolean', 'json'])
    const REQUIRED_SYSTEM_FIELDS = ['id', 'created_at', 'created_by', 'updated_at']
    for (const [entName, ent] of Object.entries(cfg.entities || {})) {
      const fields = ent?.fields
      if (!fields || typeof fields !== 'object') {
        throw new Error(`casey config: entity "${entName}" has no fields object`)
      }
      for (const sys of REQUIRED_SYSTEM_FIELDS) {
        if (!fields[sys]) throw new Error(`casey config: entity "${entName}" is missing required system field "${sys}"`)
      }
      for (const [fieldName, def] of Object.entries(fields)) {
        if (!def || typeof def !== 'object') {
          throw new Error(`casey config: entity "${entName}" field "${fieldName}" has no definition object`)
        }
        if (!def.type) {
          throw new Error(`casey config: entity "${entName}" field "${fieldName}" has no "type"`)
        }
        if (!KNOWN_TYPES.has(def.type)) {
          throw new Error(`casey config: entity "${entName}" field "${fieldName}" has unrecognised type "${def.type}"`)
        }
        if (def.type === 'enum' && (!Array.isArray(def.options) || !def.options.length)) {
          throw new Error(`casey config: entity "${entName}" field "${fieldName}" is type enum but has no non-empty "options" array`)
        }
      }
    }
  }

  // row_access (when declared) must name a scope this codebase actually
  // understands and a field that is a real column on the entity -- a typo
  // here (e.g. "asignee") would silently no-op the worker enquiry scoping
  // this exists to enforce, handing every worker every case. list.defaultSort
  // (when declared) must be a non-empty array of {field, dir} pairs with dir
  // in ASC/DESC and field a real column, else a sort silently falls back to
  // whatever thatcher/sqlite happens to return.
  _validateRowAccessAndSort(cfg) {
    // 'none' explicitly disables row-access scoping for an entity (e.g.
    // operator_identity/operator_account below -- internal bookkeeping no
    // worker ever queries) and carries no `field`; every other known scope
    // keys on a real column.
    const KNOWN_ROW_ACCESS_SCOPES = new Set(['assigned', 'owner', 'none'])
    for (const [entName, ent] of Object.entries(cfg.entities || {})) {
      const fieldNames = new Set(Object.keys(ent?.fields || {}))
      if (ent?.row_access) {
        const { scope, field } = ent.row_access
        if (!KNOWN_ROW_ACCESS_SCOPES.has(scope)) {
          throw new Error(`casey config: entity "${entName}" row_access.scope "${scope}" is not recognised (expected one of: ${[...KNOWN_ROW_ACCESS_SCOPES].join(', ')})`)
        }
        if (scope !== 'none' && (!field || !fieldNames.has(field))) {
          throw new Error(`casey config: entity "${entName}" row_access.field "${field}" is not a declared field on this entity`)
        }
      }
      const sort = ent?.list?.defaultSort
      if (sort != null) {
        if (!Array.isArray(sort) || !sort.length) {
          throw new Error(`casey config: entity "${entName}" list.defaultSort must be a non-empty array`)
        }
        for (const s of sort) {
          if (!s || !fieldNames.has(s.field)) {
            throw new Error(`casey config: entity "${entName}" list.defaultSort references unknown field "${s?.field}"`)
          }
          if (s.dir && !['ASC', 'DESC'].includes(s.dir)) {
            throw new Error(`casey config: entity "${entName}" list.defaultSort field "${s.field}" has invalid dir "${s.dir}" (expected ASC or DESC)`)
          }
        }
      }
    }
  }

  // Read every entity.field { type: enum, options: [...] } declaration off the
  // same parsed config, so a deployment that adds/renames a case_type or
  // priority value in thatcher.config.yml is picked up everywhere that used to
  // carry its own hardcoded copy of the list (case-tools.js validation guards,
  // case_list/case_update tool-schema enums) with no code change. Shape:
  // { "<entity>.<field>": string[] }. Non-enum fields and entities with no
  // fields are simply absent -- callers fall back to their own default.
  _parseFieldEnums(cfg) {
    const out = {}
    for (const [entName, ent] of Object.entries(cfg?.entities || {})) {
      for (const [fieldName, def] of Object.entries(ent?.fields || {})) {
        if (def && def.type === 'enum' && Array.isArray(def.options)) {
          out[`${entName}.${fieldName}`] = [...def.options]
        }
      }
    }
    return out
  }

  // Config-declared enum options for entity.field (e.g. 'case.case_type',
  // 'case.priority'), or `fallback` when the config has no such enum (a
  // pre-init store, or a config that left the field free-text).
  getFieldEnum(entityDotField, fallback = []) {
    return this._fieldEnums?.[entityDotField] || fallback
  }

  // Close the underlying store cleanly (flush WAL, release handles).
  async close() {
    try { await this.thatcher?.stop?.() } catch { /* best effort */ }
    this.thatcher = null
  }

  // Validate a transition. Delegates to the xstate machine -- the single
  // authority on legality -- so an illegal move is rejected structurally. Throws
  // with the machine's reason (same message shape callers already surface).
  _validateTransition(fromState, toState, user) {
    const res = canTransition(this._machine, fromState, toState, user?.role)
    if (!res.ok) throw new Error(res.error)
  }

  get t() {
    if (!this.thatcher) throw new Error('CaseStore not initialised  --  call init() first')
    if (this._tProxy) return this._tProxy
    // SQLITE_BUSY retry proxy. thatcher rides busybase (an embedded sqlite store);
    // under concurrency a read/write can transiently fail with "SQLITE_BUSY:
    // database is locked" -- e.g. an agent turn's enquiry tool (case_list/case_get)
    // reading while casey writes the same turn's events. Without a retry that throws
    // out of runTurn and the worker sends the degraded fallback instead of the real
    // answer (the witnessed flaky enquiry). We wrap the mutating/reading methods in a
    // bounded retry with small linear backoff so a lock contends-and-recovers rather
    // than surfacing as a turn error. Bounded (never infinite), and only retries the
    // BUSY/locked class -- any other error propagates immediately.
    const RETRY_METHODS = new Set(['list', 'get', 'create', 'update', 'remove', 'delete'])
    const isBusy = (e) => /SQLITE_BUSY|database is locked|database table is locked/i.test(String(e?.message || e))
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const self = this
    this._tProxy = new Proxy(this.thatcher, {
      get(target, prop, recv) {
        const orig = Reflect.get(target, prop, recv)
        if (typeof orig !== 'function' || !RETRY_METHODS.has(prop)) return orig
        return async (...args) => {
          const MAX = 6
          for (let attempt = 0; ; attempt++) {
            try { return await orig.apply(target, args) }
            catch (e) {
              if (!isBusy(e) || attempt >= MAX) throw e
              self.log?.warn?.('[casey] sqlite busy; retrying', { method: String(prop), attempt: attempt + 1 })
              await sleep(15 * (attempt + 1))   // 15,30,45,... ms linear backoff
            }
          }
        }
      },
    })
    return this._tProxy
  }

  // thatcher (npm latest, currently >=1.0.37, well past the v1.0.13 fix floor)
  // create() now returns the locally-constructed record carrying the real genId
  // it stored in the TEXT id column -- confirmed live against the installed
  // node_modules/thatcher/src/lib/busybase-store.js create() (returns `record`
  // with `id: data.id || genId()`, never a rowid), and re-verified end-to-end
  // via a direct t.create()+t.get()-by-returned-id round trip against a fresh
  // embedded store. The uniqueWhere-list-and-pick-newest reload this function
  // used to need (because an older thatcher returned a rowid alias instead) is
  // dead weight now; trust the create() return directly. uniqueWhere is kept as
  // a parameter (unused) so every existing call site stays unchanged -- this is
  // a pure internal simplification, not a signature change.
  async _createReload(entity, data, user, _uniqueWhere) {
    return this.t.create(entity, data, user)
  }

  // ---- contacts -----------------------------------------------------------

  async findOrCreateContact({ channel, external_id, display_name, handle }) {
    const [existing] = await this.t.list('contact', { channel, external_id }, { limit: 1 })
    if (existing) return existing
    return this._createReload('contact', {
      channel, external_id,
      display_name: display_name || handle || external_id,
      handle: handle || '',
    }, SYSTEM_USER, { channel, external_id })
  }

  // ---- cases --------------------------------------------------------------

  // The conversation key (channel + external_id) is casey's identity for a
  // case. One open case per conversation; a new message to a closed case opens
  // a fresh one so history stays clean.
  //
  // Worst-case correctness: we must never miss an open case hidden behind a run
  // of more-recently-closed ones (that would double-create). We match every open
  // stage with a single `status: {$in: <open stages>}` predicate -- an ALLOWLIST,
  // deliberately not `{$ne: 'closed'}`: busybase only auto-filters soft-deleted
  // rows when `status` is absent from the where, so a `$ne` denylist would leak
  // `status='deleted'` rows, while the open-stage allowlist (which never contains
  // 'deleted') keeps them out for free. We still pick max created_at in JS because
  // this list() call sets no sort, so thatcher does not guarantee newest-first.
  async findOpenCase({ channel, external_id }) {
    // limit 200 (not 2): a worker who starts several fresh reports leaves N>2 open
    // cases sharing one (channel, external_id), and this query sets no sort, so a
    // small page could miss the newest -- rebinding to a stale complete case and
    // re-creating the completeReply dead-end. We page wide and pick the GLOBAL max
    // created_at across all open statuses in JS (the only ordering authority).
    const rows = await this.t.list(
      'case',
      { channel, external_id, status: { $in: this.getOpenStatuses() } },
      { limit: 200 },
    )
    let best = null
    for (const r of rows) if (!best || (r.created_at || 0) > (best.created_at || 0)) best = r
    return best
  }

  // The open (non-terminal) workflow stages -- every status except 'closed'. The
  // same finite open-stage set findOpenCase iterates; exposed so callers (e.g. the
  // boot resume sweep) can filter to cases that still want a reply without
  // duplicating the 'closed is the only terminal' knowledge.
  getOpenStatuses() { return Object.keys(this._wf || {}).filter(s => s !== 'closed') }

  async getCase(id) { return this.t.get('case', id) }

  async getContact(id) { return id ? this.t.get('contact', id) : null }

  // Every contact, most-recently-created first, for the dashboard's
  // Contacts/Reporters panel. Contacts carry no same-second-tiebreak requirement
  // (unlike events), so the sort pushes down to thatcher directly. Internal-team-
  // only surface (operator/admin), never exposed on the public /report form.
  async listContacts({ limit = 500 } = {}) {
    return this.t.list('contact', {}, { limit, sort: [{ field: 'created_at', dir: 'DESC' }] })
  }

  // Operator-assigned access-tier change (reporter <-> field_worker). NEVER
  // called from the agent/tool-call path (case-tools.js has no tool that can
  // reach this) -- only the dashboard's admin-gated /api/contacts/:id/tier
  // route and the CLI's break-glass path call this, matching the "operator-
  // assignable, never contact-self-service or LLM-settable" design.
  async setContactTier(contactId, tier, user = SYSTEM_USER) {
    if (tier !== 'reporter' && tier !== 'field_worker') throw new Error(`invalid tier: ${tier}`)
    return this.t.update('contact', contactId, { tier }, user)
  }

  // Operator-tunable health thresholds, persisted as an append-only audited
  // observation on a singleton `system` settings case (the same pattern the
  // runtime-event log uses). The LATEST `thresholds:<json>` observation is the
  // live value; absent any, callers fall back to DEFAULT_THRESHOLDS. Storing the
  // change as an event makes every tuning auditable for free -- no schema change,
  // no new entity, and a full history of who tightened what and when.
  async _settingsCaseId() {
    const { case: c } = await this.findOrCreateCase({
      channel: 'system', external_id: 'settings:thresholds',
      contact: { display_name: 'settings' },
    })
    return c.id
  }

  // Returns the latest persisted thresholds patch object, or null if none set.
  // Validation/merge over defaults is the caller's concern (src/thresholds.js).
  async getThresholdsPatch() {
    let id
    try { id = await this._settingsCaseId() } catch { return null }
    const events = await this.listEvents(id).catch(() => [])
    // Walk newest-first; the first parseable thresholds observation wins.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.kind !== 'observation' || typeof ev.text !== 'string') continue
      const m = ev.text.match(/^thresholds:(.+)$/s)
      if (!m) continue
      try { return JSON.parse(m[1]) } catch { continue }
    }
    return null
  }

  // Persist a thresholds patch as a new audited observation. The patch is the
  // already-validated/merged object; we store it verbatim so a later read replays
  // exactly what was accepted. Returns the stored patch.
  async setThresholdsPatch(patch, user) {
    const id = await this._settingsCaseId()
    await this.appendEvent(id, {
      kind: 'observation', actor: 'operator',
      text: `thresholds:${JSON.stringify(patch)}`,
      data: { keys: Object.keys(patch || {}), by: user?.id || user || 'operator' },
    })
    return patch
  }

  // The LIVE thresholds the sweep and /api/attention must both read at call time:
  // the persisted operator patch (if any) merged over a boot override (if any)
  // merged over DEFAULT_THRESHOLDS. Reading this per call -- not once at boot --
  // is what makes a PUT take effect immediately on the next sweep and the next
  // attention scan, the whole point of the tunable knob. A store read failure
  // falls back to the boot/default value rather than throwing.
  async resolveThresholds(bootOverride = null) {
    const base = bootOverride ? mergeThresholds(bootOverride).thresholds : DEFAULT_THRESHOLDS
    let patch = null
    try { patch = await this.getThresholdsPatch() } catch { patch = null }
    if (!patch) return base
    return mergeThresholds(patch, base).thresholds
  }

  // Singleton settings case holding the rolling fleet-health sweep log. Same
  // append-only-observation pattern as thresholds and the runtime-event log: each
  // SCHEDULED sweep persists its summary as one audited observation, so the trend
  // over time is auditable for free -- no schema change, no new entity.
  async _fleetHealthCaseId() {
    const { case: c } = await this.findOrCreateCase({
      channel: 'system', external_id: 'settings:fleet-health',
      contact: { display_name: 'fleet-health' },
    })
    return c.id
  }

  // Persist a sweep summary as a new audited observation. `summary` is the object
  // sweepCases returns ({scanned, flagged, cleared, breaches, errors, ...}); we add
  // a `ts` and a derived `degraded` flag and store it verbatim so a later read
  // replays exactly what the sweep saw. Returns the stored record.
  async recordSweepSummary(summary, now = Date.now()) {
    const errors = Array.isArray(summary?.errors) ? summary.errors : []
    const rec = {
      ts: now,
      scanned: summary?.scanned ?? 0,
      flagged: summary?.flagged ?? 0,
      cleared: summary?.cleared ?? 0,
      breaches: summary?.breaches && typeof summary.breaches === 'object' ? summary.breaches : {},
      errors,
      degraded: errors.length > 0,
    }
    const id = await this._fleetHealthCaseId()
    await this.appendEvent(id, {
      kind: 'observation', actor: 'system',
      text: `fleet-health:${JSON.stringify(rec)}`,
      data: { scanned: rec.scanned, flagged: rec.flagged, degraded: rec.degraded },
    })
    return rec
  }

  // Read the last N sweep summaries, newest-first. Returns {latest, history,
  // degraded}: `history` is up to N parsed records oldest->newest (for a trend
  // line), `latest` is the most recent (or null), `degraded` is the latest's flag.
  // A parse/read failure degrades to an empty history rather than throwing.
  async getFleetHealth(n = 50) {
    let id
    try { id = await this._fleetHealthCaseId() } catch { return { latest: null, history: [], degraded: false } }
    const events = await this.listEvents(id).catch(() => [])
    const recs = []
    for (const ev of events) {
      if (ev.kind !== 'observation' || typeof ev.text !== 'string') continue
      const m = ev.text.match(/^fleet-health:(.+)$/s)
      if (!m) continue
      try { recs.push(JSON.parse(m[1])) } catch { continue }
    }
    const history = recs.slice(Math.max(0, recs.length - Math.max(1, n)))
    const latest = history.length ? history[history.length - 1] : null
    return { latest, history, degraded: !!latest?.degraded }
  }

  // Singleton settings case holding the shift-handover marker. Same append-only
  // observation pattern as thresholds: 'Start of shift' stamps one audited
  // observation, and the handover digest reads the newest to scope "since last
  // shift". Scoped by timestamp, not operator id, so a rotating field team shares
  // one shift line regardless of who clicks.
  async _shiftCaseId() {
    const { case: c } = await this.findOrCreateCase({
      channel: 'system', external_id: 'settings:shift',
      contact: { display_name: 'shift' },
    })
    return c.id
  }

  // Stamp a new shift marker. Returns { ts, by }.
  async startShift(user, now = Date.now()) {
    const by = user?.id || user || 'operator'
    const id = await this._shiftCaseId()
    await this.appendEvent(id, {
      kind: 'observation', actor: 'operator',
      text: `shift-start:${now}`,
      data: { by },
    })
    return { ts: now, by }
  }

  // The newest shift marker, or null if no shift has been started. A read/parse
  // failure degrades to null rather than throwing -- a missing marker just means
  // the digest scopes the full window.
  async getShiftMarker() {
    let id
    try { id = await this._shiftCaseId() } catch { return null }
    const events = await this.listEvents(id).catch(() => [])
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.kind !== 'observation' || typeof ev.text !== 'string') continue
      const m = ev.text.match(/^shift-start:(\d+)$/)
      if (!m) continue
      const ts = parseInt(m[1], 10)
      if (!Number.isFinite(ts)) continue
      const by = (typeof ev.data === 'string' ? (() => { try { return JSON.parse(ev.data) } catch { return null } })() : ev.data)?.by || null
      return { ts, by }
    }
    return null
  }

  // A ref is unique, so a single-row lookup by ref needs no sort.
  async getCaseByRef(ref) {
    const [row] = await this.t.list('case', { ref }, { limit: 1 })
    return row || null
  }
  // Alias used by the enquiry/active-case tools (case_select by ref).
  // Persist the exported dstate conversation-state bundle on the case row. WRAPPED
  // in try/catch: until the published thatcher schema carries the conv_state field
  // (or on any write race), the update throws -- which must NEVER break a live turn.
  // On failure the conversation simply degrades to a fresh greeting machine next
  // turn (the report-derived prompt block still drives). Best-effort, never rethrows.
  async setConvState(caseId, blob) {
    if (!caseId) return
    try { await this.t.update('case', caseId, { conv_state: blob || '' }, SYSTEM_USER) }
    catch (e) { this.log?.debug?.('[casey] setConvState skipped (conv_state field unavailable)', { caseId, error: e.message }) }
  }

  // Explicitly branch a FRESH case for the worker (they asked to start one),
  // reusing the SAME (channel, external_id) as their existing conversation --
  // the real conversationKey, not a synthetic id -- so the very NEXT plain
  // inbound message correctly binds to THIS new case via the normal
  // findOrCreateCase/findOpenCase newest-wins path. (A prior createCase +
  // setActiveCase implementation minted a synthetic external_id and wrote to
  // contact.active_case_id, a field findOrCreateCase never reads -- the next
  // message silently kept talking to the OLD case. Fixed by keying on the
  // real conversation identity instead of a second, unread binding.) Locked on
  // the same key so two near-simultaneous "start a new report" turns cannot
  // duplicate.
  async createCase({ channel, external_id, subject = '', contact_id = '' } = {}) {
    return this._withLock(`${channel}|${external_id}`, async () => {
      const ref = await this._nextRef()
      return this._createReload('case', {
        ref, channel, external_id, contact_id: contact_id || '',
        subject, summary: '', priority: 'normal', tags: '',
        assignee: AGENT_USER.id, autonomy: 'auto', status: 'new', last_event_at: nowIso(),
      }, AGENT_USER, { ref })
    })
  }

  // List cases with an operator-aware where ({field:{$gte,$lte,$in,...}}, top-level
  // $or, bare-array IN) and an optional opts.user for row-access scoping. The new
  // worker-enquiry queries (today=created_at range, near=lat/lon box, mine=assignee
  // + user scope, open=status $in) ride these. thatcher's operator-where + row-access
  // + list sort all push down to the store directly (see the call below); there is
  // no feature-detect or JS-side fallback -- casey consumes thatcher via npm `latest`,
  // which has carried them since 1.0.30, so a pre-support install can never happen.
  // Three singleton `channel:'system'` cases (settings:thresholds, settings:
  // fleet-health, settings:shift) are created via findOrCreateCase, default to
  // status 'new', and never close -- they are audit-log carriers for operator-
  // tunable settings, never a real farmer report. Every internal reader of
  // settings state goes through _settingsCaseId()/findOrCreateCase + listEvents
  // directly, never listCases (confirmed: no call site filters or relies on a
  // system row appearing here) -- so excluding them by default is safe and
  // fixes every KPI/report/geo/workload/cluster consumer (which all call
  // listCases({}, ...) with no channel filter) at one chokepoint instead of
  // patching each one. includeSystem:true is the explicit opt-in escape hatch
  // for a caller that genuinely needs to see them (none exist today).
  async listCases(where = {}, opts = {}) {
    const { limit = 50, offset = 0, user = null, sort = null, includeSystem = false } = opts
    if (!includeSystem && where.channel === undefined) where = { ...where, channel: { $ne: 'system' } }
    // thatcher's operator-where compiler ($gte/$lte/$in/$or) has been in every
    // published version since 1.0.30; casey consumes thatcher exclusively via npm
    // `latest`, so the installed version can never be older than what casey was
    // built against (see package.json's thatcher floor). Call operator-where
    // directly -- no runtime feature-detect, no JS-side equality-only fallback.
    const rows = await this.t.list('case', where, {
      limit: Math.max(limit + offset, 1000),
      ...(user ? { user } : {}),
      sort: sort || [{ field: 'last_event_at', dir: 'DESC' }, { field: 'created_at', dir: 'DESC' }],
    })
    return rows.slice(offset, offset + limit)
  }

  // Returns the count of cases, capped at 50,000 for performance. If the true count
  // exceeds the cap, the returned value is an underestimate. The dashboard uses this
  // for pagination hints; the cap is sized to real-world casey volumes (dashboard
  // PAGE_MAX is 200, real case counts are far below the cap).
  async countCases(where = {}) {
    return this._count('case', where)
  }

  // Count via the public list() API: same module singleton as every other call,
  // backend-agnostic, and survives `npm ci` (no node_modules edit). The old cap
  // of 100000 hauled the whole table into JS on every dashboard poll (every 5s);
  // CAP is now sized to the real ceiling (dashboard PAGE_MAX is 200, real case
  // volumes are far below this), so the count is exact for casey's scale while
  // the 5s poll no longer materializes a 100k-row worst case.
  async _count(entity, where = {}) {
    const CAP = 50000
    const rows = await this.t.list(entity, where, { limit: CAP })
    return rows.length
  }

  // Run fn() serialized against every other call sharing the same lock key.
  // Calls chain onto the prior in-flight call for that key; the TAIL of the
  // chain owns cleanup -- it deletes the slot iff it is still the tail -- so the
  // map size is bounded by the count of *concurrently in-flight* keys, never by
  // total conversation history. prev.catch swallows an upstream rejection so one
  // failed call cannot wedge the chain; fn's own rejection still propagates out
  // of `await run` so this finally always fires. Do NOT drop the `=== run`
  // guard: without it a non-tail call would orphan the tail's slot.
  async _withLock(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => fn())
    this._locks.set(key, run)
    try { return await run }
    finally { if (this._locks.get(key) === run) this._locks.delete(key) }
  }

  // Serialize find-or-create per conversation so two near-simultaneous first
  // messages cannot both miss the open-case lookup and create duplicate cases.
  // The lock is per (channel, external_id); other conversations run concurrently.
  async findOrCreateCase(args) {
    return this._withLock(`${args.channel}|${args.external_id}`, () => this._findOrCreateCaseUnsafe(args))
  }

  // Record an inbound message exactly once, even under concurrent redelivery of
  // the same platform msg_id. Runs on the SAME per-conversation lock chain as
  // findOrCreateCase, so the dedup check and the append are atomic with respect
  // to other messages on this conversation -- two identical messages in the same
  // tick cannot both pass hasInboundMessage before either appends, making the
  // duplicate structurally unrepresentable. Returns the appended event, or null
  // if it was a duplicate already recorded. Guarantee holds only when the adapter
  // supplies a non-empty msg_id -- an empty msg_id (an adapter/raw payload with no
  // id) skips the dedup check entirely; the caller logs a warning in that case.
  async recordInbound(caseRow, { actor = 'contact', channel, text = '', data = null, msg_id = '' }) {
    return this._withLock(`${caseRow.channel}|${caseRow.external_id}`, async () => {
      if (msg_id && await this.hasInboundMessage(caseRow.id, msg_id)) return null
      return this.appendEvent(caseRow.id, { kind: 'inbound', actor, channel, text, data, msg_id })
    })
  }

  // Atomically merge partial report fields into a case's running report JSON.
  // Runs under the per-conversation lock so a fresh read-merge-write cannot race
  // another merge (or an inbound) for the same conversation and lose fields. Only
  // the fast DB round-trip is inside the lock -- LLM/network latency stays out.
  // Non-empty incoming values win; a known field is never overwritten with blank.
  // Returns { report } (the merged object) or { error } on guards.
  // Single chokepoint for the report-JSON safe-parse-with-fallback pattern that
  // was previously duplicated verbatim across several call sites (mergeReport,
  // mergeCases x2) -- any change to fallback/logging behavior now happens once
  // instead of drifting across copies.
  _parseReport(raw, caseId) {
    try { return raw ? JSON.parse(raw) : {} }
    catch (e) { this.log?.warn?.('[casey] report_parse_failed', { caseId, error: e.message }); return {} }
  }

  // Builds the merged report object from current+incoming; extracted so
  // mergeReport can retry the merge against a freshly re-read row on a
  // version conflict without duplicating the field-merge rules.
  _mergeReportFields(current, incoming) {
    const merged = { ...current }
    for (const [k, v] of Object.entries(incoming)) {
      if (v == null || String(v).trim() === '') continue
      // photos/audio/sites: a worker can give MULTIPLE across one
      // conversation (more than one photo, more than one distinct site
      // within the same visit) -- overwrite would silently discard every
      // one after the first (the same class of bug the deterministic
      // media-arrival path had, fixed via appendReportField). Every other
      // field is a single fact that genuinely replaces/refines its prior
      // value, so overwrite stays correct there.
      if ((k === 'photos' || k === 'audio' || k === 'sites') && merged[k] != null && String(merged[k]).trim() !== '' && String(merged[k]) !== String(v)) {
        merged[k] = `${merged[k]}; ${v}`
      } else {
        merged[k] = v
      }
    }
    return merged
  }

  async mergeReport(caseId, incoming, user = AGENT_USER) {
    const invalid = Object.keys(incoming).filter(k => !REPORT_KEYS.has(k))
    if (invalid.length) return { error: `invalid report fields: ${invalid.join(', ')}` }
    const c0 = await this.getCase(caseId)
    if (!c0) return { error: `no case ${caseId}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {
      const c = await this.getCase(caseId)             // re-read INSIDE the lock
      if (!c) return { error: `no case ${caseId}` }
      if (c.autonomy === 'observe') return { error: 'observe' }
      const merged = this._mergeReportFields(this._parseReport(c.report, caseId), incoming)
      const patch = { report: JSON.stringify(merged) }
      // No server-side geocoding: the map's lat/lon comes ONLY from the agent's
      // own case_report call (its own best-effort estimate from the location the
      // worker described, using the model's own world knowledge -- see
      // caseSystemPrompt). A case with no agent-provided lat/lon simply has no
      // map pin; casey never looks anything up on the model's behalf.
      //
      // The per-conversation lock (_withLock, keyed on channel|external_id)
      // only serializes THIS contact's own sequential agent turns -- it does
      // NOT cover a dashboard operator's PATCH on the same case id landing
      // concurrently (a genuinely different lock key, no lock at all today).
      // c._version (present when the installed thatcher supports the
      // optimistic-lock guard -- thatcher's npm `latest` always does; a
      // feature-detect-free direct read since casey never pins thatcher
      // behind latest) lets us detect that race instead of silently losing
      // whichever side wrote second. On a genuine conflict, re-read and
      // re-merge against the FRESH row (the operator's edit is preserved,
      // the agent's newly-learned fields are re-applied on top), retrying
      // with the same expectedVersion guard each time -- a THIRD writer
      // landing between re-read and re-write must re-trigger the same
      // conflict path rather than being silently clobbered by an
      // unconditional write. Bounded retries; surface (never silently
      // overwrite) if contention is somehow still live after that.
      const MERGE_RETRY_LIMIT = 3
      let attemptCase = c
      let attemptMerged = merged
      for (let attempt = 0; attempt <= MERGE_RETRY_LIMIT; attempt++) {
        try {
          await this.updateCase(caseId, { report: JSON.stringify(attemptMerged) }, user,
            attemptCase._version != null ? { expectedVersion: attemptCase._version } : {})
          return { report: attemptMerged }
        } catch (e) {
          if (e.code !== 'conflict') throw e
          if (attempt === MERGE_RETRY_LIMIT) {
            return { error: `report merge conflict on case ${caseId} after ${MERGE_RETRY_LIMIT} retries -- concurrent writers still contending, not applied` }
          }
          const fresh = await this.getCase(caseId)
          if (!fresh) return { error: `no case ${caseId}` }
          attemptCase = fresh
          attemptMerged = this._mergeReportFields(this._parseReport(fresh.report, caseId), incoming)
        }
      }
    })
  }

  // Append-only variant for a media field (photos/audio) whose deterministic
  // ingress note must NEVER be silently dropped just because an earlier note
  // already occupies the field. A worker routinely sends
  // MULTIPLE photos/voice notes across one conversation -- fill-if-empty would
  // silently discard every arrival after the first, with no field update AND no
  // operator-facing observation event (the exact bug this method fixes). Joins
  // with '; ' so every existing single-string reader (dashboard display, the
  // photo-nudge `!= null` check) keeps working unchanged -- no array, no schema
  // change downstream. Returns { report, appended:bool } or { error }.
  async appendReportField(caseId, field, note, user = AGENT_USER) {
    if (note == null || String(note).trim() === '') return { error: 'empty note' }
    const c0 = await this.getCase(caseId)
    if (!c0) return { error: `no case ${caseId}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {
      const c = await this.getCase(caseId)
      if (!c) return { error: `no case ${caseId}` }
      if (c.autonomy === 'observe') return { error: 'observe' }
      const current = this._parseReport(c.report, caseId)
      const have = current[field] != null && String(current[field]).trim() !== ''
      const next = { ...current, [field]: have ? `${current[field]}; ${note}` : String(note) }
      await this.updateCase(caseId, { report: JSON.stringify(next) }, user)
      return { report: next, appended: true }
    })
  }

  // Persist a downloaded media buffer (photo/voice note) to <dataDir>/media/<caseId>/
  // and return its path relative to dataDir. A photo/voice note is a one-shot
  // artifact -- once the worker leaves the site it cannot be recaptured -- so the
  // actual bytes are written to disk here rather than only ever noted as text
  // (the prior behaviour: "farmer sent a photo" with no photo anywhere). Failure
  // to write must never block the reply path -- callers catch and log, same
  // discipline as appendReportField's own callers.
  saveMedia(caseId, buffer, { mimeType = '', kind = 'file' } = {}) {
    const dir = path.join(this.dataDir, 'media', String(caseId))
    fs.mkdirSync(dir, { recursive: true })
    const ext = (mimeType.split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '') || 'bin'
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}-${kind}.${ext}`
    const full = path.join(dir, name)
    fs.writeFileSync(full, buffer)
    // Forward slashes always -- this value is embedded in a /media/<path> URL
    // (dashboard/server.js), not just used for a local fs.join, so a Windows
    // backslash join here would break the link on the very platform that produced it.
    return `media/${caseId}/${name}`
  }

  // OPERATOR IDENTITY LEARNING -- a durable per-operator record layered on top of
  // the static CASEY_OPERATORS roster. Operators only ever act through the
  // dashboard (never a direct Discord/WhatsApp reply -- confirmed: every
  // actor:'operator' event is dashboard-attributed via X-Casey-Operator), so this
  // learns from dashboard-attributed actions only: which case a known operator id
  // acted on, and that case's report location -- building a working-area history
  // per operator over time. One row per operator id (upsert), never a growing
  // history table (row_access: none in thatcher.config.yml -- internal-team data,
  // gated by the dashboard's own token auth, never exposed on the public /report
  // surface).
  async _operatorIdentityRow(operatorId) {
    const [row] = await this.t.list('operator_identity', { operator_id: operatorId }, { limit: 1 })
    return row || null
  }

  _parseJsonArray(raw) {
    try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : [] }
    catch { return [] }
  }

  // Record that `operatorId` (a CASEY_OPERATORS roster id) acted on `caseRow` --
  // called from the dashboard on every attributed claim/reply/transition/edit.
  // Learns the case's channel identity (channel + external_id -- the contact's
  // channel, which tells us NOTHING about the operator's own channel id, so this
  // does not claim to learn a Discord/WhatsApp handle for the operator; it learns
  // WORKING AREA from the case's report location) and bumps case_count/last_seen.
  // Best-effort: a failure here must never break the dashboard action it rides on.
  async learnOperatorActivity(operatorId, caseRow) {
    if (!operatorId || !caseRow) return null
    try {
      const existing = await this._operatorIdentityRow(operatorId)
      const areas = existing ? this._parseJsonArray(existing.areas) : []
      const report = this._parseReport(caseRow.report, caseRow.id)
      const locToks = [...tokens(report.location)]
      for (const t of locToks) {
        const i = areas.findIndex(a => a.token === t)
        if (i >= 0) areas[i].count = (areas[i].count || 0) + 1
        else areas.push({ token: t, count: 1 })
      }
      // Cap the area list so a long-lived operator's record does not grow
      // unbounded -- keep the most-frequent areas, a bounded working-area
      // profile rather than a full history.
      areas.sort((a, b) => (b.count || 0) - (a.count || 0))
      const boundedAreas = areas.slice(0, 40)
      const patch = {
        operator_id: operatorId,
        areas: JSON.stringify(boundedAreas),
        last_seen_at: nowIso(),
        case_count: (existing?.case_count || 0) + 1,
      }
      if (existing) await this.t.update('operator_identity', existing.id, patch, SYSTEM_USER)
      else await this.t.create('operator_identity', { ...patch, channel_ids: '[]' }, SYSTEM_USER)
      return patch
    } catch { return null }   // learning is best-effort, never blocks the caller's real action
  }

  // Every learned operator-identity row, for the dashboard's coverage view.
  async listOperatorIdentities() {
    try { return await this.t.list('operator_identity', {}, { limit: 500 }) }
    catch { return [] }
  }

  async _findOrCreateCaseUnsafe({ channel, external_id, contact, subject }) {
    const open = await this.findOpenCase({ channel, external_id })
    if (open) return { case: open, created: false }

    const contactRow = contact
      ? await this.findOrCreateContact({ channel, external_id, ...contact })
      : null

    const ref = await this._nextRef()
    const created = await this._createReload('case', {
      ref,
      channel, external_id,
      contact_id: contactRow?.id || '',
      subject: subject || '',
      summary: '',
      priority: 'normal',
      tags: '',
      assignee: 'agent',
      autonomy: 'auto',
      status: 'new',                 // workflow start stage (explicit; thatcher create() defaults to ACTIVE otherwise)
      last_event_at: nowIso(),
    }, AGENT_USER, { ref })
    return { case: created, created: true }
  }

  // Friendly, collision-proof case ref. The numeric part is a best-effort
  // human-friendly sequence taken as the max over a capped page of cases; we scan
  // every returned row and take Math.max, so ordering is irrelevant here (we pass
  // no sort). UNIQUENESS does not depend on the sequence: the random suffix
  // guarantees it even if two creators read the same max concurrently or the
  // highest case falls outside the page.
  async _nextRef() {
    let seq = 1000
    const recent = await this.t.list('case', {}, { limit: 200 })
    for (const r of recent) {
      const m = /^CASE-(\d+)/.exec(r.ref || '')
      if (m) seq = Math.max(seq, parseInt(m[1], 10))
    }
    return `CASE-${seq + 1}-${randomSuffix()}`
  }

  // opts.expectedVersion: forwarded straight to thatcher's optimistic-concurrency
  // guard (installed thatcher's update() reads opts.expectedVersion natively and
  // adds a `_version = ?` filter). On a version mismatch thatcher throws
  // {code:'conflict'}; this rethrows for the caller to handle (mergeReport retries
  // once, see below).
  async updateCase(id, patch, user = AGENT_USER, opts = {}) {
    const violation = writeGuardViolation(patch, user)
    if (violation) throw new Error(violation)
    await this.t.update('case', id, { ...patch, last_event_at: nowIso() }, user, opts)
    return this.getCase(id)
  }

  // Metadata-only update that does NOT touch last_event_at -- used by the health
  // sweep to set/clear health:* tags. Stamping recency here would corrupt the very
  // signal staleness is measured from (a swept stale case would look freshly
  // active), so the guardrail must never perturb the field it reads (P1).
  async updateCaseQuiet(id, patch, user = SYSTEM_USER) {
    const violation = writeGuardViolation(patch, user)
    if (violation) throw new Error(violation)
    await this.t.update('case', id, patch, user)
    return this.getCase(id)
  }

  // Narrow convenience for a caller (case-tools.js's case_report handler) that
  // wants to refresh a DERIVED_ONLY field as the system actor without reaching
  // for updateCaseQuiet directly and risking a future caller widening the patch
  // to a non-derived field. Rejects any key outside DERIVED_ONLY_FIELDS itself,
  // as a second, narrower layer on top of writeGuardViolation's own check.
  async systemUpdateDerived(id, patch) {
    const bad = Object.keys(patch || {}).filter(k => !DERIVED_ONLY_FIELDS.has(k))
    if (bad.length) throw new Error(`systemUpdateDerived: not a derived-only field: ${bad.join(', ')}`)
    return this.updateCaseQuiet(id, patch, SYSTEM_USER)
  }

  // Re-point / edit a single timeline event. The one primitive merge and split
  // need: moving an event between cases is a case_id update, never a delete +
  // recreate (which would lose created_at ordering and the audit id). Used only
  // by mergeCases / splitCase, both of which run under a lock.
  async updateEvent(id, patch, user = SYSTEM_USER) {
    await this.t.update('event', id, patch, user)
    return this.t.get('event', id)
  }

  // Walk a case to 'closed' through valid transitions (multi-hop), as the admin
  // SYSTEM_USER so the operator-only 'closed' gate is satisfied. Used when a case
  // is folded into another by a merge: the source must leave the open-case set so
  // findOpenCase never reuses an emptied shell. Tolerates an already-closed case.
  async _forceClose(caseId, reason, user = SYSTEM_USER) {
    for (let hop = 0; hop < Object.keys(this._wf).length + 1; hop++) {
      const c = await this.getCase(caseId)
      if (!c || c.status === 'closed') return c
      const avail = this.availableTransitions(c, user)
      // Prefer a forward step toward resolved/closed; else take any valid step.
      const next = avail.find(s => s === 'closed') || avail.find(s => s === 'resolved')
        || avail.find(s => ['in_progress', 'triaging', 'waiting'].includes(s)) || avail[0]
      if (!next) return c   // dead end: leave it where it is rather than throw
      await this.transition(caseId, next, { user, reason })
    }
    return this.getCase(caseId)
  }

  // ---- merge / split: post-hoc correction of case grouping ----------------
  //
  // Identity by channel|external_id is a first guess, not ground truth: the same
  // outbreak arrives across two numbers, or one contact reports two unrelated
  // outbreaks on one thread. So grouping must be CORRECTABLE after the fact.
  //
  // mergeCases folds `source` into `target` (target stays canonical). It is:
  // - LOSSLESS  : every source event is re-pointed to target, never deleted.
  // - IDEMPOTENT: a source already merged (tagged 'merged', no remaining own
  //                 events) is a no-op -- safe to retry after a partial failure.
  // Report merge is fill-if-empty so the canonical target never loses a value it
  // already held; tags are unioned. The source is left as an audited redirect and
  // walked out of the open-case set so findOpenCase never reuses it.
  async mergeCases(sourceId, targetId, user = AGENT_USER, { reason = '' } = {}) {
    if (sourceId === targetId) return { error: 'cannot merge a case into itself' }
    const src0 = await this.getCase(sourceId)
    const tgt0 = await this.getCase(targetId)
    if (!src0) return { error: `no case ${sourceId}` }
    if (!tgt0) return { error: `no case ${targetId}` }
    if (tgt0.autonomy === 'observe') return { error: 'observe' }
    if (src0.autonomy === 'observe') return { error: 'observe' }
    // Lock the TARGET conversation: merge mutates the target's report/tags and
    // re-homes events onto it, so it must serialize against target-side writes.
    const srcKey = `${src0.channel}|${src0.external_id}`
    const tgtKey = `${tgt0.channel}|${tgt0.external_id}`
    const mergeFn = async () => {
      const src = await this.getCase(sourceId)
      const tgt = await this.getCase(targetId)
      if (!src || !tgt) return { error: 'case vanished during merge' }
      if (tgt.autonomy === 'observe') return { error: 'observe' }
      if (src.autonomy === 'observe') return { error: 'observe' }
      const srcTags = new Set((src.tags || '').split(',').map(s => s.trim()).filter(Boolean))
      // Idempotency: a source already folded in is tagged 'merged'. Retrying the
      // merge (e.g. after a crash between steps) must not move its redirect note
      // or transition residue onto the target a second time -- the tag is the
      // durable "already done" marker, independent of how many audit events the
      // close left behind.
      if (srcTags.has('merged')) {
        return { merged: true, alreadyMerged: true, target: tgt, movedEvents: 0 }
      }
      // Move only the REAL report events, not audit residue a prior step wrote.
      const srcEvents = await this.listEvents(sourceId)
      // 1) Re-point every source event onto the target -- lossless.
      for (const ev of srcEvents) await this.updateEvent(ev.id, { case_id: targetId })
      // 2) Fill-if-empty report merge (target value wins -- it is canonical).
      const srcReport = this._parseReport(src.report, sourceId)
      const tgtReport = this._parseReport(tgt.report, targetId)
      const mergedReport = { ...tgtReport }
      for (const [k, v] of Object.entries(srcReport)) {
        if (!REPORT_KEYS.has(k)) continue
        const have = tgtReport[k] != null && String(tgtReport[k]).trim() !== ''
        if (!have && v != null && String(v).trim() !== '') mergedReport[k] = v
      }
      // 3) Union tags onto target (drop the internal 'merged' marker).
      const tgtTags = new Set((tgt.tags || '').split(',').map(s => s.trim()).filter(Boolean))
      for (const tg of srcTags) if (tg !== 'merged') tgtTags.add(tg)
      await this.updateCase(targetId, {
        report: JSON.stringify(mergedReport),
        tags: [...tgtTags].join(','),
      }, user)
      await this.appendEvent(targetId, {
        kind: 'note', actor: user.role === 'agent' ? 'agent' : 'operator',
        text: `Merged in ${src.ref} (${srcEvents.length} event(s))${reason ? ` -- ${reason}` : ''}.`,
        data: { merged_from: sourceId, merged_from_ref: src.ref, moved_events: srcEvents.length, reason },
      })
      // 4) Close the source first, then tag it as merged redirect.
      // _forceClose must succeed BEFORE writing 'merged' tag -- if we tag first
      // and then close fails, the source is stuck as 'merged' but still open,
      // and the idempotency check (srcTags.has('merged')) would skip it on retry.
      const closed = await this._forceClose(sourceId, `merged into ${tgt.ref}`, SYSTEM_USER)
      if (!closed || closed.status !== 'closed') {
        return { error: 'merge partial: source could not be closed', status: closed?.status }
      }
      await this.updateCase(sourceId, {
        tags: [...srcTags, 'merged'].filter((v, i, a) => a.indexOf(v) === i).join(','),
        summary: `Merged into ${tgt.ref}. See that case for the full report.`,
      }, user)
      await this.appendEvent(sourceId, {
        kind: 'note', actor: user.role === 'agent' ? 'agent' : 'operator',
        text: `This report was merged into ${tgt.ref}${reason ? ` -- ${reason}` : ''}.`,
        data: { merged_into: targetId, merged_into_ref: tgt.ref, reason },
      })
      return { merged: true, alreadyMerged: false, target: await this.getCase(targetId), source: await this.getCase(sourceId), movedEvents: srcEvents.length }
    }
    if (srcKey === tgtKey) return this._withLock(tgtKey, mergeFn)
    const [key1, key2] = [srcKey, tgtKey].sort()
    return this._withLock(key1, () => this._withLock(key2, mergeFn))
  }

  // splitCase carves a subset of a case's events into a NEW case -- the inverse
  // correction, for when one thread turns out to hold two distinct outbreaks.
  // The named events are re-pointed (the source loses them; the new case gains
  // them) and both cases get a linking note. Honest by construction (P10): the
  // new case starts with an EMPTY report -- we do not pretend to perfectly
  // partition the original's merged report; an operator/agent re-states the new
  // case's facts. Guards: empty selection, events not on the source, and a split
  // that would empty the source (that is a no-op, not a split).
  async splitCase(sourceId, eventIds, { subject = '', reason = '' } = {}, user = AGENT_USER) {
    const ids = [...new Set((eventIds || []).filter(Boolean))]
    if (!ids.length) return { error: 'no events selected to split out' }
    const src0 = await this.getCase(sourceId)
    if (!src0) return { error: `no case ${sourceId}` }
    if (src0.autonomy === 'observe') return { error: 'observe' }
    return this._withLock(`${src0.channel}|${src0.external_id}`, async () => {
      const src = await this.getCase(sourceId)
      if (!src) return { error: 'case vanished during split' }
      if (src.autonomy === 'observe') return { error: 'observe' }
      const all = await this.listEvents(sourceId)
      const byId = new Map(all.map(e => [e.id, e]))
      for (const id of ids) if (!byId.has(id)) return { error: `event ${id} is not on case ${src.ref}` }
      if (ids.length >= all.length) return { error: 'cannot split out every event -- that would empty the source case' }
      const ref = await this._nextRef()
      const created = await this._createReload('case', {
        ref, channel: src.channel, external_id: src.external_id,
        contact_id: src.contact_id || '', subject: (subject && String(subject).trim()) || `Split from ${src.ref}`,
        summary: '', report: '', priority: src.priority || 'normal',
        tags: 'split', assignee: src.assignee || 'agent', autonomy: src.autonomy || 'auto',
        status: 'new', last_event_at: nowIso(),
      }, AGENT_USER, { ref })
      for (const id of ids) await this.updateEvent(id, { case_id: created.id })
      await this.appendEvent(created.id, {
        kind: 'note', actor: user.role === 'agent' ? 'agent' : 'operator',
        text: `Split out of ${src.ref} (${ids.length} event(s))${reason ? ` -- ${reason}` : ''}.`,
        data: { split_from: sourceId, split_from_ref: src.ref, moved_events: ids.length, reason },
      })
      await this.appendEvent(sourceId, {
        kind: 'note', actor: user.role === 'agent' ? 'agent' : 'operator',
        text: `${ids.length} event(s) split out into ${ref}${reason ? ` -- ${reason}` : ''}.`,
        data: { split_into: created.id, split_into_ref: ref, moved_events: ids.length, reason },
      })
      return { split: true, newCase: await this.getCase(created.id), source: await this.getCase(sourceId), movedEvents: ids.length }
    })
  }

  // ---- timeline / events --------------------------------------------------

  async appendEvent(caseId, { kind, actor = 'system', channel, text = '', data = null, msg_id = '', touch = true }) {
    // Do not pass created_at: thatcher stamps it as a unix-seconds integer on
    // create(). Passing an ISO string would just be overwritten, leaving the
    // column's type ambiguous. The dashboard formats the integer for display.
    const ev = await this.t.create('event', {
      case_id: caseId,
      kind, actor, channel: channel || '',
      text,
      data: data ? JSON.stringify(data) : '',
      msg_id: msg_id || '',
    }, AGENT_USER)
    // Touch the case so dashboards sort by recency. A failure here is a real
    // problem (the timeline and the case row diverge), so surface it rather than
    // swallowing it. touch=false for system notes that must NOT count as activity
    // (the health sweep -- its own observation must not reset the staleness clock
    // it measures from, or a stale case would look freshly active after a sweep).
    if (touch) {
      try {
        await this.t.update('case', caseId, { last_event_at: nowIso() }, AGENT_USER)
      } catch (e) {
        // error, not warn: the timeline and the case row have genuinely diverged
        // (the event persisted, last_event_at did not), so this must be visible --
        // but we do NOT throw, or every appendEvent caller would have to handle a
        // touch failure that does not affect the event it just wrote.
        this.log?.error?.('case touch after appendEvent failed -- last_event_at is now stale for this case', { caseId, error: e.message })
      }
    }
    return ev
  }

  // Chronological (oldest-first). We sort in JS rather than via thatcher's list
  // sort because created_at is coarse unix-SECONDS: a whole turn's events share one
  // second, and thatcher's comparator has no insertion-order tiebreak, so pushing
  // the sort down would scramble same-second order. The JS stable sort keeps
  // insertion order on ties (see sortByCreatedStable) -- load-bearing for replay.
  async listEvents(caseId, opts = {}) {
    // Default high, not 200: merge/split and conversation-context callers need the
    // WHOLE timeline -- a silent 200/1000 cap drops events on a long case, losing
    // history on merge and miscounting the empty-source guard on split (P1/P9).
    // Explicit-limit callers (case_get's 30) still win.
    const rows = await this.t.list('event', { case_id: caseId }, { ...opts, limit: opts.limit ?? 10000 })
    return byCreatedAscList(rows)
  }

  // Paged, newest-first window for the dashboard timeline. We sort the full set
  // newest-first in JS (same coarse-seconds stable-tiebreak reason as listEvents),
  // then apply the page window, so paging stays correct on same-second events.
  async listEventsPage(caseId, { limit = 50, offset = 0 } = {}) {
    const rows = byCreatedDescList(await this.t.list('event', { case_id: caseId }, { limit: 1000 }))
    return rows.slice(offset, offset + limit)
  }

  async countEvents(caseId) {
    return this._count('event', { case_id: caseId })
  }

  // Cross-case event stream for the activity/audit view. Unscoped by case but
  // where-filterable by kind/actor (validated by the caller against known enums);
  // returned newest-first and capped so a huge log cannot blow the response. The
  // case_id stays on each row so the UI can deep-link back to the case.
  async listAllEvents({ kind = null, actor = null } = {}, { limit = 200 } = {}) {
    const where = {}
    if (kind) where.kind = kind
    if (actor) where.actor = actor
    const rows = byCreatedDescList(await this.t.list('event', where, { limit: 10000 }))
    return rows.slice(0, Math.max(1, limit))
  }

  // Has this exact platform message already been recorded? Used to dedup webhook
  // / gateway redeliveries so a retried message is not answered twice.
  async hasInboundMessage(caseId, msgId) {
    if (!msgId) return false
    const rows = await this.t.list('event', { case_id: caseId, msg_id: msgId }, { limit: 1 })
    return rows.length > 0
  }

  // ---- workflow -----------------------------------------------------------

  // The valid workflow statuses, from the parsed config -- the single source of
  // truth callers (e.g. the dashboard status filter) validate against, so an
  // arbitrary ?status= never reaches thatcher.
  getValidStatuses() { return Object.keys(this._wf || {}) }

  availableTransitions(caseRow, user = AGENT_USER) {
    return nextStates(this._machine, caseRow.status, user?.role)
  }

  // Transition a case and record it on the timeline in one step.
  async transition(caseId, toState, { user = AGENT_USER, reason = '' } = {}) {
    const before = await this.getCase(caseId)
    if (!before) throw new Error(`no case ${caseId}`)
    // A no-op move to the current stage is not a real change: skip it so we do
    // not record a junk event or re-notify the contact.
    if (before.status === toState) return before
    this._validateTransition(before.status, toState, user)
    await this.t.update('case', caseId, {
      status: toState,
      transition_reason: reason || '',
      last_event_at: nowIso(),
    }, user)
    const result = await this.getCase(caseId)
    await this.appendEvent(caseId, {
      kind: 'transition',
      actor: user.role === 'agent' ? 'agent' : 'operator',
      text: `${before.status} -> ${toState}${reason ? ` (${reason})` : ''}`,
      data: { from: before.status, to: toState, by: user.id, reason },
    })
    // Proactive contact note. Isolated: a notify failure must not fail the
    // operator's transition (the stage change already committed).
    if (this.onTransition) {
      try { await this.onTransition({ caseRow: result, from: before.status, to: toState, user, reason }) }
      catch (e) {
        this.log?.warn?.('[casey] onTransition hook failed', { caseId, to: toState, error: e.message })
        try { await this.appendEvent(caseId, { kind: 'observation', actor: 'system', text: `Stage notification failed: ${e.message}` }) }
        catch (e2) { this.log?.error?.('[casey] failed to record onTransition hook failure', { caseId, error: e2.message }) }
      }
    }
    return result
  }
}

function nowIso() {
  // CaseStore runs in the casey process (not the workflow sandbox), so Date is fine here.
  return new Date().toISOString()
}

// Event ordering: created_at is a unix-SECONDS integer (coarse -- a whole turn's
// events routinely share one second), and thatcher's id is a time-prefixed string
// with a RANDOM suffix, so the id is NOT a reliable insertion-order tiebreaker:
// within one second, two events sort by their random suffixes, scrambling order.
// What IS reliable is thatcher's raw list order, which preserves insertion order
// (witnessed). So we sort by created_at with a STABLE sort that breaks ties by the
// row's original index in the input -- insertion order is preserved exactly on a
// tie, and positional logic (resume completed-after, timeline replay) is
// deterministic. ordered(rows, dir) is the only sort entry point; it never tie-
// breaks on the id. (A prior version tie-broke on id assuming monotonic integer
// ids -- false for thatcher's random-suffix ids -- and made the resume sweep flaky.)
const ca = (r) => (r?.created_at || 0)
function sortByCreatedStable(rows, dir) {
  // Decorate with the input index, sort by (created_at, index), undecorate. The
  // index tiebreak keeps same-second events in arrival order regardless of the
  // engine's sort stability or the id's unsortable suffix.
  return rows
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => dir * (ca(a.row) - ca(b.row)) || (a.idx - b.idx))
    .map(x => x.row)
}
function byCreatedAscList(rows) { return sortByCreatedStable(rows, 1) }
function byCreatedDescList(rows) { return sortByCreatedStable(rows, -1) }

// The ref is the sole "secret" gating the unauthenticated public /report form
// (see dashboard/server.js) -- a farmer's phone, symptoms, and location are all
// readable and writable by anyone who can guess it, AND it is the one code a
// field worker must read back over a bad phone line or retype by hand. Balance:
// 8 chars from a 32-symbol unambiguous alphabet (no 0/O/1/I/l confusion, no
// vowel-adjacent pairs that sound alike read aloud) is ~40 bits of entropy --
// far stronger than the old Math.random() ~26-bit/5-char suffix, while staying
// short and speakable, unlike a full-entropy base64url string (dense mixed-case
// + symbols, hard to read/say/type accurately). crypto.randomBytes is the
// entropy source; each byte is reduced mod 32 into the alphabet (a benign
// bias -- this is an unguessability-vs-readability tradeoff, not a keyed secret
// requiring perfectly uniform output).
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'   // 32 symbols, no 0/O/1/I/l
function randomSuffix() {
  const bytes = randomBytes(8)
  let s = ''
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length]
  return s
}

export function createCaseStore(opts) { return new CaseStore(opts) }
