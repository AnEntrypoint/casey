// case-store.js  --  casey's wrapper over thatcher (the system of record).
//
// Single chokepoint for every case mutation, so the timeline stays append-only
// and each change becomes an audited `event` row.
//
// Only the public Thatcher instance methods are used. Importing thatcher's deep
// internals (getDatabase, workflow-engine) forks the module graph into a second
// instance with its own DB handle, making the real tables invisible. So the
// workflow graph is parsed from the config here, and transitions apply via the
// public update() (the published thatcher's transition() also throws -- it
// calls executeHook without importing it; fixed in the fork).

import { createThatcher } from 'thatcher'
import path from 'node:path'
import fs from 'node:fs'
import yaml from 'js-yaml'

// Principals casey acts as. role:agent satisfies normal requires_role gates.
export const AGENT_USER = { id: 'casey-agent', role: 'agent' }
export const SYSTEM_USER = { id: 'casey-system', role: 'admin' }

export class CaseStore {
  constructor(opts = {}) {
    this.configPath = opts.config || path.resolve(process.cwd(), 'thatcher.config.yml')
    // thatcher always opens <cwd>/data/app.db regardless of the databasePath
    // option (see header note). We therefore standardise on that path and let
    // callers relocate the whole DB only by changing cwd. databasePath here is
    // informational / used by tests that wipe the file.
    this.databasePath = opts.databasePath || path.resolve(process.cwd(), 'data', 'app.db')
    this.workflow = opts.workflow || 'case_lifecycle'
    this.log = opts.log || null
    // Optional hook fired AFTER a real stage change commits:
    //   onTransition({ caseRow, from, to, user, reason }) -> Promise|void
    // Best-effort: failures are caught and logged, never block the transition.
    // Null in the dashboard-only and test wirings, so transition() must tolerate it.
    this.onTransition = opts.onTransition || null
    this.thatcher = null
    this._wf = null            // parsed workflow stage graph
    this._locks = new Map()    // per-conversation find-or-create serialization
  }

  async init() {
    if (this.thatcher) return this
    if (!fs.existsSync(this.configPath)) throw new Error(`casey config not found: ${this.configPath}`)
    // Parse + validate the config before booting thatcher so a malformed config
    // fails fast with a clear message instead of a cryptic runtime error later.
    const cfg = yaml.load(fs.readFileSync(this.configPath, 'utf8'))
    this._wf = this._validateConfig(cfg)

    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true })
    this.thatcher = createThatcher({
      config: this.configPath,
      server: { hotReload: false },
    })
    await this.thatcher.init()
    return this
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
    return graph
  }

  // Close the underlying store cleanly (flush WAL, release handles).
  async close() {
    try { await this.thatcher?.stop?.() } catch { /* best effort */ }
    this.thatcher = null
  }

  // Validate a transition against the parsed stage graph + role gates.
  _validateTransition(fromState, toState, user) {
    const from = this._wf[fromState]
    const to = this._wf[toState]
    if (!from) throw new Error(`invalid current stage "${fromState}"`)
    if (!to) throw new Error(`invalid target stage "${toState}"`)
    const allowed = [...from.forward, ...from.backward]
    if (!allowed.includes(toState))
      throw new Error(`cannot move ${fromState} -> ${toState}; allowed: ${allowed.join(', ') || 'none'}`)
    if (to.requires_role.length && user && !to.requires_role.includes(user.role))
      throw new Error(`role "${user.role}" cannot enter "${toState}" (requires ${to.requires_role.join('/')})`)
  }

  get t() {
    if (!this.thatcher) throw new Error('CaseStore not initialised  --  call init() first')
    return this.thatcher
  }

  // thatcher's create() returns a record whose `id` is the integer rowid alias
  // (lastInsertRowid), NOT the genId it actually stored in the TEXT id column.
  // So we never trust the returned id: we create, then reload the canonical row
  // by a unique filter to recover the real id.
  async _createReload(entity, data, user, uniqueWhere) {
    await this.t.create(entity, data, user)
    const [row] = await this.t.list(entity, uniqueWhere, { limit: 1, orderBy: 'created_at', order: 'desc' })
    if (!row) throw new Error(`created ${entity} but could not reload by ${JSON.stringify(uniqueWhere)}`)
    return row
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
  async findOpenCase({ channel, external_id }) {
    const rows = await this.t.list('case', { channel, external_id }, { limit: 25, orderBy: 'created_at', order: 'desc' })
    return rows.find(c => c.status !== 'closed') || null
  }

  async getCase(id) { return this.t.get('case', id) }

  async getContact(id) { return id ? this.t.get('contact', id) : null }

  async listCases(where = {}, opts = {}) {
    return this.t.list('case', where, { limit: 50, orderBy: 'last_event_at', order: 'desc', ...opts })
  }

  async countCases(where = {}) {
    return this._count('case', where)
  }

  // Count via the public list() API so we never fork thatcher's module graph
  // (and so this works across thatcher's better-sqlite3 and busybase backends).
  // thatcher has no count mode, so we list ids with a high cap and measure.
  async _count(entity, where = {}) {
    const rows = await this.t.list(entity, where, { limit: 100000 })
    return rows.length
  }

  // Serialize find-or-create per conversation so two near-simultaneous first
  // messages cannot both miss the open-case lookup and create duplicate cases.
  // The lock is per (channel, external_id); other conversations run concurrently.
  async findOrCreateCase(args) {
    const key = `${args.channel}|${args.external_id}`
    const prev = this._locks.get(key) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => this._findOrCreateCaseUnsafe(args))
    this._locks.set(key, run)
    try { return await run }
    finally { if (this._locks.get(key) === run) this._locks.delete(key) }
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

  // Friendly, collision-proof case ref. Derives the sequence from the most
  // recent cases (public list(), capped) rather than scanning the whole table,
  // so creation stays bounded as volume grows. The random suffix guarantees
  // uniqueness even if two creators read the same max concurrently.
  async _nextRef() {
    let seq = 1000
    const recent = await this.t.list('case', {}, { limit: 200, orderBy: 'created_at', order: 'desc' })
    for (const r of recent) {
      const m = /^CASE-(\d+)/.exec(r.ref || '')
      if (m) seq = Math.max(seq, parseInt(m[1], 10))
    }
    return `CASE-${seq + 1}-${randomSuffix()}`
  }

  async updateCase(id, patch, user = AGENT_USER) {
    await this.t.update('case', id, { ...patch, last_event_at: nowIso() }, user)
    return this.getCase(id)
  }

  // ---- timeline / events --------------------------------------------------

  async appendEvent(caseId, { kind, actor = 'system', channel, text = '', data = null, msg_id = '' }) {
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
    // swallowing it.
    try {
      await this.t.update('case', caseId, { last_event_at: nowIso() }, AGENT_USER)
    } catch (e) {
      this.log?.warn?.('case touch after appendEvent failed', { caseId, error: e.message })
    }
    return ev
  }

  async listEvents(caseId, opts = {}) {
    return this.t.list('event', { case_id: caseId }, { limit: 200, orderBy: 'created_at', order: 'asc', ...opts })
  }

  // Paged, newest-first window for the dashboard timeline.
  async listEventsPage(caseId, { limit = 50, offset = 0 } = {}) {
    return this.t.list('event', { case_id: caseId }, { limit, offset, orderBy: 'created_at', order: 'desc' })
  }

  async countEvents(caseId) {
    return this._count('event', { case_id: caseId })
  }

  // Has this exact platform message already been recorded? Used to dedup webhook
  // / gateway redeliveries so a retried message is not answered twice.
  async hasInboundMessage(caseId, msgId) {
    if (!msgId) return false
    const rows = await this.t.list('event', { case_id: caseId, msg_id: msgId }, { limit: 1 })
    return rows.length > 0
  }

  // ---- workflow -----------------------------------------------------------

  availableTransitions(caseRow, user = AGENT_USER) {
    const from = this._wf[caseRow.status]
    if (!from) return []
    return [...from.forward, ...from.backward].filter(to => {
      const rr = this._wf[to]?.requires_role || []
      return !rr.length || (user && rr.includes(user.role))
    })
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
      catch (e) { this.log?.warn?.('onTransition hook failed', { caseId, to: toState, error: e.message }) }
    }
    return result
  }
}

function nowIso() {
  // CaseStore runs in the casey process (not the workflow sandbox), so Date is fine here.
  return new Date().toISOString()
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 7)
}

export function createCaseStore(opts) { return new CaseStore(opts) }
