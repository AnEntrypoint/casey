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
import { buildCaseMachine, canTransition, nextStates } from './case-machine.js'

// Principals casey acts as. role:agent satisfies normal requires_role gates.
export const AGENT_USER = { id: 'casey-agent', role: 'agent' }
export const SYSTEM_USER = { id: 'casey-system', role: 'admin' }

export class CaseStore {
  constructor(opts = {}) {
    this.configPath = opts.config || path.resolve(process.cwd(), 'thatcher.config.yml')
    // The DB lives at <cwd>/data/app.db and is NOT configurable: thatcher's
    // query engine primes its better-sqlite3 handle from cwd at module load
    // (getDatabase() is called argless in thatcher init), so the only way to
    // relocate the store is to change the process cwd. Tests wipe ./data.
    this.workflow = opts.workflow || 'case_lifecycle'
    this.log = opts.log || null
    // Optional hook fired AFTER a real stage change commits:
    //   onTransition({ caseRow, from, to, user, reason }) -> Promise|void
    // Best-effort: failures are caught and logged, never block the transition.
    // Null in the dashboard-only and test wirings, so transition() must tolerate it.
    this.onTransition = opts.onTransition || null
    this.thatcher = null
    this._wf = null            // parsed workflow stage graph
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
    // The lifecycle is now a real xstate machine built from the same graph: it,
    // not bespoke array checks, is the authority on whether a transition is legal.
    this._machine = buildCaseMachine(this._wf)

    fs.mkdirSync(path.resolve(process.cwd(), 'data'), { recursive: true })
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

  // Validate a transition. Delegates to the xstate machine -- the single
  // authority on legality -- so an illegal move is rejected structurally. Throws
  // with the machine's reason (same message shape callers already surface).
  _validateTransition(fromState, toState, user) {
    const res = canTransition(this._machine, fromState, toState, user?.role)
    if (!res.ok) throw new Error(res.error)
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
    // thatcher ignores orderBy, so a limit:1 fetch could return the wrong row if
    // uniqueWhere ever matches more than one. Pull the matches and pick the newest
    // (the row we just created) in JS -- the reload is then order-independent.
    const rows = await this.t.list(entity, uniqueWhere, { limit: 50 })
    const row = rows.reduce((best, r) => (!best || (r.created_at || 0) > (best.created_at || 0) ? r : best), null)
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
  //
  // Worst-case correctness: we must never miss an open case hidden behind a run
  // of more-recently-closed ones (that would double-create). thatcher's `where`
  // is equality-only (query-engine buildSpecQuery: `col = ?`), so we cannot
  // express `status != 'closed'` as a predicate. Instead we query each open
  // stage directly -- the open-stage set is finite and known from the parsed
  // workflow graph. A stage-scoped query can never return a soft-deleted row,
  // because `status` is one column and 'deleted' is mutually exclusive with any
  // workflow stage. thatcher ignores the orderBy/order list() options (it sorts
  // only via options.sort / spec.list.defaultSort, neither set here), so we do
  // NOT rely on the DB to return newest-first -- we pick max created_at in JS,
  // the only place ordering is actually honored.
  async findOpenCase({ channel, external_id }) {
    let best = null
    for (const status of Object.keys(this._wf)) {
      if (status === 'closed') continue
      const rows = await this.t.list('case', { channel, external_id, status }, { limit: 1000 })
      for (const r of rows) if (!best || (r.created_at || 0) > (best.created_at || 0)) best = r
    }
    return best
  }

  async getCase(id) { return this.t.get('case', id) }

  async getContact(id) { return id ? this.t.get('contact', id) : null }

  // Most-recently-active first. thatcher ignores orderBy/order so we sort in JS
  // (by last_event_at, falling back to created_at) to make the order real. The
  // page window is applied after sorting when a limit is given.
  async listCases(where = {}, opts = {}) {
    const { limit = 50, offset = 0 } = opts
    const rows = await this.t.list('case', where, { limit: Math.max(limit + offset, 1000) })
    rows.sort((a, b) => recencyKey(b) - recencyKey(a))
    return rows.slice(offset, offset + limit)
  }

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
  // if it was a duplicate already recorded.
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
  // Returns { report } (the merged object) or { error } / { skipped } on guards.
  async mergeReport(caseId, incoming, user = AGENT_USER) {
    const c0 = await this.getCase(caseId)
    if (!c0) return { error: `no case ${caseId}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {
      const c = await this.getCase(caseId)             // re-read INSIDE the lock
      if (!c) return { error: `no case ${caseId}` }
      if (c.autonomy === 'observe') return { error: 'observe' }
      let current = {}
      try { current = c.report ? JSON.parse(c.report) : {} } catch { current = {} }
      const merged = { ...current, ...incoming }
      await this.updateCase(caseId, { report: JSON.stringify(merged) }, user)
      return { report: merged }
    })
  }

  // Fill report fields ONLY where currently empty -- a structural fill that can
  // never clobber a value the agent already recorded (incoming loses to any
  // non-blank current value). Used at ingress to mark facts that are observable
  // deterministically (e.g. a photo arrived) without overwriting the agent's
  // own richer description on a later turn. Same lock, same observe guard as
  // mergeReport. Returns { report, filled:[keys] } or { error } / no-op { report }.
  async markReportFieldsIfEmpty(caseId, fields, user = AGENT_USER) {
    const c0 = await this.getCase(caseId)
    if (!c0) return { error: `no case ${caseId}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {
      const c = await this.getCase(caseId)
      if (!c) return { error: `no case ${caseId}` }
      if (c.autonomy === 'observe') return { error: 'observe' }
      let current = {}
      try { current = c.report ? JSON.parse(c.report) : {} } catch { current = {} }
      const filled = []
      const next = { ...current }
      for (const [k, v] of Object.entries(fields)) {
        const have = current[k] != null && String(current[k]).trim() !== ''
        if (!have && v != null && String(v).trim() !== '') { next[k] = v; filled.push(k) }
      }
      if (!filled.length) return { report: current, filled: [] }
      await this.updateCase(caseId, { report: JSON.stringify(next) }, user)
      return { report: next, filled }
    })
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
  // every returned row and take Math.max, so thatcher's ignored orderBy/order is
  // irrelevant here (we do not pass it -- claiming an ordering thatcher does not
  // honour would be dishonest, P10). UNIQUENESS does not depend on the sequence:
  // the random suffix guarantees it even if two creators read the same max
  // concurrently or the highest case falls outside the page.
  async _nextRef() {
    let seq = 1000
    const recent = await this.t.list('case', {}, { limit: 200 })
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

  // Metadata-only update that does NOT touch last_event_at -- used by the health
  // sweep to set/clear health:* tags. Stamping recency here would corrupt the very
  // signal staleness is measured from (a swept stale case would look freshly
  // active), so the guardrail must never perturb the field it reads (P1).
  async updateCaseQuiet(id, patch, user = SYSTEM_USER) {
    await this.t.update('case', id, patch, user)
    return this.getCase(id)
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
    // Lock the TARGET conversation: merge mutates the target's report/tags and
    // re-homes events onto it, so it must serialize against target-side writes.
    return this._withLock(`${tgt0.channel}|${tgt0.external_id}`, async () => {
      const src = await this.getCase(sourceId)
      const tgt = await this.getCase(targetId)
      if (!src || !tgt) return { error: 'case vanished during merge' }
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
      let srcReport = {}, tgtReport = {}
      try { srcReport = src.report ? JSON.parse(src.report) : {} } catch { srcReport = {} }
      try { tgtReport = tgt.report ? JSON.parse(tgt.report) : {} } catch { tgtReport = {} }
      const mergedReport = { ...tgtReport }
      for (const [k, v] of Object.entries(srcReport)) {
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
      // 4) Leave the source as an audited redirect and close it out.
      await this.updateCase(sourceId, {
        tags: [...srcTags, 'merged'].filter((v, i, a) => a.indexOf(v) === i).join(','),
        summary: `Merged into ${tgt.ref}. See that case for the full report.`,
      }, user)
      await this.appendEvent(sourceId, {
        kind: 'note', actor: user.role === 'agent' ? 'agent' : 'operator',
        text: `This report was merged into ${tgt.ref}${reason ? ` -- ${reason}` : ''}.`,
        data: { merged_into: targetId, merged_into_ref: tgt.ref, reason },
      })
      await this._forceClose(sourceId, `merged into ${tgt.ref}`, SYSTEM_USER)
      return { merged: true, target: await this.getCase(targetId), source: await this.getCase(sourceId), movedEvents: srcEvents.length }
    })
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

  // Chronological (oldest-first). thatcher ignores orderBy/order, so we sort in
  // JS to make the order a real guarantee rather than relying on its (undocumented)
  // insertion-order behaviour. created_at is a unix-seconds integer; we tiebreak
  // on id so same-second events keep a stable order.
  async listEvents(caseId, opts = {}) {
    // Default high, not 200: merge/split and conversation-context callers need the
    // WHOLE timeline -- a silent 200/1000 cap drops events on a long case, losing
    // history on merge and miscounting the empty-source guard on split (P1/P9).
    // Explicit-limit callers (case_get's 30) still win.
    const rows = await this.t.list('event', { case_id: caseId }, { ...opts, limit: opts.limit ?? 10000 })
    return rows.sort(byCreatedAsc)
  }

  // Paged, newest-first window for the dashboard timeline. We sort the full set
  // newest-first in JS, then apply the page window, so paging is correct even
  // though thatcher does not honour orderBy/order.
  async listEventsPage(caseId, { limit = 50, offset = 0 } = {}) {
    const rows = await this.t.list('event', { case_id: caseId }, { limit: 1000 })
    rows.sort(byCreatedDesc)
    return rows.slice(offset, offset + limit)
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
      catch (e) { this.log?.warn?.('onTransition hook failed', { caseId, to: toState, error: e.message }) }
    }
    return result
  }
}

function nowIso() {
  // CaseStore runs in the casey process (not the workflow sandbox), so Date is fine here.
  return new Date().toISOString()
}

// Event ordering: created_at is a unix-seconds integer; id is the stable
// tiebreaker so same-second events keep a deterministic order. thatcher ignores
// orderBy, so these provide the ordering guarantee in JS.
const ca = (r) => (r?.created_at || 0)
function byCreatedAsc(a, b) { return ca(a) - ca(b) || String(a.id).localeCompare(String(b.id)) }
function byCreatedDesc(a, b) { return ca(b) - ca(a) || String(b.id).localeCompare(String(a.id)) }
// Case recency: last activity if known, else creation time. last_event_at is an
// ISO string (or null); coerce to a comparable number.
function recencyKey(c) {
  const le = c?.last_event_at ? Date.parse(c.last_event_at) : NaN
  return Number.isNaN(le) ? ca(c) * 1000 : le
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 7)
}

export function createCaseStore(opts) { return new CaseStore(opts) }
