

import { createThatcher } from 'thatcher'
import { eraseCaseSessions } from './store/agent-sessions.js'
import path from 'node:path'
import { DEFAULT_THRESHOLDS } from './case-health.js'
import { mergeThresholds } from './thresholds.js'
import fs from 'node:fs'
import { load as yamlLoadRaw, YAML11_SCHEMA } from 'js-yaml'

const yamlLoad = (text) => yamlLoadRaw(text, { schema: YAML11_SCHEMA })
import { buildCaseMachine, canTransition, nextStates } from './case-machine.js'
import { tokens } from './correlate.js'
import { DERIVED_ONLY_FIELDS, writeGuardViolation, toStorable, installVersionGuard } from './store/guards.js'
import { REPORT_KEYS, REPORT_KEY_ORDER, AREA_FIELD, SYSTEM_SET_FIELDS } from './store/report-shape.js'
import { TIER_ORDER, TIER_FIELD_WORKER, atLeast, resolveTierValue } from './contact-tiers.js'
import { isContactAssignee } from './case-assignment.js'
import { byCreatedAscList, byCreatedDescList } from './store/query.js'
import { validateCaseConfig, parseFieldEnums } from './store/config-schema.js'
import { deriveAuthorKey, mintRef } from './store/ref.js'
import { saveMediaFile } from './store/media.js'
import { createBusyRetryProxy } from './store/busy-retry.js'
import { APPEND_FIELD_MAX_LEN, parseReportJson, mergeReportFields, fillIfEmptyReport } from './store/report-merge.js'
import { taggedObservations } from './store/settings-log.js'
import { parseJsonArray, foldAreas } from './store/operator-areas.js'
import { tagList } from './timestamp.js'

import { reopenedWithoutDiagnosis } from './signoff-desk.js'
import { evData, rowInt } from './safe.js'

export const AGENT_USER = { id: 'casey-agent', role: 'agent' }
export const SYSTEM_USER = { id: 'casey-system', role: 'admin' }

export const UNCLAIMED_ASSIGNEE = 'agent'

export { REPORT_KEYS, REPORT_KEY_ORDER }
export { deriveAuthorKey }

export class CaseStore {
  constructor(opts = {}) {

    this.configPath = opts.config
      || (process.env.CASEY_CONFIG_DIR ? path.resolve(process.env.CASEY_CONFIG_DIR, 'thatcher.config.yml') : null)
      || path.resolve(process.cwd(), 'thatcher.config.yml')

    this.dataDir = path.resolve(process.cwd(), 'data')
    this.workflow = opts.workflow || 'case_lifecycle'
    this.log = opts.log || null

    this.onTransition = opts.onTransition || null
    this.thatcher = null
    this._wf = null
    this._fieldEnums = null
    this._machine = null
    this._locks = new Map()
  }

  async init() {
    if (this.thatcher) return this
    if (!fs.existsSync(this.configPath)) throw new Error(`casey config not found: ${this.configPath}`)

    const cfg = yamlLoad(fs.readFileSync(this.configPath, 'utf8'))
    this._wf = validateCaseConfig(cfg, this.workflow)
    this._fieldEnums = parseFieldEnums(cfg)

    this._machine = buildCaseMachine(this._wf)

    fs.mkdirSync(this.dataDir, { recursive: true })
    this.thatcher = createThatcher({
      config: this.configPath,
      server: { hotReload: false },

      indexes: {
        case: ['ref', 'external_id', 'author_key'],
        contact: ['external_id'],
        operator_account: ['username'],
        operator_identity: ['operator_id'],
      },
    })
    await this.thatcher.init()
    await this.reportStrandedStages()
    await this.reportOrphanedOperators()
    return this
  }

  async reportStrandedStages({ limit = 10000 } = {}) {
    try {
      const known = new Set([...Object.keys(this._wf || {}), 'active', 'deleted', 'archived'])
      const rows = await this.t.list('case', {}, { limit })
      const stranded = rows.filter(r => r.status && !known.has(r.status))
      if (!stranded.length) return []
      const byStage = new Map()
      for (const r of stranded) {
        if (!byStage.has(r.status)) byStage.set(r.status, [])
        byStage.get(r.status).push(r.ref || r.id)
      }
      const detail = [...byStage.entries()]
        .map(([s, refs]) => `${s}: ${refs.length} case(s) (${refs.slice(0, 10).join(', ')}${refs.length > 10 ? ', ...' : ''})`)
        .join('; ')
      const msg = `[casey] ${stranded.length} stored case(s) sit in a workflow stage this config no longer declares -- they are invisible to find-or-create, cannot be transitioned, and the next message from those reporters will open a DUPLICATE case. Re-stage them or restore the stage name. ${detail}`
      if (this.log?.error) this.log.error(msg, { stages: [...byStage.keys()], count: stranded.length })
      else console.error(msg)
      return stranded.map(r => r.id)
    } catch (e) {
      this.log?.warn?.('[casey] stranded-stage check failed', { error: e.message })
      return []
    }
  }

  async reportOrphanedOperators({ limit = 10000 } = {}) {
    try {
      const accounts = await this.t.list('operator_account', {}, { limit })
      const known = new Set(accounts.filter(a => a.status !== 'deleted').map(a => a.username).filter(Boolean))
      if (!known.size) return []
      const orphans = []
      const cases = await this.t.list('case', {}, { limit })
      const byAssignee = new Map()
      for (const c of cases) {
        const a = c.assignee
        if (!a || a === UNCLAIMED_ASSIGNEE || known.has(a) || isContactAssignee(a)) continue
        if (!byAssignee.has(a)) byAssignee.set(a, [])
        byAssignee.get(a).push(c.ref || c.id)
      }
      for (const [a, refs] of byAssignee) orphans.push(`assignee "${a}": ${refs.length} case(s) (${refs.slice(0, 10).join(', ')}${refs.length > 10 ? ', ...' : ''})`)
      const idents = await this.t.list('operator_identity', {}, { limit })
      const orphanIdents = idents.filter(r => r.operator_id && !known.has(r.operator_id)).map(r => r.operator_id)
      if (orphanIdents.length) orphans.push(`operator_identity for ${orphanIdents.length} unknown operator(s) (${orphanIdents.slice(0, 10).join(', ')})`)
      if (!orphans.length) return []
      const msg = `[casey] stored rows name operator(s) with no active account -- those cases can never show as "mine" to anyone, they double-count in team workload, and an orphaned identity suggests a handle nobody can log in as. Re-assign them or restore the account. ${orphans.join('; ')}`
      if (this.log?.error) this.log.error(msg, { count: orphans.length })
      else console.error(msg)
      return orphans
    } catch (e) {
      this.log?.warn?.('[casey] orphaned-operator check failed', { error: e.message })
      return []
    }
  }

  validateConfig() {
    if (!fs.existsSync(this.configPath)) throw new Error(`casey config not found: ${this.configPath}`)
    return validateCaseConfig(yamlLoad(fs.readFileSync(this.configPath, 'utf8')), this.workflow)
  }

  getFieldEnum(entityDotField, fallback = []) {
    return this._fieldEnums?.[entityDotField] || fallback
  }

  async close() {
    try { await this.thatcher?.stop?.() }
    catch (e) { this.log?.warn?.('[casey] thatcher_stop_failed', { error: e.message }) }
    this.thatcher = null
  }

  _validateTransition(fromState, toState, user) {
    const res = canTransition(this._machine, fromState, toState, user?.role)
    if (!res.ok) throw new Error(res.error)
  }

  get t() {
    if (!this.thatcher) throw new Error('CaseStore not initialised  --  call init() first')
    if (this._tProxy) return this._tProxy

    this._tProxy = installVersionGuard(createBusyRetryProxy(this.thatcher, this.log))
    return this._tProxy
  }

  async findOrCreateContact({ channel, external_id, display_name, handle }) {
    const [existing] = await this.t.list('contact', { channel, external_id }, { limit: 1 })
    if (existing) {

      const stored = existing.display_name
      const learned = display_name || handle
      if (learned && (!stored || stored === external_id)) {
        try {
          await this.t.update('contact', existing.id, { display_name: learned, handle: handle || existing.handle || '' }, SYSTEM_USER)

          const [fresh] = await this.t.list('contact', { channel, external_id }, { limit: 1 })
          return fresh || existing
        } catch { return existing }
      }
      return existing
    }
    return this.t.create('contact', {
      channel, external_id,
      display_name: display_name || handle || external_id,
      handle: handle || '',
    }, SYSTEM_USER)
  }

  async findOrCreateContactLocked(args) {
    return this._withLock(`contact|${args.channel}|${args.external_id}`, () => this.findOrCreateContact(args))
  }

  async findOpenCase({ channel, external_id }) {

    const rows = await this.t.list(
      'case',
      { channel, external_id, status: { $in: this.getOpenStatuses() } },
      { limit: 200 },
    )
    let best = null
    for (const r of rows) if (!best || (r.created_at || 0) > (best.created_at || 0)) best = r
    return best
  }

  getOpenStatuses() { return Object.keys(this._wf || {}).filter(s => s !== 'closed') }

  async getCase(id) { return this.t.get('case', id) }

  async getContact(id) { return id ? this.t.get('contact', id) : null }

  async listContacts({ limit = 500, includeSystem = false } = {}) {
    const where = includeSystem ? {} : { channel: { $ne: 'system' } }
    return this.t.list('contact', where, { limit, sort: [{ field: 'created_at', dir: 'DESC' }] })
  }

  async setContactTier(contactId, tier, user = SYSTEM_USER) {
    if (!TIER_ORDER.includes(tier)) throw new Error(`invalid tier: ${tier} -- expected one of ${TIER_ORDER.join(', ')}`)
    const before = (await this.getContact(contactId).catch(() => null))?.tier
    const updated = await this.t.update('contact', contactId, { tier }, user)
    await this._releaseHeldCases(contactId, tier, user)
    await this._afterTierChange(contactId, before, tier)
    return updated
  }

  async _afterTierChange(contactId, before, after) {
    const from = resolveTierValue(before)
    const to = resolveTierValue(after)
    if (from === to) return { reset: false }
    try {
      const own = (await this.t.list('case', { contact_id: contactId }, { limit: 200 })).filter(c => c.channel !== 'system')
      if (!own.length) return { reset: true, cases: 0 }
      const erased = eraseCaseSessions(own.map(c => c.id), { log: this.log })
      for (const c of own.filter(x => x.status !== 'resolved' && x.status !== 'closed')) {
        await this.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `assistant conversation restarted: this contact's role changed (${from} -> ${to})`, data: { session_reset: true, from, to }, touch: false })
      }
      return { reset: true, cases: own.length, removed: erased.removed.length, failed: erased.failed.length }
    } catch (e) {
      this.log?.warn?.('[casey] session reset after tier change failed', { contactId, error: e.message })
      return { reset: false, error: e.message }
    }
  }

  async _releaseHeldCases(contactId, tier, user) {
    if (atLeast(tier, TIER_FIELD_WORKER)) return
    return this.releaseCasesHeldBy(`contact:${contactId}`, 'the team member holding it lost their role', user)
  }

  async releaseCasesHeldBy(key, why, user = SYSTEM_USER) {
    const held = await this.t.list('case', { assignee: key, status: { $in: this.getOpenStatuses() } }, { limit: 500 })
    for (const c of held) {
      const patch = { assignee: UNCLAIMED_ASSIGNEE }
      const resumed = c.autonomy === 'observe'
      if (resumed) patch.autonomy = 'auto'
      await this.updateCase(c.id, patch, user)
      await this.appendEvent(c.id, { kind: 'action', actor: 'operator', text: 'edited assignee', data: { assignee: UNCLAIMED_ASSIGNEE, released_because: why, was: key } })
      if (resumed) await this.appendEvent(c.id, { kind: 'autonomy_change', actor: 'operator', text: 'autonomy observe -> auto', data: { from: 'observe', to: 'auto', reason: why } })
    }
    return held.length
  }

  async registerContact({ channel = 'whatsapp', external_id, display_name = '', tier }, user = SYSTEM_USER) {
    if (!TIER_ORDER.includes(tier)) throw new Error(`invalid tier: ${tier} -- expected one of ${TIER_ORDER.join(', ')}`)
    if (!external_id) throw new Error('a phone number is required')
    const contact = await this.findOrCreateContactLocked({ channel, external_id, display_name })

    const patch = { tier }
    if (display_name && (!contact.display_name || contact.display_name === contact.external_id)) patch.display_name = display_name
    await this.t.update('contact', contact.id, patch, user)
    await this._releaseHeldCases(contact.id, tier, user)
    await this._afterTierChange(contact.id, contact.tier, tier)
    return this.getContact(contact.id)
  }

  async _systemSingletonCaseId(key, displayName) {
    const { case: c } = await this.findOrCreateCase({
      channel: 'system', external_id: `settings:${key}`,
      contact: { display_name: displayName },
    })
    return c.id
  }

  async _settingsCaseId() { return this._systemSingletonCaseId('thresholds', 'settings') }

  async getThresholdsPatch() {
    let id
    try { id = await this._settingsCaseId() } catch { return null }
    const events = await this.listEvents(id).catch(() => [])

    const hits = taggedObservations(events, 'thresholds')
    for (let i = hits.length - 1; i >= 0; i--) {
      try { return JSON.parse(hits[i].payload) } catch { continue }
    }
    return null
  }

  async setThresholdsPatch(patch, user) {
    const id = await this._settingsCaseId()
    await this.appendEvent(id, {
      kind: 'observation', actor: 'operator',
      text: `thresholds:${JSON.stringify(patch)}`,
      data: { keys: Object.keys(patch || {}), by: user?.id || user || 'operator' },
    })
    return patch
  }

  async resolveThresholds(bootOverride = null) {
    const base = bootOverride ? mergeThresholds(bootOverride).thresholds : DEFAULT_THRESHOLDS
    let patch = null
    try { patch = await this.getThresholdsPatch() } catch { patch = null }
    if (!patch) return base
    return mergeThresholds(patch, base).thresholds
  }

  async _fleetHealthCaseId() { return this._systemSingletonCaseId('fleet-health', 'fleet-health') }

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

  async getFleetHealth(n = 50) {
    let id
    try { id = await this._fleetHealthCaseId() } catch { return { latest: null, history: [], degraded: false } }
    const events = await this.listEvents(id).catch(() => [])
    const recs = []
    for (const { payload } of taggedObservations(events, 'fleet-health')) {
      try { recs.push(JSON.parse(payload)) } catch { continue }
    }
    const history = recs.slice(Math.max(0, recs.length - Math.max(1, n)))
    const latest = history.length ? history[history.length - 1] : null
    return { latest, history, degraded: !!latest?.degraded }
  }

  async _shiftCaseId() { return this._systemSingletonCaseId('shift', 'shift') }

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

  async getShiftMarker() {
    let id
    try { id = await this._shiftCaseId() } catch { return null }
    const events = await this.listEvents(id).catch(() => [])

    const hits = taggedObservations(events, 'shift-start', /^shift-start:(\d+)$/)
    for (let i = hits.length - 1; i >= 0; i--) {
      const ts = parseInt(hits[i].payload, 10)
      if (!Number.isFinite(ts)) continue
      const by = evData(hits[i].event).by || null
      return { ts, by }
    }
    return null
  }

  async getCaseByRef(ref) {
    const [row] = await this.t.list('case', { ref }, { limit: 1 })
    return row || null
  }

  async createCase({ channel, external_id, subject = '', contact_id = '', tags = '' } = {}) {
    return this._withLock(`${channel}|${external_id}`, async () => {
      const ref = await this._nextRef()

      const currentOpen = await this.findOpenCase({ channel, external_id })
      return this.t.create('case', {
        ref, channel, external_id, contact_id: contact_id || '',
        subject, summary: '', priority: 'normal', tags: tags || '',
        assignee: UNCLAIMED_ASSIGNEE, autonomy: 'auto', status: 'new', last_event_at: nowIso(),
        author_key: deriveAuthorKey(external_id),
        reporter_tier: resolveTierValue(currentOpen?.reporter_tier),
      }, AGENT_USER)
    })
  }

  async listCases(where = {}, opts = {}) {
    const { limit = 50, offset = 0, user = null, sort = null, includeSystem = false } = opts
    if (!includeSystem && where.channel === undefined) where = { ...where, channel: { $ne: 'system' } }
    const rows = await this.t.list('case', where, {
      limit: Math.max(limit + offset, 1000),
      ...(user ? { user } : {}),
      sort: sort || [{ field: 'last_event_at', dir: 'DESC' }, { field: 'created_at', dir: 'DESC' }],
    })
    return rows.slice(offset, offset + limit)
  }

  async countCases(where = {}) {
    return this._count('case', where)
  }

  async _count(entity, where = {}) {
    const CAP = 50000
    return Math.min(await this.t.count(entity, where), CAP)
  }

  async _withLock(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => fn())
    this._locks.set(key, run)
    try { return await run }
    finally { if (this._locks.get(key) === run) this._locks.delete(key) }
  }

  async findOrCreateCase(args) {
    return this._withLock(`${args.channel}|${args.external_id}`, () => this._findOrCreateCaseUnsafe(args))
  }

  async recordInbound(caseRow, { actor = 'contact', channel, text = '', data = null, msg_id = '' }) {
    return this._withLock(`${caseRow.channel}|${caseRow.external_id}`, async () => {
      if (msg_id && await this.hasInboundMessage(caseRow.id, msg_id)) return null
      return this.appendEvent(caseRow.id, { kind: 'inbound', actor, channel, text, data, msg_id })
    })
  }

  _parseReport(raw, caseId) {
    const { value, corrupted, error } = parseReportJson(raw)
    if (corrupted) this.log?.warn?.('[casey] report_parse_failed', { caseId, error: error?.message })
    return { value, corrupted }
  }

  async mergeReport(caseId, incoming, user = AGENT_USER, { bypassObserve = false, autoAssign = true, system = false } = {}) {
    if (!system && SYSTEM_SET_FIELDS.size) {
      incoming = { ...incoming }
      for (const k of SYSTEM_SET_FIELDS) delete incoming[k]
    }
    const res = await this._mergeReportLocked(caseId, incoming, user, { bypassObserve })
    if (autoAssign && !res.error && AREA_FIELD && (AREA_FIELD in incoming || 'location' in incoming)) {
      try {
        const { autoAssignByArea } = await import('./areas.js')
        await autoAssignByArea(this, caseId, { nearest: false })
      } catch (e) { this.log?.warn?.('[casey] area auto-assign failed', { caseId, error: e.message }) }
    }
    return res
  }

  async _mergeReportLocked(caseId, incoming, user = AGENT_USER, { bypassObserve = false } = {}) {
    const invalid = Object.keys(incoming).filter(k => !REPORT_KEYS.has(k))
    if (invalid.length) return { error: `invalid report fields: ${invalid.join(', ')}` }
    const c0 = await this.getCase(caseId)
    if (!c0) return { error: `no case ${caseId}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {
      const c = await this.getCase(caseId)
      if (!c) return { error: `no case ${caseId}` }
      if (c.autonomy === 'observe' && !bypassObserve) return { error: 'observe' }
      const { value: currentReport, corrupted: initCorrupted } = this._parseReport(c.report, caseId)
      const { merged, cappedFields: initCapped } = mergeReportFields(currentReport, incoming)

      const MERGE_RETRY_LIMIT = 3
      let attemptCase = c
      let attemptMerged = merged
      let attemptCorrupted = initCorrupted
      let attemptCapped = initCapped

      let attemptPriorReport = currentReport
      for (let attempt = 0; attempt <= MERGE_RETRY_LIMIT; attempt++) {
        try {
          await this.updateCase(caseId, { report: JSON.stringify(attemptMerged) }, user,
            attemptCase._version != null ? { expectedVersion: attemptCase._version } : {})
          const result = { report: attemptMerged, priorReport: attemptPriorReport }
          if (attemptCorrupted) result.reportWasCorrupted = true
          if (attemptCapped.length) result.cappedFields = attemptCapped
          return result
        } catch (e) {
          if (e.code !== 'conflict') throw e
          if (attempt === MERGE_RETRY_LIMIT) {
            return { error: `report merge conflict on case ${caseId} after ${MERGE_RETRY_LIMIT} retries -- concurrent writers still contending, not applied` }
          }
          const fresh = await this.getCase(caseId)
          if (!fresh) return { error: `no case ${caseId}` }

          if (fresh.autonomy === 'observe' && !bypassObserve) return { error: 'observe' }
          attemptCase = fresh
          const { value: freshReport, corrupted: retryCorrupted } = this._parseReport(fresh.report, caseId)
          const { merged: retryMerged, cappedFields: retryCapped } = mergeReportFields(freshReport, incoming)
          attemptMerged = retryMerged
          attemptCorrupted = attemptCorrupted || retryCorrupted
          attemptCapped = retryCapped
          attemptPriorReport = freshReport
        }
      }
    })
  }

  async appendReportField(caseId, field, note, user = AGENT_USER) {
    if (note == null || String(note).trim() === '') return { error: 'empty note' }
    const c0 = await this.getCase(caseId)
    if (!c0) return { error: `no case ${caseId}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {

      const APPEND_RETRY_LIMIT = 3
      let attemptCase = await this.getCase(caseId)
      if (!attemptCase) return { error: `no case ${caseId}` }
      if (attemptCase.autonomy === 'observe') return { error: 'observe' }
      for (let attempt = 0; attempt <= APPEND_RETRY_LIMIT; attempt++) {
        const { value: current, corrupted } = this._parseReport(attemptCase.report, caseId)
        const have = current[field] != null && String(current[field]).trim() !== ''
        const appended = have ? `${current[field]}; ${note}` : String(note)

        if (appended.length > APPEND_FIELD_MAX_LEN) {
          return { error: `report field '${field}' has reached its maximum length (${APPEND_FIELD_MAX_LEN} chars) -- this note was not attached` }
        }
        const next = { ...current, [field]: appended }
        try {
          await this.updateCase(caseId, { report: JSON.stringify(next) }, user,
            attemptCase._version != null ? { expectedVersion: attemptCase._version } : {})
          return corrupted ? { report: next, appended: true, reportWasCorrupted: true } : { report: next, appended: true }
        } catch (e) {
          if (e.code !== 'conflict') throw e
          if (attempt === APPEND_RETRY_LIMIT) {
            return { error: `report append conflict on case ${caseId} after ${APPEND_RETRY_LIMIT} retries -- concurrent writers still contending, not applied` }
          }
          const fresh = await this.getCase(caseId)
          if (!fresh) return { error: `no case ${caseId}` }
          if (fresh.autonomy === 'observe' && !bypassObserve) return { error: 'observe' }
          attemptCase = fresh
        }
      }
    })
  }

  saveMedia(caseId, buffer, opts = {}) {
    return saveMediaFile(this.dataDir, caseId, buffer, opts)
  }

  async _operatorIdentityRow(operatorId) {
    const [row] = await this.t.list('operator_identity', { operator_id: operatorId }, { limit: 1 })
    return row || null
  }

  async learnOperatorActivity(operatorId, caseRow) {
    if (!operatorId || !caseRow) return null
    return this._withLock(`operator_identity|${operatorId}`, async () => {
      try {
        const LEARN_RETRY_LIMIT = 3
        for (let attempt = 0; attempt <= LEARN_RETRY_LIMIT; attempt++) {

          const existing = await this._operatorIdentityRow(operatorId)
          const areas = existing ? parseJsonArray(existing.areas) : []
          const { value: report } = this._parseReport(caseRow.report, caseRow.id)

          const boundedAreas = foldAreas(areas, [...tokens(report.location)])
          const patch = {
            operator_id: operatorId,
            areas: JSON.stringify(boundedAreas),
            last_seen_at: nowIso(),

            case_count: rowInt(existing?.case_count) + 1,
          }

          const storablePatch = toStorable(patch)
          try {
            if (existing) {
              await this.t.update('operator_identity', existing.id, storablePatch, SYSTEM_USER,
                existing._version != null ? { expectedVersion: existing._version } : {})
            } else {
              await this.t.create('operator_identity', { ...storablePatch, channel_ids: '[]' }, SYSTEM_USER)
            }
            return patch
          } catch (e) {

            if (e.code !== 'conflict' || attempt === LEARN_RETRY_LIMIT) throw e
          }
        }
        return null
      } catch { return null }
    })
  }

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
    const created = await this.t.create('case', {
      ref,
      channel, external_id,
      contact_id: contactRow?.id || '',
      subject: subject || '',
      summary: '',
      priority: 'normal',
      tags: '',
      assignee: UNCLAIMED_ASSIGNEE,
      autonomy: 'auto',
      status: 'new',
      last_event_at: nowIso(),
      author_key: deriveAuthorKey(external_id),

      reporter_tier: resolveTierValue(contactRow?.tier),
    }, AGENT_USER)
    return { case: created, created: true }
  }

  async _nextRef() {
    return mintRef(await this.t.list('case', {}, { limit: 200 }))
  }

  async updateCase(id, patch, user = AGENT_USER, opts = {}) {
    const violation = writeGuardViolation(patch, user)
    if (violation) throw new Error(violation)
    await this.t.update('case', id, { ...toStorable(patch), last_event_at: nowIso() }, user, opts)
    return this.getCase(id)
  }

  async updateCaseChecked(id, patch, user = AGENT_USER) {
    const c0 = await this.getCase(id)
    if (!c0) return { error: `no case ${id}` }
    return this._withLock(`${c0.channel}|${c0.external_id}`, async () => {

      const RETRY_LIMIT = 3
      let c = await this.getCase(id)
      if (!c) return { error: `no case ${id}` }
      for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
        if (c.autonomy === 'observe') return { error: 'observe' }
        try {
          const updated = await this.updateCase(id, patch, user, c._version != null ? { expectedVersion: c._version } : {})
          return { ok: true, case: updated, prior: c }
        } catch (e) {
          if (e.code !== 'conflict') throw e
          if (attempt === RETRY_LIMIT) {
            return { error: `update conflict on case ${id} after ${RETRY_LIMIT} retries -- concurrent writers still contending, not applied` }
          }
          c = await this.getCase(id)
          if (!c) return { error: `no case ${id}` }
        }
      }
    })
  }

  async _scrubEventDestinations(caseId, erasedKey) {
    try {
      const events = await this.t.list('event', { case_id: caseId }, { limit: 1000 })
      for (const e of events) {
        if (!e.data || typeof e.data !== 'string' || !e.data.includes('"to"')) continue
        let parsed
        try { parsed = JSON.parse(e.data) } catch { continue }
        if (!parsed || typeof parsed !== 'object' || parsed.to == null) continue
        if (parsed.to === erasedKey) continue
        parsed.to = erasedKey
        try { await this.t.update('event', e.id, { data: JSON.stringify(parsed) }, SYSTEM_USER) } catch {  }
      }
    } catch {  }
  }

  async _siblingContactIds(contact) {
    const digits = String(contact?.external_id || '').replace(/[^0-9]/g, '')
    if (digits.length < 7) return []
    const rows = await this.t.list('contact', {}, { limit: 5000 })
    const deleted = await this.t.list('contact', { status: 'deleted' }, { limit: 5000 }).catch(() => [])
    const seen = new Set()
    const out = []
    for (const r of [...rows, ...deleted]) {
      if (!r || r.id === contact.id || seen.has(r.id)) continue
      seen.add(r.id)
      if (String(r.external_id || '').replace(/[^0-9]/g, '') === digits) out.push(r.id)
    }
    return out
  }

  static PII_REPORT_FIELDS = ['owner_name', 'owner_contact', 'present_person', 'present_person_relation', 'contact_fallback', 'reported_by', 'photos', 'audio']

  static PII_CONTACT_FIELDS = { external_id: '[erased]', display_name: '[erased]', handle: '', notes: '', last_location_lat: null, last_location_lon: null, last_location_at: '', last_report_lat: null, last_report_lon: null, last_report_at: '', last_report_case_id: '' }

  async _erasePiiOnCase(caseRow, { reason = '', operator = SYSTEM_USER, personOnly = false } = {}) {
    const PII_REPORT_FIELDS = CaseStore.PII_REPORT_FIELDS
    const ERASE_RETRY_LIMIT = 3

    return this._withLock(`${caseRow.channel}|${caseRow.external_id}`, async () => {
      let c = await this.getCase(caseRow.id)
      if (!c) return 'gone'
      for (let attempt = 0; attempt <= ERASE_RETRY_LIMIT; attempt++) {
          const { value: report } = this._parseReport(c.report, c.id)
          const hadPII = PII_REPORT_FIELDS.some(k => report[k] != null && report[k] !== '')

          const erasedKey = `[erased]-${c.id}`
          const hadKeyPII = !personOnly && (c.external_id !== erasedKey || c.author_key !== erasedKey)
          if (!hadPII && !hadKeyPII) return 'nothing-to-do'
          for (const k of PII_REPORT_FIELDS) report[k] = null
          try {

            await this.t.update('case', c.id, personOnly ? { report: JSON.stringify(report) } : { report: JSON.stringify(report), external_id: erasedKey, author_key: erasedKey }, SYSTEM_USER,
              c._version != null ? { expectedVersion: c._version } : {})
            await this.appendEvent(c.id, {
              kind: 'action', actor: 'system', touch: false,
              text: personOnly
                ? `PII erasure: the identifying report fields of one person on a shared phone were scrubbed${reason ? ` (${reason})` : ''}`
                : `PII erasure: contact data, report identifying fields and the case routing key scrubbed${reason ? ` (${reason})` : ''}`,
              data: { erasure: true, by: operator?.id || 'system', fields: personOnly ? [...PII_REPORT_FIELDS] : [...PII_REPORT_FIELDS, 'external_id', 'author_key'] },
            })

            if (!personOnly) await this._scrubEventDestinations(c.id, erasedKey)
            return 'scrubbed'
          } catch (e) {
            if (e.code !== 'conflict') throw e

            if (attempt === ERASE_RETRY_LIMIT) return 'conflict'
            const fresh = await this.getCase(c.id)
            if (!fresh) return 'gone'
            c = fresh
          }
        }
      return 'conflict'
    })
  }

  async _scrubRoleReferences(contactIds, user = SYSTEM_USER) {
    const ids = [...new Set((contactIds || []).map(String).filter(id => id.length >= 6))]
    let rewritten = 0
    for (const id of ids) {
      try { await this.t.update('contact', id, { tier: 'reporter' }, user) } catch {  }
    }
    const rewrite = (raw) => { let out = String(raw); for (const id of ids) out = out.split(id).join('[erased]'); return out }

    const claimedInvites = new Set()
    let inviteCaseId = null
    try { inviteCaseId = await this._systemSingletonCaseId('role-invites', 'role-invites') } catch { inviteCaseId = null }
    if (inviteCaseId) {
      const evs = await this.t.list('event', { case_id: inviteCaseId }, { limit: 100000 }).catch(() => [])
      for (const e of evs) {
        if (typeof e.text !== 'string' || !e.text.startsWith('role-invite:')) continue
        let r; try { r = JSON.parse(e.text.slice('role-invite:'.length)) } catch { continue }
        if (r?.op === 'claim' && ids.includes(String(r.contact))) claimedInvites.add(r.id)
      }
      for (const e of evs) {
        if (typeof e.text !== 'string' || !e.text.startsWith('role-invite:')) continue
        let r; try { r = JSON.parse(e.text.slice('role-invite:'.length)) } catch { continue }
        let changed = false
        if (r?.op === 'claim' && ids.includes(String(r.contact))) { r.contact = '[erased]'; changed = true }
        if (r?.op === 'create' && claimedInvites.has(r.id) && r.label) { r.label = ''; changed = true }
        if (!changed) continue
        try {
          await this.t.update('event', e.id, { text: `role-invite:${JSON.stringify(r)}`, data: rewrite(e.data || '') }, user)
          rewritten++
        } catch {  }
      }
    }
    for (const id of ids) {
      const evs = await this.t.list('event', { data: { $like: `%${id}%` } }, { limit: 100000 }).catch(() => [])
      for (const e of evs) {
        if (e.case_id === inviteCaseId) continue
        try { await this.t.update('event', e.id, { data: rewrite(e.data) }, user); rewritten++ } catch {  }
      }
    }

    try { rewritten += await (await import('./feedback.js')).scrubPersonalLogs(this, ids, user) } catch {  }

    try { rewritten += await (await import('./phone-persons.js')).scrubPersonsFor(this, ids, user) } catch {  }
    return rewritten
  }

  async _erasureJournalCaseId() { return this._systemSingletonCaseId('erasure-journal', 'erasure-journal') }

  async _recordErasureJournal(tag, payload) {
    try {
      const id = await this._erasureJournalCaseId()
      await this.appendEvent(id, {
        kind: 'observation', actor: 'system',
        text: `${tag}:${JSON.stringify(payload)}`,
        data: { erasure_journal: tag, contact_id: payload?.contactId || '' },
      })
      return true
    } catch (e) {

      this.log?.error?.('[casey] erasure journal write failed -- a crash during this erasure will not be recoverable', { tag, error: e.message })
      return false
    }
  }

  async findIncompleteErasures() {
    let id
    try { id = await this._erasureJournalCaseId() } catch { return [] }
    const events = await this.listEvents(id).catch(() => [])
    const plans = new Map()
    for (const { payload } of taggedObservations(events, 'erasure-plan')) {
      try { const p = JSON.parse(payload); if (p?.runId) plans.set(p.runId, p) } catch { continue }
    }
    for (const { payload } of taggedObservations(events, 'erasure-done')) {
      try {
        const p = JSON.parse(payload)
        if (p?.runId) plans.delete(p.runId)

        for (const closed of (p?.closes || [])) plans.delete(closed)
      } catch { continue }
    }
    return [...plans.values()]
  }

  async erasePerson(contactId, personId, { reason = '', operator = SYSTEM_USER } = {}) {
    const contact = await this.getContact(contactId)
    if (!contact) throw new Error(`erasePerson: no such contact ${contactId}`)
    const { casesOf, erasePerson: eraseInLog, listPersons } = await import('./phone-persons.js')
    if (!(await listPersons(this, contactId)).some(p => p.id === personId)) return { ok: false, reason: 'not_found' }
    const cases = await casesOf(this, contactId, personId)
    const runId = `${contactId}-${personId}-${Date.now()}`
    await this._recordErasureJournal('person-erasure-plan', { runId, contactId, personId, caseIds: cases.map(c => c.id), by: operator?.id || 'system', reason, ts: Date.now() })

    const touched = [], failed = []
    for (const ref of cases) {
      const c0 = await this.getCase(ref.id).catch(() => null)
      if (!c0) continue
      const outcome = await this._erasePiiOnCase(c0, { reason: reason || 'one person on a shared phone', operator, personOnly: true })
      if (outcome === 'scrubbed') touched.push(c0.id)
      else if (outcome === 'conflict') failed.push(c0.id)
    }
    await this._redactProvenanceFor(touched, { operator, reason })
    const sessions = eraseCaseSessions(cases.map(c => c.id), { log: this.log || console })

    let idsRewritten = 0
    const evs = await this.t.list('event', { data: { $like: `%${personId}%` } }, { limit: 100000 }).catch(() => [])
    for (const e of evs) {
      if (typeof e.data !== 'string' || !e.data.includes(personId)) continue
      try { await this.t.update('event', e.id, { data: e.data.split(personId).join('[erased]') }, SYSTEM_USER); idsRewritten++ } catch {  }
    }
    if (failed.length) return { ok: true, complete: false, contactId, personId, casesScrubbed: touched, casesFailed: failed, sessionsErased: sessions.removed.length, sessionsFailed: sessions.failed }
    const logged = await eraseInLog(this, contactId, personId, { by: `staff:${operator?.id || 'system'}` })
    await this._recordErasureJournal('person-erasure-done', { runId, contactId, personId, casesScrubbed: touched.length, casesFailed: failed.length, ts: Date.now() })
    return {
      ok: logged.ok, complete: logged.ok, contactId, personId, casesScrubbed: touched, casesFailed: failed,
      logRowsRewritten: logged.rewritten || 0, timelineIdsRewritten: idsRewritten,
      sessionsErased: sessions.removed.length, sessionsFailed: sessions.failed,
    }
  }

  async retentionEraseCase(caseId, { reason = '', operator = 'system' } = {}) {
    const c = await this.getCase(caseId)
    if (!c) return { ok: false, outcome: 'gone' }
    const outcome = await this._erasePiiOnCase(c, { reason, operator: { id: operator } })
    if (outcome === 'scrubbed') await this._redactProvenanceFor([caseId], { operator, reason })
    return { ok: outcome === 'scrubbed' || outcome === 'nothing-to-do', outcome }
  }

  async _redactProvenanceFor(caseIds, { operator = SYSTEM_USER, reason = '' } = {}) {
    const PROVENANCE_PII_FIELDS = CaseStore.PII_REPORT_FIELDS.filter(f => f === 'photos' || f === 'audio')
    if (!PROVENANCE_PII_FIELDS.length || !caseIds.length) return
    try {
      const { RawLog } = await import('./core/raw-log.js')
      const { redactSubjectFields } = await import('./core/write-path.js')
      const rawLog = new RawLog({ dataDir: this.dataDir })
      for (const caseId of caseIds) {
        try {
          await redactSubjectFields(rawLog, {
            subjectId: caseId, fields: PROVENANCE_PII_FIELDS,
            redactedBy: operator?.id || operator || 'system', reason: reason || 'erasure',
          })
        } catch {  }
      }
    } catch {  }
  }

  async eraseContact(contactId, { reason = '', operator = SYSTEM_USER } = {}) {
    const contact = await this.getContact(contactId)
    if (!contact) throw new Error(`eraseContact: no such contact ${contactId}`)
    const PII_CONTACT_FIELDS = CaseStore.PII_CONTACT_FIELDS
    const alreadyErased = contact.external_id === '[erased]'

    let siblingIds = await this._siblingContactIds(contact)
    let cases = await this.listCases({ contact_id: contactId }, { limit: 10000 })
    const recoveredRunIds = []
    if (alreadyErased) {

      const plans = await this.findIncompleteErasures().catch(() => [])
      const mine = plans.filter(p => p.contactId === contactId)
      if (mine.length) {
        const sib = new Set(siblingIds)
        const cid = new Set(cases.map(c => c.id))
        for (const p of mine) {
          for (const s of (p.siblingIds || [])) sib.add(s)
          for (const c of (p.caseIds || [])) cid.add(c)
          recoveredRunIds.push(p.runId)
        }
        siblingIds = [...sib]
        const recovered = []
        for (const id of cid) { const c = await this.getCase(id).catch(() => null); if (c) recovered.push(c) }
        cases = recovered
      }
    }

    const runId = `${contactId}-${Date.now()}`
    const journalled = await this._recordErasureJournal('erasure-plan', {
      runId, contactId, siblingIds, caseIds: cases.map(c => c.id),
      by: operator?.id || 'system', reason, ts: Date.now(),
    })

    if (!alreadyErased) {
      await this.t.update('contact', contactId, PII_CONTACT_FIELDS, SYSTEM_USER)
    }

    for (const sid of siblingIds) {
      try { await this.t.update('contact', sid, PII_CONTACT_FIELDS, SYSTEM_USER) } catch {  }
    }

    try {
      for (const id of [contactId, ...siblingIds]) await this.releaseCasesHeldBy(`contact:${id}`, 'the team member was erased', SYSTEM_USER)
      const digits = String(contact.external_id || '').replace(/\D/g, '')
      if (digits && !alreadyErased) {
        for (const a of await this.t.list('operator_account', {}, { limit: 500 })) {
          if (a.contact_phone && String(a.contact_phone).replace(/\D/g, '') === digits) await this.t.update('operator_account', a.id, { contact_phone: '' }, SYSTEM_USER)
        }
      }
    } catch {  }
    let roleRefsScrubbed = 0
    try { roleRefsScrubbed = await this._scrubRoleReferences([contactId, ...siblingIds], SYSTEM_USER) } catch {  }
    const touchedCaseIds = []
    const failedCaseIds = []
    for (const c0 of cases) {
      const outcome = await this._erasePiiOnCase(c0, { reason, operator })
      if (outcome === 'scrubbed') touchedCaseIds.push(c0.id)
      else if (outcome === 'conflict') failedCaseIds.push(c0.id)
    }
    await this._redactProvenanceFor(touchedCaseIds, { operator, reason })

    const sessions = eraseCaseSessions(cases.map(c => c.id), { log: this.log || console })

    await this._recordErasureJournal('erasure-done', {
      runId, contactId, closes: recoveredRunIds,
      casesScrubbed: touchedCaseIds.length, casesFailed: failedCaseIds.length,
      sessionsErased: sessions.removed.length, sessionsFailed: sessions.failed.length, ts: Date.now(),
    })
    return {
      contactId, contactErased: !alreadyErased, alsoErasedContactIds: siblingIds, roleReferencesScrubbed: roleRefsScrubbed,
      casesScrubbed: touchedCaseIds, casesFailed: failedCaseIds,

      sessionsErased: sessions.removed.length, sessionsFailed: sessions.failed,

      journalled,
    }
  }

  async updateCaseQuiet(id, patch, user = SYSTEM_USER, opts = {}) {
    const violation = writeGuardViolation(patch, user)
    if (violation) throw new Error(violation)
    await this.t.update('case', id, toStorable(patch), user, opts.expectedVersion != null ? { expectedVersion: opts.expectedVersion } : {})
    return this.getCase(id)
  }

  async systemUpdateDerived(id, patch) {
    const bad = Object.keys(patch || {}).filter(k => !DERIVED_ONLY_FIELDS.has(k))
    if (bad.length) throw new Error(`systemUpdateDerived: not a derived-only field: ${bad.join(', ')}`)
    return this.updateCaseQuiet(id, patch, SYSTEM_USER)
  }

  async updateEvent(id, patch, user = SYSTEM_USER) {
    await this.t.update('event', id, patch, user)
    return this.t.get('event', id)
  }

  async _forceClose(caseId, reason, user = SYSTEM_USER) {
    for (let hop = 0; hop < Object.keys(this._wf).length + 1; hop++) {
      const c = await this.getCase(caseId)
      if (!c || c.status === 'closed') return c
      const avail = this.availableTransitions(c, user)

      const next = avail.find(s => s === 'closed') || avail.find(s => s === 'resolved')
        || avail.find(s => ['in_progress', 'triaging', 'waiting'].includes(s)) || avail[0]
      if (!next) return c
      await this.transition(caseId, next, { user, reason })
    }
    return this.getCase(caseId)
  }

  async mergeCases(sourceId, targetId, user = AGENT_USER, { reason = '' } = {}) {
    if (sourceId === targetId) return { error: 'cannot merge a case into itself' }
    const src0 = await this.getCase(sourceId)
    const tgt0 = await this.getCase(targetId)
    if (!src0) return { error: `no case ${sourceId}` }
    if (!tgt0) return { error: `no case ${targetId}` }
    if (tgt0.autonomy === 'observe') return { error: 'observe' }
    if (src0.autonomy === 'observe') return { error: 'observe' }

    const srcKey = `${src0.channel}|${src0.external_id}`
    const tgtKey = `${tgt0.channel}|${tgt0.external_id}`
    const mergeFn = async () => {
      const src = await this.getCase(sourceId)
      const tgt = await this.getCase(targetId)
      if (!src || !tgt) return { error: 'case vanished during merge' }
      if (tgt.autonomy === 'observe') return { error: 'observe' }
      if (src.autonomy === 'observe') return { error: 'observe' }
      const srcTags = new Set(tagList(src))

      if (srcTags.has('merged')) {
        return { merged: true, alreadyMerged: true, target: tgt, movedEvents: 0 }
      }

      const srcEvents = await this.listEvents(sourceId)

      for (const ev of srcEvents) await this.updateEvent(ev.id, { case_id: targetId })

      const { value: srcReport, corrupted: srcCorrupted } = this._parseReport(src.report, sourceId)
      const { value: tgtReport, corrupted: tgtCorrupted } = this._parseReport(tgt.report, targetId)
      const reportWasCorrupted = srcCorrupted || tgtCorrupted
      const mergedReport = fillIfEmptyReport(tgtReport, srcReport)

      const tgtTags = new Set(tagList(tgt))
      for (const tg of srcTags) if (tg !== 'merged') tgtTags.add(tg)

      const latLonPatch = (tgt.lat == null || tgt.lon == null) && src.lat != null && src.lon != null
        ? { lat: src.lat, lon: src.lon }
        : {}
      await this.updateCase(targetId, {
        report: JSON.stringify(mergedReport),
        tags: [...tgtTags].join(','),
        ...latLonPatch,
      }, user)
      await this.appendEvent(targetId, {
        kind: 'note', actor: user.role === 'agent' ? 'agent' : 'operator',
        text: `Merged in ${src.ref} (${srcEvents.length} event(s))${reason ? ` -- ${reason}` : ''}.`,
        data: { merged_from: sourceId, merged_from_ref: src.ref, moved_events: srcEvents.length, reason },
      })

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
      return {
        merged: true, alreadyMerged: false,
        target: await this.getCase(targetId), source: await this.getCase(sourceId),
        movedEvents: srcEvents.length,
        ...(reportWasCorrupted ? { reportWasCorrupted: true } : {}),
      }
    }
    if (srcKey === tgtKey) return this._withLock(tgtKey, mergeFn)
    const [key1, key2] = [srcKey, tgtKey].sort()
    return this._withLock(key1, () => this._withLock(key2, mergeFn))
  }

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
      const created = await this.t.create('case', {
        ref, channel: src.channel, external_id: src.external_id,
        contact_id: src.contact_id || '', subject: (subject && String(subject).trim()) || `Split from ${src.ref}`,
        summary: '', report: '', priority: src.priority || 'normal',
        tags: 'split', assignee: src.assignee || 'agent', autonomy: src.autonomy || 'auto',
        status: 'new', last_event_at: nowIso(),
        author_key: deriveAuthorKey(src.external_id),
        reporter_tier: resolveTierValue(src.reporter_tier),
      }, AGENT_USER)
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

  async appendEvent(caseId, { kind, actor = 'system', channel, text = '', data = null, msg_id = '', touch = true }) {

    const ev = await this.t.create('event', {
      case_id: caseId,
      kind, actor, channel: channel || '',
      text,
      data: data ? JSON.stringify(data) : '',
      msg_id: msg_id || '',
    }, AGENT_USER)

    if (touch) {
      try {
        await this.t.update('case', caseId, { last_event_at: nowIso() }, AGENT_USER)
      } catch (e) {

        this.log?.error?.('case touch after appendEvent failed -- last_event_at is now stale for this case', { caseId, error: e.message })
      }
    }
    return ev
  }

  async listEvents(caseId, opts = {}) {

    const rows = await this.t.list('event', { case_id: caseId }, { ...opts, limit: opts.limit ?? 10000 })
    return byCreatedAscList(rows)
  }

  async listEventsPage(caseId, { limit = 50, offset = 0 } = {}) {
    const rows = byCreatedDescList(await this.t.list('event', { case_id: caseId }, { limit: 1000 }))
    return rows.slice(offset, offset + limit)
  }

  async countEvents(caseId) {
    return this._count('event', { case_id: caseId })
  }

  async listAllEvents({ kind = null, actor = null, caseIds = null } = {}, { limit = 200 } = {}) {
    const where = {}
    if (kind) where.kind = kind
    if (actor) where.actor = actor
    if (caseIds) where.case_id = { $in: caseIds }
    const cappedLimit = Math.max(1, limit)
    const rows = byCreatedDescList(await this.t.list('event', where, { limit: cappedLimit + 1 }))
    return { rows: rows.slice(0, cappedLimit), truncated: rows.length > cappedLimit }
  }

  async listEventsByCase(caseIds, { perCaseLimit = 10000 } = {}) {
    const out = new Map(caseIds.map(id => [id, []]))
    if (!caseIds.length) return out
    const rows = await this.t.list('event', { case_id: { $in: caseIds } }, { limit: caseIds.length * perCaseLimit })
    for (const r of rows) {
      const bucket = out.get(r.case_id)
      if (bucket) bucket.push(r)
    }
    for (const [id, bucket] of out) out.set(id, byCreatedAscList(bucket))
    return out
  }

  async hasInboundMessage(caseId, msgId) {
    if (!msgId) return false
    const rows = await this.t.list('event', { case_id: caseId, msg_id: msgId }, { limit: 1 })
    return rows.length > 0
  }

  getValidStatuses() { return Object.keys(this._wf || {}) }

  availableTransitions(caseRow, user = AGENT_USER) {
    return nextStates(this._machine, caseRow.status, user?.role)
  }

  async transition(caseId, toState, { user = AGENT_USER, reason = '' } = {}) {
    const before = await this.getCase(caseId)
    if (!before) throw new Error(`no case ${caseId}`)

    if (before.status === toState) return before
    this._validateTransition(before.status, toState, user)

    const TRANSITION_RETRY_LIMIT = 3
    let attemptBefore = before
    let reopened = null
    for (let attempt = 0; attempt <= TRANSITION_RETRY_LIMIT; attempt++) {
      try {
        reopened = reopenedWithoutDiagnosis(attemptBefore, toState)
        await this.t.update('case', caseId, {
          status: toState,
          transition_reason: reason || '',
          last_event_at: nowIso(),
          ...(reopened ? { report: JSON.stringify(reopened.report) } : {}),
        }, user, attemptBefore._version != null ? { expectedVersion: attemptBefore._version } : {})
        break
      } catch (e) {
        if (e.code !== 'conflict') throw e
        if (attempt === TRANSITION_RETRY_LIMIT) {
          throw new Error(`transition conflict on case ${caseId} after ${TRANSITION_RETRY_LIMIT} retries -- concurrent writers still contending, not applied`)
        }
        const fresh = await this.getCase(caseId)
        if (!fresh) throw new Error(`no case ${caseId}`)
        if (fresh.status === toState) return fresh
        this._validateTransition(fresh.status, toState, user)
        attemptBefore = fresh
      }
    }

    await this.appendEvent(caseId, {
      kind: 'transition',
      actor: user.role === 'agent' ? 'agent' : 'operator',
      text: `${attemptBefore.status} -> ${toState}${reason ? ` (${reason})` : ''}`,
      data: { from: attemptBefore.status, to: toState, by: user.id, reason, ...(reopened ? { previous_diagnosis: reopened.previous } : {}) },
    })

    const result = await this.getCase(caseId)

    if (this.onTransition) {
      try { await this.onTransition({ caseRow: result, from: attemptBefore.status, to: toState, user, reason }) }
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

  return new Date().toISOString()
}

export function createCaseStore(opts) { return new CaseStore(opts) }
