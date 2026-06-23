// dashboard/server.js -- casey's observe + manual-edit UI.
//
// Serves a small single-page app styled with anentrypoint-design's CSS, backed
// by a JSON API over the CaseStore. This is the human surface of casey:
// - observe   read every case, open one, read its full timeline
// - edit      change subject/summary/priority/tags/assignee/autonomy
// - override  force any valid workflow transition as an operator
// - reply     send a message to the contact on their channel as a human
//
// Everything written here goes through the same CaseStore the agent uses, so
// agent and operator share one timeline. The API is the operator-override
// surface, so an optional bearer token (CASEY_DASHBOARD_TOKEN) gates it.

import express from 'express'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESIGN_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'anentrypoint-design')

const OPERATOR = { id: 'dashboard-operator', role: 'operator' }
const PAGE_MAX = 200

// opts.token   shared secret; when set, /api and / require ?token= or Bearer header.
// opts.sendReply(caseRow, text) -> Promise; lets the operator reply on the channel.
export function createDashboard(store, { port = 4000, token = process.env.CASEY_DASHBOARD_TOKEN, sendReply = null, llmStatus = null } = {}) {
  if (!store) throw new Error('createDashboard requires a store instance')
  const app = express()
  app.use(express.json())

  // Token gate (only when a token is configured). Accepts Authorization: Bearer
  // <token>, X-Casey-Token header, or ?token= query (for the page load).
  // Constant-time compare so the gate does not leak the token one character at a
  // time through response timing (P6: the worst case is a patient attacker).
  const tokenBuf = token ? Buffer.from(token) : null
  const matches = (candidate) => {
    if (!candidate) return false
    if (tokenBuf == null) return false   // no token configured: matches() never authorises (the !token short-circuit in authed handles the open case)
    const buf = Buffer.from(String(candidate))
    return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf)
  }
  const authed = (req) => {
    if (!token) return true
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
    // req.query.token is accepted for the page-load GET / only (the client JS
    // immediately strips it from the address bar and switches to X-Casey-Token
    // header for all subsequent API calls, so it never appears in access logs).
    return matches(bearer) || matches(req.get('x-casey-token')) || matches(req.query.token)
  }
  app.use((req, res, next) => {
    if (req.path.startsWith('/design')) return next()
    if (authed(req)) return next()
    res.status(401).json({ error: 'unauthorized' })
  })

  app.use('/design', express.static(DESIGN_DIR))

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const clampLimit = (v, d) => Math.min(PAGE_MAX, Math.max(1, parseInt(v, 10) || d))
  const offsetOf = (v) => Math.min(50000, Math.max(0, parseInt(v, 10) || 0))

  // Adversarial-Structural: reject malformed mutations with a clear 4xx before
  // thatcher is touched. No framework, no dependency. MAX_LEN is a product cap
  // on operator-entered text length (UTF-16 units), NOT a security boundary --
  // express.json()'s 100KB default already bounds the body.
  const MAX_LEN = 4000
  const AUTONOMY = new Set(['auto', 'assisted', 'observe'])
  const PRIORITY = new Set(['low', 'normal', 'high', 'urgent'])
  // Returns a validated string, or sends a 4xx and returns undefined so the
  // caller short-circuits: `const x = str(...); if (x === undefined) return`.
  const str = (res, body, field, { required = true } = {}) => {
    const v = body[field]
    if (v == null) {
      if (required) { res.status(400).json({ error: `${field} required` }); return undefined }
      return ''
    }
    if (typeof v !== 'string') { res.status(400).json({ error: `${field} must be a string` }); return undefined }
    if (v.length > MAX_LEN) { res.status(413).json({ error: `${field} too long (max ${MAX_LEN})` }); return undefined }
    return v
  }

  // Plain-words health for the operator: is the AI helper connected? Low-literacy
  // operators must know WHY auto-replies may be paused (acptoapi offline) without
  // reading logs. llmStatus is an object or a (sync/async) fn returning one; we
  // normalise to {source, model, url} and translate to a friendly label + tone.
  app.get('/api/health', async (req, res) => {
    try {
      let s = typeof llmStatus === 'function' ? await llmStatus() : llmStatus
      s = s || { source: 'unknown' }
      const map = {
        acptoapi: { ok: true, label: 'AI helper: online', detail: 'Auto-replies are on. Contacts get an instant answer.' },
        stub: { ok: false, label: 'AI helper: test mode', detail: 'Fake replies for testing only. Not for real contacts.' },
        none: { ok: false, label: 'AI helper: offline', detail: 'Auto-replies are paused. Contacts get a holding message and wait for a person.' },
        unknown: { ok: false, label: 'AI helper: unknown', detail: 'Cannot tell if the AI helper is connected.' },
      }
      const view = map[s.source] || map.unknown
      // Bound the externally-supplied model/url so a misconfigured or hostile
      // llmStatus cannot return a multi-megabyte string into the operator's UI.
      const model = s.model ? String(s.model).slice(0, 100) : null
      const url = s.url ? String(s.url).slice(0, 200) : null
      res.json({ ...view, source: s.source, model, url })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Keys used by the report fields -- kept in sync with REPORT_KEYS in case-store.js.
  // Ordered for display: observation fields first, then logistics, then contacts/media.
  const REPORT_KEY_LIST = ['species', 'symptoms', 'affected_count', 'dead_count', 'onset',
    'suspected_disease', 'recent_movement', 'location', 'how_to_find', 'access_notes',
    'farmer_available', 'contact_fallback', 'identifying_traits', 'photos', 'audio', 'notes']
  const REPORT_KEY_SET = new Set(REPORT_KEY_LIST)
  const VISIT_CRITICAL_SET = new Set(['species', 'symptoms', 'location', 'how_to_find', 'farmer_available', 'contact_fallback'])

  function computeFillRate(reportJson) {
    let r = {}
    try { r = reportJson ? JSON.parse(reportJson) : {} } catch { r = {} }
    const filled = REPORT_KEY_LIST.filter(k => r[k] != null && String(r[k]).trim() !== '').length
    const vcFilled = [...VISIT_CRITICAL_SET].filter(k => r[k] != null && String(r[k]).trim() !== '').length
    return { total_fields: REPORT_KEY_LIST.length, filled, visit_critical_filled: vcFilled, visit_critical_total: VISIT_CRITICAL_SET.size }
  }

  // Escape a cell value for CSV: wrap in quotes if it contains comma, newline, or quote.
  function csvCell(v) {
    const s = v == null ? '' : String(v)
    if (s.includes(',') || s.includes('\n') || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  app.get('/api/cases', async (req, res) => {
    try {
      const where = {}
      if (req.query.status) {
        // Validate against the workflow's real statuses so an arbitrary
        // ?status=anything 400s here instead of silently reaching thatcher.
        const valid = store.getValidStatuses()
        if (!valid.includes(req.query.status)) {
          return res.status(400).json({ error: `invalid status: ${req.query.status}`, allowed: valid })
        }
        where.status = req.query.status
      }
      if (req.query.channel) where.channel = req.query.channel
      // ?ref= is a direct-lookup shortcut (used by shareable ref deep-links)
      if (req.query.ref) {
        const ref = String(req.query.ref).slice(0, 50)
        const all = await store.listCases({}, { limit: 10000, offset: 0 })
        const found = all.filter(c => c.ref === ref)
        const casesWithFill = found.map(c => ({ ...c, fill_rate: computeFillRate(c.report) }))
        return res.json({ cases: casesWithFill, total: found.length, limit: found.length, offset: 0 })
      }
      const q = req.query.q ? String(req.query.q).slice(0, 200).toLowerCase() : ''
      const limit = clampLimit(req.query.limit, 50)
      const offset = offsetOf(req.query.offset)
      let cases, total
      if (q) {
        // Search across case fields + all report field values. Fetch the full set
        // (capped at 10000) then filter in Node so report JSON is reachable.
        const all = await store.listCases(where, { limit: 10000, offset: 0 })
        const filtered = all.filter(c => {
          const hay = [c.ref, c.subject, c.summary, c.external_id, c.channel].join(' ').toLowerCase()
          if (hay.includes(q)) return true
          let r = {}; try { r = c.report ? JSON.parse(c.report) : {} } catch { r = {} }
          return REPORT_KEY_LIST.some(k => r[k] != null && String(r[k]).toLowerCase().includes(q))
        })
        total = filtered.length
        cases = filtered.slice(offset, offset + limit)
      } else {
        cases = await store.listCases(where, { limit, offset })
        total = await store.countCases(where)
      }
      const casesWithFill = cases.map(c => ({ ...c, fill_rate: computeFillRate(c.report) }))
      res.json({ cases: casesWithFill, total, limit, offset })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Create a case manually from the dashboard (non-AI intake flow).
  // channel is forced to 'web'; external_id is synthesised from the contact phone
  // (or a timestamp if none given) so it does not collide with channel messages.
  app.post('/api/cases', async (req, res) => {
    try {
      const subject = str(res, req.body, 'subject', { required: false }); if (subject === undefined) return
      const name = str(res, req.body, 'name', { required: false }); if (name === undefined) return
      const phone = str(res, req.body, 'phone', { required: false }); if (phone === undefined) return
      // SA phone validation: 0XXXXXXXXX (10 digits) or +27XXXXXXXXX (11 digits after +)
      if (phone) {
        const digits = phone.replace(/[\s\-()]/g, '')
        const valid = /^0[0-9]{9}$/.test(digits) || /^\+27[0-9]{9}$/.test(digits)
        if (!valid) return res.status(400).json({ error: 'Phone must be a South African number: 0821234567 or +27821234567' })
      }
      // external_id must be stable for dedup; use phone if given, else a web-<ms> id
      const external_id = phone ? phone.replace(/[^0-9+]/g, '') || `web-${Date.now()}` : `web-${Date.now()}`
      const contact = { name: name || 'operator', phone: phone || '' }
      const { case: c, created } = await store.findOrCreateCase({ channel: 'web', external_id, contact, subject: subject || 'Field report' })
      // If a case already exists for this phone, return 409 so the client can offer to open it
      if (!created) {
        return res.status(409).json({ error: 'A case already exists for this contact', existing_id: c.id, existing_ref: c.ref })
      }
      // Tag it as operator-initiated manual intake
      const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      if (!tags.includes('intake_mode:manual')) {
        const newTags = [...tags, 'intake_mode:manual'].join(',')
        await store.updateCase(c.id, { tags: newTags }, OPERATOR)
      }
      await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: 'case created via dashboard manual intake' })
      res.status(201).json(await store.getCase(c.id))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // CSV export: GET before /:id so express does not capture 'export.csv' as an id.
  app.get('/api/cases/export.csv', async (req, res) => {
    try {
      const where = {}
      if (req.query.status) {
        const valid = store.getValidStatuses()
        if (!valid.includes(req.query.status)) return res.status(400).json({ error: `invalid status: ${req.query.status}` })
        where.status = req.query.status
      }
      if (req.query.channel) where.channel = req.query.channel
      const cases = await store.listCases(where, { limit: 10000, offset: 0 })
      const META = ['ref', 'subject', 'status', 'priority', 'channel', 'created_at']
      const headers = [...META, ...REPORT_KEY_LIST]
      const rows = cases.map(c => {
        let r = {}
        try { r = c.report ? JSON.parse(c.report) : {} } catch { r = {} }
        return [...META.map(k => csvCell(c[k])), ...REPORT_KEY_LIST.map(k => csvCell(r[k]))].join(',')
      })
      const csv = [headers.join(','), ...rows].join('\n')
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename="casey-cases.csv"')
      res.send(csv)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/cases/:id', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const events_total = await store.countEvents(c.id)
      // newest window first by default; UI loads older via /events?offset=
      const limit = clampLimit(req.query.events_limit, 50)
      const events = await store.listEventsPage(c.id, { limit, offset: 0 })
      const transitions = store.availableTransitions(c, OPERATOR)
      const report_fill_rate = computeFillRate(c.report)
      res.json({ case: c, events, events_total, transitions, report_fill_rate })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Submit structured report fields for a case (non-AI intake or operator correction).
  // Merges into the existing report; blank incoming values never clobber filled ones.
  app.post('/api/cases/:id/intake', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const incoming = {}
      for (const k of REPORT_KEY_LIST) {
        if (!(k in req.body)) continue
        const v = str(res, req.body, k, { required: false }); if (v === undefined) return
        incoming[k] = v
      }
      // Reject unrecognised keys to avoid silent data loss
      const unknown = Object.keys(req.body).filter(k => !REPORT_KEY_SET.has(k))
      if (unknown.length) return res.status(400).json({ error: `unknown report fields: ${unknown.join(', ')}` })
      if (!Object.keys(incoming).length) return res.status(400).json({ error: 'no report fields provided' })
      const result = await store.mergeReport(c.id, incoming, OPERATOR)
      if (result.error) return res.status(400).json({ error: result.error })
      await store.appendEvent(c.id, { kind: 'action', actor: 'operator', text: `recorded report fields via dashboard: ${Object.keys(incoming).join(', ')}`, data: incoming })
      res.json({ report: result.report, report_fill_rate: computeFillRate(JSON.stringify(result.report)) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/cases/:id/events', async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 50)
      const offset = offsetOf(req.query.offset)
      const events = await store.listEventsPage(req.params.id, { limit, offset })
      res.json({ events, offset, limit })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.patch('/api/cases/:id', async (req, res) => {
    try {
      const allowed = ['subject', 'summary', 'priority', 'tags', 'assignee', 'autonomy']
      const patch = {}
      for (const k of allowed) {
        if (!(k in req.body)) continue
        const v = str(res, req.body, k); if (v === undefined) return
        if (k === 'autonomy' && !AUTONOMY.has(v)) return res.status(400).json({ error: `invalid autonomy: ${v}` })
        if (k === 'priority' && !PRIORITY.has(v)) return res.status(400).json({ error: `invalid priority: ${v}` })
        patch[k] = v
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields' })
      if (Object.keys(patch).some(k => k !== 'autonomy')) {
        const c = await store.getCase(req.params.id)
        if (c?.autonomy === 'observe') return res.status(400).json({ error: 'case autonomy is observe; only autonomy setting can be changed' })
      }
      const updated = await store.updateCase(req.params.id, patch, OPERATOR)
      if (!updated) return res.status(404).json({ error: 'not found' })
      await store.appendEvent(req.params.id, { kind: 'action', actor: 'operator', text: `edited ${Object.keys(patch).join(', ')}`, data: patch })
      res.json(updated)
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/cases/:id/transition', async (req, res) => {
    try {
      const to = str(res, req.body, 'to'); if (to === undefined) return
      const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      // availableTransitions excludes the current stage; transition() itself
      // no-ops a same-stage move, so let it through rather than 400 a no-op.
      const legal = store.availableTransitions(c, OPERATOR)
      if (to !== c.status && !legal.includes(to)) {
        return res.status(400).json({ error: `cannot transition to '${to}'`, allowed: legal })
      }
      await store.transition(req.params.id, to, { user: OPERATOR, reason: reason || 'operator override' })
      res.json(await store.getCase(req.params.id))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/api/cases/:id/note', async (req, res) => {
    try {
      const text = str(res, req.body, 'text'); if (text === undefined) return
      if (!text.trim()) return res.status(400).json({ error: 'empty note' })
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const field = req.body.field && REPORT_KEY_SET.has(req.body.field) ? req.body.field : null
      await store.appendEvent(req.params.id, { kind: 'note', actor: 'operator', text, data: field ? { field } : undefined })
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Cases the time-guardrails flagged as going wrong: stale, stuck, an unanswered
  // request for a person, an abandoned intake, or resolved-but-never-closed. Driven
  // by the health:* tags the sweep maintains, with the live breach detail recomputed
  // so the reason is current, not a stale snapshot.
  app.get('/api/attention', async (req, res) => {
    try {
      const { classifyCaseHealth } = await import('../case-health.js')
      const now = Date.now()
      const open = (await store.listCases({}, { limit: 10000 })).filter(c => c.status !== 'closed')
      const flagged = []
      for (const c of open) {
        const breaches = classifyCaseHealth(c, now)
        if (breaches.length) flagged.push({ id: c.id, ref: c.ref, subject: c.subject || '', status: c.status, breaches })
      }
      // Worst-first: most breaches, then longest-standing.
      flagged.sort((a, b) => b.breaches.length - a.breaches.length
        || Math.max(...b.breaches.map(x => x.since_ms)) - Math.max(...a.breaches.map(x => x.since_ms)))
      res.json({ count: flagged.length, cases: flagged })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Cases that look like the SAME real-world outbreak as this one -- the
  // operator's view of casey's grouping intelligence, with the reasons shown so
  // the suggestion is explainable, never an opaque score.
  app.get('/api/cases/:id/suggestions', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const { suggestLinks } = await import('../correlate.js')
      const pool = (await store.listCases({}, { limit: 200 }))
        .filter(o => o.id !== c.id && o.status !== 'closed'
          && !String(o.tags || '').split(',').map(s => s.trim()).includes('merged'))
      const byId = new Map(pool.map(o => [o.id, o]))
      const suggestions = suggestLinks(c, pool).slice(0, 5)
        .map(s => ({ ...s, subject: byId.get(s.id)?.subject || '', status: byId.get(s.id)?.status || '' }))
      res.json({ count: suggestions.length, suggestions })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Fold another case (source = req.body.into) INTO this one (target = :id). The
  // target stays canonical; lossless and idempotent in the store.
  app.post('/api/cases/:id/merge', async (req, res) => {
    try {
      const into = str(res, req.body, 'into'); if (into === undefined) return
      if (!into.trim()) return res.status(400).json({ error: 'no source case to merge' })
      const reason = str(res, req.body, 'reason', { required: false }); if (reason === undefined) return
      const res2 = await store.mergeCases(into, req.params.id, OPERATOR, { reason: reason || 'operator merge' })
      if (res2.error) return res.status(400).json({ error: res2.error })
      res.json({ ok: true, movedEvents: res2.movedEvents, alreadyMerged: !!res2.alreadyMerged })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Operator takes over the conversation: send a message to the contact on
  // their channel and record it as an outbound event.
  app.post('/api/cases/:id/reply', async (req, res) => {
    try {
      const raw = str(res, req.body, 'text'); if (raw === undefined) return
      const text = raw.trim()
      if (!text) return res.status(400).json({ error: 'empty reply' })
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      // Try to deliver before claiming success: if the channel send throws, we
      // record the failure and do NOT clear needs-human, so a contact who never
      // got the reply stays pinned in triage rather than silently dropped (P10).
      let delivered = false
      if (sendReply) {
        try { await sendReply(c, text); delivered = true }
        catch (e) {
          await store.appendEvent(c.id, { kind: 'observation', actor: 'system', text: `Failed to send operator reply on channel: ${e.message || 'unknown error'}` })
        }
      }
      await store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id } })
      // The operator personally answered, so the "wants a human" flag is satisfied
      // -- but only once the message actually reached the contact. Clear it then,
      // or the triage inbox keeps this case pinned at the top forever.
      if (delivered) {
        const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
        if (tags.includes('needs-human')) {
          await store.updateCase(c.id, { tags: tags.filter(t => t !== 'needs-human').join(',') }, OPERATOR)
        }
      }
      res.json({ ok: true, sent: !!sendReply, delivered })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Printable case briefing for field teams. Plain HTML, no JS, print-friendly.
  app.get('/api/cases/:id/report.html', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).send('<p>Case not found.</p>')
      let r = {}
      try { r = c.report ? JSON.parse(c.report) : {} } catch { r = {} }
      const LABELS = { species: 'Animals', symptoms: 'Signs seen', affected_count: 'How many affected',
        dead_count: 'How many died', onset: 'When it started', suspected_disease: 'Suspected disease',
        recent_movement: 'Recent movement', location: 'Where', how_to_find: 'How to find the place',
        access_notes: 'Getting there', farmer_available: 'Farmer available?',
        contact_fallback: 'Other contact', identifying_traits: 'Identifying the animals',
        photos: 'Photos', audio: 'Voice notes', notes: 'Other notes' }
      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
      const rows = REPORT_KEY_LIST.map(k => {
        const val = r[k] != null && String(r[k]).trim() ? esc(String(r[k])) : '<em>not recorded</em>'
        return `<tr><th>${esc(LABELS[k] || k)}</th><td>${val}</td></tr>`
      }).join('')
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Case ${esc(c.ref||c.id)} briefing</title>
<style>body{font-family:sans-serif;max-width:700px;margin:2em auto;color:#111}
h1{font-size:1.2em;margin-bottom:.5em}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4em .6em;border:1px solid #ccc;vertical-align:top}
th{width:40%;background:#f5f5f5;font-weight:600}
@media print{body{margin:0}}</style></head>
<body><h1>Field briefing: ${esc(c.ref||c.id)}</h1>
<p><strong>Subject:</strong> ${esc(c.subject||'')}</p>
<p><strong>Status:</strong> ${esc(c.status||'')} &nbsp; <strong>Channel:</strong> ${esc(c.channel||'')}</p>
<table>${rows}</table></body></html>`
      res.type('html').send(html)
    } catch (e) { res.status(500).send('<p>Error: ' + esc(String(e.message || 'unknown error')) + '</p>') }
  })

  app.get('/manifest.json', (_req, res) => res.json({
    name: 'casey', short_name: 'casey', start_url: '/', display: 'standalone',
    background_color: '#0f1115', theme_color: '#3b6ea5',
    description: 'Animal-disease surveillance case management',
    icons: [{ src: '/design/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/design/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  }))
  app.get('/', (_req, res) => res.type('html').send(PAGE))

  const server = app.listen(port)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      resolve({ app, server, port, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }) })
    })
  })
}

// Self-contained page. Uses anentrypoint-design's CSS variables/typography for
// theming; the interactive shell is plain webjsx-flavoured DOM so it needs no
// build step. The API is the contract; this page is the operator's whole world,
// so it carries the friendliness affordances: live search + status filter,
// non-blocking toasts (no alert()), empty/loading/connection states, relative
// timestamps, keyboard nav, a light/dark toggle, attention indicators, a
// shareable case deep-link, and a poll that pauses while you type so it never
// clobbers an in-progress edit. Every contact-controlled value still flows
// through esc() before it touches innerHTML.
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="casey">
<meta name="theme-color" content="#0f1115">
<link rel="manifest" href="/manifest.json">
<title>casey - cases</title>
<link rel="stylesheet" href="/design/colors_and_type.css">
<link rel="stylesheet" href="/design/app-shell.css">
<link rel="stylesheet" href="/design/editor-primitives.css">
<style>
  :root{--bg:#0f1115;--fg:#e6e6e6;--panel:#11141a;--border:#262a33;--border-soft:#20242c;
 --muted:#9aa6b2;--faint:#6b7685;--accent:#3b6ea5;--accent-soft:#1b2430;--hover:#171a21;--danger:#5a2230}
  html[data-theme=light]{--bg:#f6f7f9;--fg:#1a1f29;--panel:#fff;--border:#d6dbe2;--border-soft:#e4e8ee;
 --muted:#5a6675;--faint:#8a94a3;--accent:#2f6fb0;--accent-soft:#e7f0fa;--hover:#eef1f5;--danger:#c0392b}
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--font-sans,system-ui);background:var(--bg);color:var(--fg)}
  .wrap{display:grid;grid-template-columns:360px 1fr;height:100vh}
  .list{border-right:1px solid var(--border);overflow:auto;display:flex;flex-direction:column;min-height:0}
  .detail{overflow:auto;padding:20px}
  .report{margin:0 0 16px;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .rep-head{padding:8px 12px;background:var(--panel);font-weight:600;font-size:13px;border-bottom:1px solid var(--border-soft)}
  .rep-row{display:flex;gap:10px;padding:6px 12px;border-bottom:1px solid var(--border-soft);font-size:13px}
  .rep-row:last-child{border-bottom:none}
  .rep-label{flex:0 0 42%;color:var(--muted)}
  .rep-val{flex:1 1 auto;word-break:break-word}
  .rep-missing{color:var(--muted);font-style:italic;opacity:.7}
  .rep-ready{padding:7px 12px;font-size:12px;font-weight:600;border-bottom:1px solid var(--border-soft)}
  .rep-ready.ok{color:#1c8c44;background:rgba(34,160,80,.10)}
  .rep-ready.amber{color:#9a6a00;background:rgba(200,140,0,.10)}
  .topbar{padding:10px 14px;border-bottom:1px solid var(--border-soft);position:sticky;top:0;background:var(--bg);z-index:2}
  .topbar h1{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .counts{font-size:11px;color:var(--muted);font-weight:400}
  .icon-btn{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;
        padding:3px 8px;cursor:pointer;margin:0;font-size:12px;line-height:1}
  .icon-btn:hover{background:var(--hover);color:var(--fg)}
  .icon-btn.active{background:var(--accent-soft);color:var(--fg);border-color:var(--accent)}
  .filters{display:flex;gap:6px}
  .filters input{flex:2}.filters select{flex:1}
  .caselist{overflow:auto;flex:1;min-height:0}
  .case{padding:12px 14px;border-bottom:1px solid var(--border-soft);cursor:pointer}
  .case:hover{background:var(--hover)}
  .case.active{background:var(--accent-soft)}
  .case .top{display:flex;align-items:center;gap:6px}
  .ref{font-weight:600}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto}
  .dot.attn{background:#d8a000}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:var(--border);margin-left:2px}
  .badge.high,.badge.urgent{background:var(--danger);color:#fff}
  .sub{font-size:12px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .when{font-size:11px;color:var(--faint)}
  .ev{padding:8px 0 8px 10px;border-bottom:1px dashed var(--border-soft);font-size:13px;border-left:3px solid transparent}
  .ev.inbound{border-left-color:#3b6ea5}.ev.outbound{border-left-color:#2e8b57}
  .ev.note{border-left-color:#8a6d3b}.ev.action{border-left-color:#6a5acd}
  .ev.transition{border-left-color:#b07cc6}.ev.observation{border-left-color:#7a8290}
  .ev .k{display:inline-block;min-width:120px;color:#8aa0c0;font-size:11px}
  label{display:block;margin:8px 0 2px;font-size:12px;color:var(--muted)}
  .hint{font-size:11px;color:var(--faint);margin:2px 0 0}
  input,select,textarea{width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:16px}
  button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;margin-top:8px}
  button:disabled{opacity:.55;cursor:default}
  .row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
  .empty{padding:20px 16px;color:var(--faint);font-size:13px;line-height:1.5}
  .conn{display:none;background:var(--danger);color:#fff;font-size:12px;padding:5px 14px;text-align:center}
  .conn.show{display:block}
  #toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:50;max-width:340px}
  .toast{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--accent);
        border-radius:6px;padding:9px 12px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer}
  .toast.err{border-left-color:var(--danger)}.toast.ok{border-left-color:#2e8b57}
  .copy{background:transparent;color:var(--faint);border:0;cursor:pointer;padding:0 4px;margin:0;font-size:12px}
  .copy:hover{color:var(--fg)}
  @media(max-width:720px){
    .wrap{grid-template-columns:1fr}
    .wrap.detail-open .list{display:none}
    .wrap:not(.detail-open) .detail{display:none}
    .back{display:inline-block}
  }
  .back{display:none}
  /* plain-words help overlay + per-case "what to do now" hint */
  .help-ovl{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:none;
        align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px}
  .help-ovl.show{display:flex}
  .help-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
        max-width:560px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.45);font-size:14px;line-height:1.55}
  .help-card h2{margin:0 0 4px;font-size:18px}
  .help-card h3{margin:16px 0 4px;font-size:14px;color:var(--fg)}
  .help-card p{margin:6px 0;color:var(--muted)}
  .help-card .lead{color:var(--fg)}
  .help-card ul{margin:6px 0;padding-left:18px;color:var(--muted)}
  .help-card li{margin:4px 0}
  .help-card .swatch{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d8a000;vertical-align:middle;margin-right:4px}
  .help-card .foot{font-size:12px;color:var(--faint);margin-top:10px}
  .icon-btn.active{background:var(--accent-soft);color:var(--fg);border-color:var(--accent)}
  .todo{background:var(--accent-soft);border:1px solid var(--border);border-left:3px solid var(--accent);
        border-radius:6px;padding:9px 12px;margin:10px 0 14px;font-size:13px;color:var(--fg);line-height:1.5}
  /* triage inbox (pinned top of list) + coaching buttons */
  .triage{border-bottom:1px solid var(--border);background:var(--accent-soft)}
  .triage h2{font-size:13px;margin:0;padding:10px 14px 6px;display:flex;align-items:center;gap:8px}
  .triage h2 .n{background:var(--danger);color:#fff;border-radius:10px;padding:1px 8px;font-size:12px}
  .triage .calm{padding:14px;color:var(--muted);font-size:13px;line-height:1.5}
  .tcase{padding:12px 14px;border-top:1px solid var(--border-soft);cursor:pointer}
  .tcase:hover{background:var(--hover)}
  .tcase.active{outline:2px solid var(--accent);outline-offset:-2px}
  .tcase .why{font-size:13px;color:var(--fg);font-weight:600;margin-bottom:3px}
  .tcase .meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* canned-reply coaching buttons: big touch targets, theme-aware (readable in light mode) */
  .canned{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 0}
  .canned button{margin:0;background:var(--panel);color:var(--fg);border:1px solid var(--border);
        border-radius:8px;padding:10px 14px;font-size:14px;min-height:44px;text-align:left;flex:0 1 auto}
  .canned button:hover{background:var(--hover);border-color:var(--accent)}
  .canned-lab{font-size:12px;color:var(--muted);margin:12px 0 0}
  /* intake form overlay (New Case + Edit Report) */
  .intake-ovl{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:none;
        align-items:flex-start;justify-content:center;overflow:auto;padding:30px 16px}
  .intake-ovl.show{display:flex}
  .intake-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
        max-width:600px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px;max-height:calc(100dvh - 60px);overflow:auto}
  .intake-card h2{margin:0 0 12px;font-size:18px}
  .intake-card .field-hint{font-size:11px;color:var(--faint);margin:0 0 4px}
  .intake-card .fill-bar{display:flex;gap:6px;align-items:center;margin:0 0 14px;font-size:12px;color:var(--muted)}
  .intake-card .fill-bar .bar{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden}
  .intake-card .fill-bar .bar .fill{height:100%;background:#2e8b57;transition:width .3s}
  .intake-section-head{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin:10px 0 4px;padding:4px 0;border-bottom:1px solid var(--border-soft)}
  .intake-vc-note{font-weight:400;text-transform:none;letter-spacing:0;opacity:.8}
  .intake-req{color:var(--danger);font-size:13px;margin-left:2px}
  .intake-ovl textarea{resize:vertical;min-height:52px}
  .fill-pill{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--muted);margin-left:6px;vertical-align:middle}
  .fill-pill.ok{background:rgba(34,160,80,.18);color:#1c8c44}
  .fill-pill.low{background:rgba(200,140,0,.18);color:#9a6a00}
  .src-tag{font-size:10px;font-weight:600;padding:1px 5px;border-radius:8px;margin-left:4px;vertical-align:middle}
  .src-ai{background:rgba(59,110,165,.18);color:#5a90cc}
  .src-manual{background:rgba(90,170,130,.18);color:#2e8b57}
  .src-both{background:rgba(160,100,180,.18);color:#9060b0}
  .intake-mode-badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:rgba(90,170,130,.18);color:#2e8b57;margin-left:6px;vertical-align:middle}
  .rep-editable{cursor:text;border-radius:3px;padding:1px 3px;transition:background .15s}
  .rep-editable:hover{background:var(--hover)}
  .rep-field-input{width:100%;background:var(--panel);border:1px solid var(--accent);color:var(--fg);border-radius:4px;padding:3px 6px;font-size:13px}
  .rep-saving{opacity:.6}
  .rep-note-btn{background:transparent;color:var(--faint);border:0;cursor:pointer;padding:0 0 0 6px;margin:0;font-size:10px;vertical-align:middle}
  .rep-note-btn:hover{color:var(--accent)}
  .rep-field-note{font-size:11px;color:var(--muted);background:var(--hover);border-radius:4px;padding:3px 7px;margin-top:3px;border-left:2px solid var(--border)}
  /* handoff alert banner: loud, sticky, dismiss-per-case */
  .handoff{display:none;background:var(--danger);color:#fff;padding:10px 14px;font-size:14px;
        line-height:1.4;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid rgba(0,0,0,.3)}
  .handoff.show{display:flex;animation:handoff-pulse 1.3s ease-in-out infinite}
  .handoff b{font-weight:700}
  .handoff .x{margin-left:auto;background:rgba(255,255,255,.15);border:0;color:#fff;border-radius:6px;
        padding:4px 10px;margin:0;cursor:pointer;font-size:13px}
  .handoff .x:hover{background:rgba(255,255,255,.3)}
  @keyframes handoff-pulse{0%,100%{opacity:1}50%{opacity:.72}}
  /* health breach chips */
  .health{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
  .health-chip{display:inline-block;background:rgba(200,140,0,.18);color:#9a6a00;border:1px solid rgba(200,140,0,.3);border-radius:10px;padding:2px 10px;font-size:11px;font-weight:600}
  html[data-theme=light] .health-chip{background:rgba(180,120,0,.12);color:#7a5200}
  /* reply character counter */
  .reply-counter{font-size:11px;color:var(--faint);text-align:right;margin-top:2px}
  .reply-counter.warn{color:#9a6a00}.reply-counter.over{color:var(--danger)}
</style></head>
<body>
<div id="conn" class="conn">Connection lost - retrying...</div>
<div id="handoff" class="handoff" title="Click to open the person who needs help">
  <span id="handoff-msg"></span>
  <button class="x" id="handoff-dismiss" title="Hide this message">Hide</button>
</div>
<div class="wrap" id="wrap">
  <div class="list">
    <div class="topbar">
      <h1>casey <span class="counts" id="counts"></span>
        <span class="aihealth" id="aihealth" title="Is the AI helper connected?" style="margin-left:12px;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600"></span>
        <button class="icon-btn" id="help" title="What does this screen mean?" style="margin-left:auto">?</button>
        <button class="icon-btn" id="new-case-btn" title="Add a case manually (no WhatsApp or Discord needed)">+ New</button>
        <button class="icon-btn" id="export-btn" title="Download all cases as a spreadsheet (CSV)">Export</button>
        <button class="icon-btn" id="refresh" title="Refresh now">Refresh</button>
        <button class="icon-btn" id="theme" title="Toggle light/dark">dark</button>
        <button class="icon-btn" id="simple" title="Plain-language mode: show friendly stage names">Aa</button>
      </h1>
      <div class="filters">
        <input id="q" placeholder="Search ref, subject, contact... ( / )" autocomplete="off">
        <select id="statusf"><option value="">all stages</option></select>
        <select id="channelf" title="Filter by channel"><option value="">all channels</option></select>
      </div>
    </div>
    <div class="triage" id="triage"></div>
    <div class="caselist" id="cases"><div class="empty">Loading cases...</div></div>
  </div>
  <div class="detail" id="detail"><p class="empty">Select a case to observe, edit, reply, or override its workflow stage.</p></div>
</div>
<div class="intake-ovl" id="intake-ovl" role="dialog" aria-modal="true" aria-labelledby="intake-title">
  <div class="intake-card">
    <h2 id="intake-title">New case</h2>
    <div id="intake-fill-bar" class="fill-bar" style="display:none">
      <span id="intake-fill-label"></span>
      <div class="bar"><div class="fill" id="intake-fill-pct" style="width:0%"></div></div>
    </div>
    <div id="intake-contact-fields">
      <label>Contact name (optional)</label><input id="int-name" placeholder="e.g. Johannes">
      <label>Contact phone (optional)</label><input id="int-phone" placeholder="+27 82 123 4567">
      <label>Subject (what is the report about?)</label><input id="int-subject" placeholder="e.g. Sick cattle near Musina">
    </div>
    <div id="intake-report-fields"></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="intake-submit">Save</button>
      <button id="intake-cancel" style="background:transparent;color:var(--muted);border:1px solid var(--border)">Cancel</button>
    </div>
    <p class="hint" id="intake-error" style="color:var(--danger);display:none"></p>
  </div>
</div>
<div class="help-ovl" id="help-ovl">
  <div class="help-card">
    <h2>Welcome to casey</h2>
    <p class="lead">casey watches your messages on WhatsApp and Discord and helps you answer them. Here is what this screen shows you, in plain words.</p>
    <h3>What is each row?</h3>
    <p>Each row on the left is one person who messaged you, and the whole story of what they need. Click a row to open it.</p>
    <h3>What is the yellow dot?</h3>
    <p><span class="swatch"></span> A yellow dot means this one is waiting for a person. casey will not answer it on its own. Open it, read it, and reply.</p>
    <h3>The buttons when you open one</h3>
    <ul>
      <li><b>How urgent</b> - mark how important it is, so you know what to do first.</li>
      <li><b>Who answers</b> - choose who replies to the person: casey on its own, casey writes a draft for you to send, or only you (casey just listens).</li>
      <li><b>Reply to contact</b> - type a message and send it to the person yourself.</li>
      <li><b>Change the stage</b> - move it along by hand, like marking it Done. The person is not told.</li>
    </ul>
    <h3>How do I answer someone?</h3>
    <p>Open the row. Scroll to <b>Reply to contact</b>, type your message, and press <b>Send reply</b>. The person gets it on WhatsApp or Discord.</p>
    <p class="hint">Tip: the <b>Aa</b> button at the top turns on plain-language labels everywhere.</p>
    <button id="help-close">Got it</button>
    <p class="foot">You can open this help again any time with the <b>?</b> button at the top.</p>
  </div>
</div>
<div id="toasts"></div>
<script type="module">
const $ = (s,r=document)=>r.querySelector(s)
// Escape contact-supplied content before it enters innerHTML. Every value that
// originates from a message (subject/summary/tags/external_id/event text) is
// attacker-controlled, so it is escaped here, not trusted. Every render path
// below -- list, search results, timeline, deep-link restore -- goes through esc.
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// --- handoff notification: a contact asked for a human (needs-human tag) ---
// Fires ONCE per case (tracked in handoffSeen, persisted to localStorage so a
// reload does not re-nag). Pure client-side off the existing 5s poll: the tag is
// set server-side in gateway-hooks (intent==='human').
const hasHandoff = (c)=>String(c.tags||'').split(',').map(s=>s.trim()).includes('needs-human')
let handoffSeen = (()=>{ try{ return new Set(JSON.parse(localStorage.casey_handoff_seen||'[]')) }catch{ return new Set() } })()
function rememberHandoff(id){ handoffSeen.add(id); try{ localStorage.casey_handoff_seen=JSON.stringify([...handoffSeen].slice(-500)) }catch{} }
let handoffQueue = []                         // cases needing a human, freshest last
const baseTitle = document.title              // one source of truth
let titleFlip = false, titleTimer = null
function flashTitle(on){
  if(on){ if(titleTimer) return
    titleTimer=setInterval(()=>{ titleFlip=!titleFlip
      document.title = titleFlip ? (handoffQueue.length+' waiting for you') : baseTitle }, 1100) }
  else { clearInterval(titleTimer); titleTimer=null; document.title=baseTitle }
}
// Two-tone chime via WebAudio so there is no asset/dependency. try/catch because
// browsers block audio until the operator interacts; that silent failure must
// never break the visual alert.
function handoffSound(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx) return
    const ac=new Ctx(); const t=ac.currentTime
    ;[ [880,t,t+0.16], [1320,t+0.18,t+0.42] ].forEach(([f,s,e])=>{
      const o=ac.createOscillator(), g=ac.createGain()
      o.type='sine'; o.frequency.value=f
      g.gain.setValueAtTime(0.0001,s); g.gain.exponentialRampToValueAtTime(0.2,s+0.02)
      g.gain.exponentialRampToValueAtTime(0.0001,e)
      o.connect(g); g.connect(ac.destination); o.start(s); o.stop(e+0.02)
    })
    setTimeout(()=>{ try{ac.close()}catch{} }, 700)
  }catch{}
}
function renderHandoff(){
  const el=$('#handoff'); if(!el) return
  if(!handoffQueue.length){ el.classList.remove('show'); flashTitle(false); return }
  const c=handoffQueue[handoffQueue.length-1]
  const extra=handoffQueue.length>1 ? (' (and '+(handoffQueue.length-1)+' more)') : ''
  $('#handoff-msg').innerHTML='<b>Someone needs a person.</b> '+esc(c.ref)
    +' - '+esc(c.subject||c.external_id||c.channel)+esc(extra)+'. Click to open it.'
  el.classList.add('show'); flashTitle(true)
}
// Called from loadCases with the freshly polled cases.
function checkHandoffs(cases){
  for(const c of cases){
    if(!hasHandoff(c)) continue
    if(handoffSeen.has(c.id)) continue        // already alerted this case once
    rememberHandoff(c.id)
    if(handoffQueue.some(q=>q.id===c.id)) continue
    handoffQueue.push(c)
    if(!firstLoad){ handoffSound() }          // no chime for the backlog on first paint
  }
  // refresh subject text and drop resolved/closed handoffs
  handoffQueue = handoffQueue
    .map(q=>cases.find(c=>c.id===q.id)||q)
    .filter(q=>q.status!=='resolved' && q.status!=='closed')
  renderHandoff()
}
function clearHandoff(id){ handoffQueue=handoffQueue.filter(q=>q.id!==id); renderHandoff() }
// --- plain-language / simple mode ---
// Maps the workflow's technical stage names to friendly labels for low-literacy
// operators. simple mode is a view-only relabel: the real status value still
// flows through the API unchanged, so transitions/filters keep working. Reuse
// esc() on every label before it hits innerHTML, same as raw stage names.
let simple = false
const STAGE_LABEL = { new:'New', triaging:'Looking into it', in_progress:'Working on it',
  waiting:'Waiting', resolved:'Done', closed:'Closed' }
// stageLabel(s): friendly label in simple mode, raw stage name otherwise.
function stageLabel(s){ return simple ? (STAGE_LABEL[s] || s) : s }
// Read the token from the page-load query ONCE, then immediately scrub it from
// the address bar (history.replaceState) so the secret does not linger in browser
// history, bookmarks, or a shared screenshot. API calls then send it as the
// X-Casey-Token HEADER (which the server already accepts) instead of in the URL,
// so it never appears in server access logs or Referer headers either.
const TOKEN = new URLSearchParams(location.search).get('token')
if(TOKEN){ try{ const u=new URL(location.href); u.searchParams.delete('token'); history.replaceState(null,'',u.pathname+u.search+u.hash) }catch{} }
const api = (url,opts={})=>{
  if(!TOKEN) return fetch(url,opts)
  const headers = Object.assign({}, opts.headers||{}, { 'X-Casey-Token': TOKEN })
  return fetch(url, Object.assign({}, opts, { headers }))
}
// --- toasts (replace alert): ok auto-dismisses, err persists until clicked ---
function toast(msg,kind='ok'){
  const el=document.createElement('div'); el.className='toast '+kind; el.textContent=msg
  el.onclick=()=>el.remove(); $('#toasts').appendChild(el)
  if(kind!=='err') setTimeout(()=>el.remove(),3500)
  return el
}
async function failMsg(r,fallback){ try{return (await r.json()).error||fallback}catch{return fallback} }
// --- relative time, absolute on hover ---
function toDate(v){ if(v==null||v==='')return null
  const d=(typeof v==='number'||/^\\d+$/.test(String(v)))?new Date(Number(v)*1000):new Date(v); return isNaN(d)?null:d }
function rel(v){ const d=toDate(v); if(!d)return ''
  const s=Math.round((Date.now()-d.getTime())/1000)
  if(s<45)return 'just now'; if(s<90)return '1m ago'
  const m=Math.round(s/60); if(m<45)return m+'m ago'
  const h=Math.round(m/60); if(h<36)return h+'h ago'
  return Math.round(h/24)+'d ago' }
// Absolute time is always shown in South African Standard Time (SAST, UTC+2, no
// DST) so an operator anywhere reads the same local time the field team works in,
// regardless of the browser's own timezone. 'SAST' is appended so it is explicit.
function fmtTime(v){ const d=toDate(v); if(!d)return ''
  try{ return d.toLocaleString('en-ZA',{timeZone:'Africa/Johannesburg'})+' SAST' }
  catch{ return d.toLocaleString()+' SAST' } }

// Show a SA phone number the way an operator expects: a WhatsApp MSISDN like
// 27821234567 becomes +27 82 123 4567; a local 0821234567 stays 082 123 4567.
// Non-phone external_ids (discord/sim ids) pass through unchanged. Display only --
// the raw external_id stays the key.
function fmtPhone(v){ const s=String(v||''); const digits=s.replace(/[^0-9]/g,'')
  if(/^27[0-9]{9}$/.test(digits)){ const n=digits.slice(2); return '+27 '+n.slice(0,2)+' '+n.slice(2,5)+' '+n.slice(5) }
  if(/^0[0-9]{9}$/.test(digits)){ return digits.slice(0,3)+' '+digits.slice(3,6)+' '+digits.slice(6) }
  return s }

// Plain-language labels for the structured report fields, in the order an
// organiser most wants to read them. Missing fields are shown as "not given yet"
// so the operator sees the WHOLE picture (what is known and what is still
// outstanding), never a silently blank gap.
const REPORT_FIELDS=[
  ['species','Animals'],['symptoms','Signs'],['affected_count','How many affected'],
  ['dead_count','How many died'],['onset','When it started'],['suspected_disease','Suspected disease'],
  ['recent_movement','Recent movement'],['location','Where'],['how_to_find','How to find the place'],
  ['access_notes','Access / travel'],['farmer_available','Farmer available?'],
  ['contact_fallback','Other contact'],['identifying_traits','Identifying the animals'],
  ['photos','Photos'],['audio','Voice notes'],['notes','Other notes'],
]
// Fields a field visit genuinely needs that CANNOT be recovered once the worker
// leaves the site -- this is the one-shot reality. The readiness line tells the
// operator at a glance whether they can act on the report or should try to reach
// the farmer NOW (while perhaps still reachable) for the missing on-site facts.
const VISIT_CRITICAL=[
  ['species','what animals'],['symptoms','the signs'],['location','where'],
  ['how_to_find','how to find the place'],['farmer_available','if the farmer will be there'],
  ['contact_fallback','another contact'],
]
const has=(r,k)=>r[k]!=null&&String(r[k]).trim()!==''
// Derive per-field source labels from the action event log.
// Events with actor=agent and text containing 'recorded report fields' carry
// the field names that came from the AI conversation. Events with actor=operator
// carry fields set via the manual intake form. Returns a map of key -> 'ai'|'manual'|'both'.
function fieldSources(events){
  const src={}
  for(const e of (events||[])){
    if(e.kind!=='action') continue
    const isAgent=e.actor==='agent'
    const isOp=e.actor==='operator'
    if(!isAgent&&!isOp) continue
    // The action event text lists fields like "recorded report fields: species, symptoms"
    // or "updated report fields: location"
    const m=(e.text||'').match(/(?:recorded|updated) report fields?(?:[^:]*)?:\s*(.+)/i)
    if(!m) continue
    const keys=m[1].split(',').map(s=>s.trim()).filter(Boolean)
    for(const k of keys){
      if(isAgent) src[k]=src[k]==='manual'?'both':'ai'
      else src[k]=src[k]==='ai'?'both':'manual'
    }
  }
  return src
}
function sourceTag(s){
  if(!s) return ''
  if(s==='ai') return ' <span class="src-tag src-ai">[AI]</span>'
  if(s==='manual') return ' <span class="src-tag src-manual">[Manual]</span>'
  if(s==='both') return ' <span class="src-tag src-both">[Both]</span>'
  return ''
}
function fillPill(rfr){
  if(!rfr) return ''
  const cls = rfr.filled===rfr.total_fields?'ok':(rfr.visit_critical_filled<rfr.visit_critical_total?'low':'')
  return \`<span class="fill-pill \${cls}" title="Essential fields: \${rfr.visit_critical_filled} of \${rfr.visit_critical_total}">\${rfr.filled}/\${rfr.total_fields} fields\${rfr.visit_critical_filled<rfr.visit_critical_total?' ('+rfr.visit_critical_filled+'/'+rfr.visit_critical_total+' essential)':''}</span>\`
}
// Build map of field -> [{text, created_at}] from note events with a field key
function fieldNotes(events){
  const notes={}
  for(const e of (events||[])){
    if(e.kind!=='note'||!e.data?.field) continue
    if(!notes[e.data.field]) notes[e.data.field]=[]
    notes[e.data.field].push({text:e.text,created_at:e.created_at})
  }
  return notes
}
function reportPanel(reportRaw, events){
  let r={}; try{ r=reportRaw?JSON.parse(reportRaw):{} }catch{ r={} }
  const src=fieldSources(events)
  const fnotes=fieldNotes(events)
  // If nothing has been gathered yet, a calm empty state -- not an empty box.
  const any=REPORT_FIELDS.some(([k])=>has(r,k))
  const missingVC=VISIT_CRITICAL.filter(([k])=>!has(r,k))
  const missing=missingVC.map(([,label])=>label)
  // Plain readiness line: green when a visit has what it needs, amber listing the
  // unrecoverable gaps. Clicking the amber banner opens the intake form.
  let ready=''
  if(any){
    ready = missing.length
      ? '<div class="rep-ready amber" id="vc-banner" title="Click to fill in the missing fields" style="cursor:pointer">Still missing for a visit: '+esc(missing.join(', '))+' - click to fill in</div>'
      : '<div class="rep-ready ok">Has what a field visit needs.</div>'
  }
  const rows=REPORT_FIELDS.map(([k,label])=>{
    const val=has(r,k)?esc(String(r[k]))+sourceTag(src[k]):'<span class="rep-missing">not given yet</span>'
    const noteList=(fnotes[k]||[]).map(n=>'<div class="rep-field-note">'+esc(n.text)+'</div>').join('')
    return '<div class="rep-row" data-field="'+esc(k)+'"><span class="rep-label">'+esc(label)+'</span><span class="rep-val"><span class="rep-editable" data-key="'+esc(k)+'" title="Click to edit">'+val+'</span><button class="rep-note-btn" data-key="'+esc(k)+'" title="Add a note to this field">note</button>'+noteList+'</span></div>'
  }).join('')
  return '<div class="report"><div class="rep-head">Report from the field'
    +(any?'':' <span class="rep-missing">(nothing recorded yet)</span>')+'</div>'+ready+rows+'</div>'
}

let activeId = null, lastCasesJson = '', allCases = [], known = new Set()
let editing = false                         // pause polling while operator types
let connDown = false, firstLoad = true
const filt = { q:'', status:'' }

function attn(c){ return c.autonomy==='observe' || c.autonomy==='assisted'
  || String(c.tags||'').split(',').map(s=>s.trim()).includes('needs-human') }
// --- triage: which cases need a HUMAN now, and why, in plain words ---
// Deterministic, enum-derived (status/autonomy/tags/age); no LLM. Higher = more urgent.
function tagList(c){ return String(c.tags||'').split(',').map(t=>t.trim()).filter(Boolean) }
function ageHours(c){ const d=toDate(c.updated_at||c.created_at); return d?(Date.now()-d.getTime())/3.6e6:0 }
function tMs(c){ const d=toDate(c.updated_at||c.created_at); return d?d.getTime():0 }
// attnScore: 0 means "no human action needed" (hidden from the inbox).
function attnScore(c){
  if(c.status==='resolved'||c.status==='closed') return 0
  const tags=tagList(c)
  if(tags.includes('opted-out')) return 0             // contact left; never chase them
  let s=0
  if(tags.includes('needs-human')) s+=100             // contact explicitly asked for a person
  if(c.status==='waiting' && ageHours(c)>=24) s+=40   // genuinely stuck over a day
  if(c.autonomy==='observe') s+=20                    // casey only listens; soft nudge
  if(c.autonomy==='assisted') s+=15                   // person in the loop; soft nudge
  if(c.priority==='urgent') s+=15
  else if(c.priority==='high') s+=8
  s += Math.min(20, Math.floor(ageHours(c)))
  return s
}
// One honest, plain reason this case is in the inbox. First match wins.
function attnReason(c){
  const tags=tagList(c)
  if(tags.includes('needs-human')) return 'This person asked to talk to a real person.'
  if(c.status==='waiting' && ageHours(c)>=24) return 'No answer for over a day. A check-in may help.'
  if(c.autonomy==='observe') return 'casey is only listening here. A reply has to come from you.'
  if(c.autonomy==='assisted') return 'casey can draft, but you send. Open it to check.'
  return 'This one is worth a look.'
}
// Light heuristic: does the contact's most recent inbound look like it is NOT
// plain English? We only flag the operator to mirror the contact's language --
// the agent already replies in-language; this is a nudge for HUMAN replies, where
// a low-literacy operator might default to English. Non-latin script or a few
// common non-English words trip it. False negatives are fine; this never blocks.
const NON_EN_WORDS = /\\b(dankie|asseblief|hallo|goeie|siek|beeste|ngiyabonga|siyabonga|sawubona|izinkomo|usizo|enkosi|molo|nceda|iinkomo|dumela|kea leboha|dikgomo)\\b/i
function contactMaybeNonEnglish(events){
  const lastIn = (events||[]).filter(e=>e.kind==='inbound').slice(-1)[0]
  const txt = lastIn && lastIn.text
  if(!txt) return false
  // Non-ASCII character (accented/non-latin script) or a common non-English word.
  for(let i=0;i<txt.length;i++){ if(txt.charCodeAt(i)>127) return true }
  return NON_EN_WORDS.test(txt)
}
function matches(c){
  if(filt.status && c.status!==filt.status) return false
  if(!filt.q) return true
  const hay=(c.ref+' '+(c.subject||'')+' '+(c.summary||'')+' '+(c.external_id||'')+' '+c.channel).toLowerCase()
  return hay.includes(filt.q.toLowerCase())
}
function renderCounts(){
  const by={}; for(const c of allCases) by[c.status]=(by[c.status]||0)+1
  const a=allCases.filter(attn).length
  $('#counts').textContent = allCases.length+' total'+(a?' - '+a+' need attention':'')
}
function renderList(){
  const shown = allCases.filter(matches)
  if(!allCases.length){ $('#cases').innerHTML='<div class="empty">No cases yet.<br>Run <code>casey sim</code> or connect a channel to create one.</div>'; return }
  if(!shown.length){ $('#cases').innerHTML='<div class="empty">No cases match your filter.</div>'; return }
  $('#cases').innerHTML = shown.map(c=>\`
    <div class="case \${c.id===activeId?'active':''}" data-id="\${esc(c.id)}">
      <div class="top">\${attn(c)?'<span class="dot attn" title="needs attention (autonomy: '+esc(c.autonomy)+')"></span>':''}
        <span class="ref">\${esc(c.ref)}</span><span class="badge \${esc(c.priority)}">\${esc(c.priority)}</span>
        <span class="when" style="margin-left:auto" title="\${esc(fmtTime(c.updated_at||c.created_at))}">\${esc(rel(c.updated_at||c.created_at))}</span></div>
      <div class="sub">\${esc(c.channel)} - \${esc(stageLabel(c.status))} - \${esc(c.subject||'(no subject)')}\${c.fill_rate?fillPill(c.fill_rate):''}</div>
    </div>\`).join('')
  document.querySelectorAll('.case').forEach(el=>el.onclick=()=>openCase(el.dataset.id))
}
function renderTriage(){
  const el=$('#triage'); if(!el) return
  const inbox = allCases.map(c=>({c,score:attnScore(c)}))
    .filter(x=>x.score>0)
    .sort((a,b)=> b.score-a.score || tMs(b.c)-tMs(a.c))
    .slice(0,12).map(x=>x.c)
  if(!inbox.length){
    el.innerHTML='<h2>Needs you now</h2>'+
      '<div class="calm">All caught up. Nothing needs a person right now. '+
      'A new one will show up here the moment someone needs you.</div>'
    return
  }
  el.innerHTML='<h2>Needs you now <span class="n">'+inbox.length+'</span></h2>'+
    inbox.map(c=>\`
      <div class="tcase \${c.id===activeId?'active':''}" data-id="\${esc(c.id)}">
        <div class="why">\${esc(attnReason(c))}</div>
        <div class="meta">\${esc(c.ref)} - \${esc(c.channel)} - \${esc(c.subject||'(no subject)')} - \${esc(rel(c.updated_at||c.created_at))}</div>
      </div>\`).join('')
  el.querySelectorAll('.tcase').forEach(d=>d.onclick=()=>openCase(d.dataset.id))
}
function fillStatusFilter(){
  const cur=$('#statusf').value
  const stages=[...new Set(allCases.map(c=>c.status))].sort()
  const allLabel = simple ? 'all stages (everything)' : 'all stages'
  $('#statusf').innerHTML='<option value="">'+esc(allLabel)+'</option>'+stages.map(s=>\`<option value="\${esc(s)}"\${s===cur?' selected':''}>\${esc(stageLabel(s))}</option>\`).join('')
}
function setConn(down){
  if(down===connDown) return; connDown=down; $('#conn').classList.toggle('show',down)
}
async function loadCases(){
  if(editing) return                        // never clobber an in-progress edit
  let resp
  try{
    const params=new URLSearchParams({limit:'200'})
    if(filt.status) params.set('status',filt.status)
    if(filt.channel) params.set('channel',filt.channel)
    if(filt.q) params.set('q',filt.q)
    resp = await api('/api/cases?'+params.toString()).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() })
  }
  catch(e){ setConn(true); return }
  setConn(false)
  const cases = resp.cases || []
  const capEl=document.getElementById('cap-warn')
  if(resp.total>cases.length){
    if(!capEl){ const w=document.createElement('div'); w.id='cap-warn'
      w.style.cssText='background:rgba(200,140,0,.18);color:#9a6a00;font-size:12px;padding:5px 14px;text-align:center;border-bottom:1px solid rgba(200,140,0,.3)'
      w.textContent='Showing '+cases.length+' of '+resp.total+' cases. Use filters to find older ones.'
      document.getElementById('cases').before(w) }
  } else if(capEl){ capEl.remove() }
  const json = JSON.stringify(cases.map(c=>[c.id,c.ref,c.priority,c.channel,c.status,c.subject,c.autonomy,c.updated_at,c.fill_rate?.filled]))
  // notice genuinely-new cases (after first load) so an idle operator sees work
  if(!firstLoad){ const fresh=cases.filter(c=>!known.has(c.id)); if(fresh.length) toast(fresh.length+' new case'+(fresh.length>1?'s':'')) }
  checkHandoffs(cases)                         // detect needs-human, alert once per case
  for(const c of cases) known.add(c.id)
  firstLoad=false
  if(json===lastCasesJson){ // counts/rel-time may still drift; cheap refresh of relative labels
    document.querySelectorAll('.case .when').forEach(()=>{}); return }
  lastCasesJson = json; allCases = cases
  fillStatusFilter(); fillChannelFilter(); renderCounts(); renderListFull(); renderTriage()
}
function opt(val,cur){ return \`<option\${val===cur?' selected':''}>\${esc(val)}</option>\` }
const AUTONOMY_HELP = 'auto = agent replies on its own - assisted = agent drafts, human sends - observe = agent only logs, never replies'
// Plain-words "what to do now" line, picked from the case state. The first
// matching rule wins so the most action-needed state shows. Derives purely from
// enum-safe c.status / c.autonomy.
function todoHint(c){
  if(tagList(c).includes('opted-out')) return 'This person asked to stop. Do not message them. Leave this one alone.'
  if(c.status==='closed') return 'This one is finished. Nothing to do.'
  if(tagList(c).includes('needs-human')) return 'This person asked for a real person. Reply to them below.'
  if(c.status==='resolved') return 'This one is marked done. Close it if you are finished.'
  if(c.autonomy==='observe') return 'This one is waiting for you. Read it and reply, or set Who answers to auto so casey can answer.'
  if(c.autonomy==='assisted') return 'casey prepared a reply but waits for a person. Check it, then send.'
  if(c.status==='waiting') return 'Waiting on the person to reply. Nothing to do until they answer.'
  if(c.status==='new'||c.status==='triaging') return 'A new message came in. casey is sorting it out.'
  return 'casey is handling this one on its own. Step in only if you need to.'
}
// 2-4 canned replies for this case. Plain, warm, short. Clicking fills (never sends).
// Returns [] for opted-out contacts so the UI never nudges the operator to message them.
function cannedReplies(c){
  if(tagList(c).includes('opted-out')) return []
  const tags=tagList(c)
  if(tags.includes('needs-human'))
    return ['Hi, this is a real person now. How can I help you?',
            'I am here to help. Can you tell me a bit more?',
            'Thank you for waiting. I am looking into this for you now.']
  if(c.status==='waiting')
    return ['Just checking in - are you still there? Reply when you can.',
            'No rush. I am still here whenever you are ready.']
  return ['Thanks for your message. I am looking into this now.',
          'Got it - I will get back to you shortly.',
          'Can you tell me a little more so I can help?']
}
async function openCase(id){
  activeId = id
  clearHandoff(id)                             // operator is now handling it
  // deep-link the open case in the hash only; the ?token= stays in the real
  // query string (location.search is preserved by replaceState's relative URL),
  // so the hash is shareable without leaking the secret.
  const wantHash='#case='+encodeURIComponent(id)
  if(location.hash!==wantHash) history.replaceState(null,'',location.pathname+location.search+wantHash)
  if($('#wrap')) $('#wrap').classList.add('detail-open')
  let data
  try{ data = await api('/api/cases/'+encodeURIComponent(id)).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ $('#detail').innerHTML='<p class="empty">Could not load this case.</p>'; return }
  const {case:c, events, transitions, events_total, report_fill_rate:rfr} = data
  const more = events_total!=null && events.length<events_total
  $('#detail').innerHTML = \`
    <button class="icon-btn back" id="back">&lt;- cases</button>
    <h2 style="margin:6px 0 4px">\${esc(c.ref)} <span class="badge" title="\${esc(c.status)}">\${esc(stageLabel(c.status))}</span>
      \${fillPill(rfr)}
      <button class="copy" data-copy="\${esc(c.ref)}" title="copy ref">copy</button>
      <a href="/api/cases/\${encodeURIComponent(c.id)}/report.html" target="_blank" class="icon-btn" style="margin-left:4px;text-decoration:none;display:inline-block">Print</a></h2>
    <div class="todo" id="todo-hint">\${esc(todoHint(c))}</div>
    \${healthBadges(c.tags)}\${intakeModeBadge(c.tags)}
    <div style="color:var(--muted);margin-bottom:12px">\${esc(c.channel)}/\${esc(fmtPhone(c.external_id))}
      <button class="copy" data-copy="\${esc(c.external_id)}" title="copy contact">copy</button></div>
    \${reportPanel(c.report, events)}
    <button id="edit-report-btn" class="icon-btn" style="margin-bottom:14px">Edit report fields</button>
    <div class="row">
      <div><label>Priority</label><select id="f-priority">\${['low','normal','high','urgent'].map(p=>opt(p,c.priority)).join('')}</select>\${simple?'<p class="hint">How urgent this is.</p>':''}</div>
      <div><label>Autonomy</label><select id="f-autonomy" title="\${esc(AUTONOMY_HELP)}">\${['auto','assisted','observe'].map(p=>opt(p,c.autonomy)).join('')}</select>\${simple?'<p class="hint">Who answers the contact: the robot, a draft for you, or nobody.</p>':''}</div>
      <div><label>Assignee</label><input id="f-assignee" value="\${esc(c.assignee||'')}"></div>
    </div>
    <p class="hint">\${esc(AUTONOMY_HELP)}</p>
    <label>Subject</label><input id="f-subject" value="\${esc(c.subject||'')}">
    <label>Tags</label><input id="f-tags" value="\${esc(c.tags||'')}">
    <label>Summary</label><textarea id="f-summary" rows="3">\${esc(c.summary||'')}</textarea>
    <button id="save">Save edits</button>
    <div style="margin-top:14px"><label>\${simple?'Change the stage':'Override workflow stage'}</label>
      \${simple?'<p class="hint">Move this case to a new stage. For some stages the contact gets a short automatic note; for internal stages they are not told.</p>':''}
      \${transitions.map(t=>\`<button class="trans" data-to="\${esc(t)}" title="\${esc(t)}" style="background:#2a3340">-&gt; \${esc(stageLabel(t))}</button>\`).join(' ')||'<span class="hint">no transitions available</span>'}
    </div>
    <div style="margin-top:14px"><label>Reply to contact on \${esc(c.channel)}</label>
      <textarea id="f-reply" rows="2" placeholder="Send a message as a human operator... (Ctrl+Enter to send)" maxlength="4096"></textarea>
      <div class="reply-counter" id="reply-counter">0 / 4096</div>
      \${contactMaybeNonEnglish(events)?'<p class="canned-lab" style="color:var(--danger)">This person may not be writing in English. Please reply in their language.</p>':''}
      \${cannedReplies(c).length ? \`<p class="canned-lab">Or tap a ready-made reply to start with:</p>
      <div class="canned" id="canned">\${cannedReplies(c).map((t,i)=>
        \`<button type="button" data-i="\${i}">\${esc(t)}</button>\`).join('')}</div>\` : ''}
      <button id="send-reply">Send reply</button>
    </div>
    <div id="dup-panel"></div>
    <h3 style="margin:18px 0 6px">Timeline\${events_total!=null?\` (\${events.length}/\${events_total})\`:''}</h3>
    <div id="timeline">\${renderEvents(events)}</div>
    \${more?'<button id="more-events" style="background:#2a3340">Load older events</button>':''}
  \`
  // Possibly-the-same-case panel: load casey's grouping suggestions and offer a
  // one-click merge. Best-effort and isolated -- a suggestions failure must never
  // break the case view, so it is loaded after the main render and swallows errors.
  loadDuplicateSuggestions(id)
  // pause polling while any field is focused so a refresh can't wipe the edit;
  // resume on blur. A blur fallback guarantees we never get stuck paused.
  $('#detail').querySelectorAll('input,select,textarea').forEach(el=>{
    el.addEventListener('focus',()=>{editing=true})
    el.addEventListener('blur',()=>{editing=false})
  })
  const back=$('#back'); if(back) back.onclick=()=>{ $('#wrap').classList.remove('detail-open') }
  const editRptBtn=$('#edit-report-btn')
  if(editRptBtn) editRptBtn.onclick=()=>openIntakeForm(c)
  const vcBanner=$('#vc-banner')
  if(vcBanner) vcBanner.onclick=()=>openIntakeForm(c)
  // Inline per-field editing: click a field value -> edit in place -> Enter/blur saves.
  $('#detail').querySelectorAll('.rep-editable').forEach(span=>{
    span.onclick=async()=>{
      if(span.querySelector('input')) return   // already editing
      const k=span.dataset.key
      const cur=(c.report?JSON.parse(c.report):{})[k]||''
      span.classList.add('rep-saving')
      const inp=document.createElement('input')
      inp.className='rep-field-input'; inp.value=cur
      span.innerHTML=''; span.appendChild(inp)
      inp.focus(); span.classList.remove('rep-saving')
      const save=async()=>{
        const val=inp.value
        if(val===cur){span.textContent=cur||''; return}   // no change
        span.classList.add('rep-saving')
        const r=await api('/api/cases/'+encodeURIComponent(c.id)+'/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({[k]:val})})
        if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); span.textContent=cur||''; return }
        toast('saved','ok'); span.classList.remove('rep-saving')
        lastCasesJson=''; await loadCases(); await openCase(c.id)
      }
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();save()} if(e.key==='Escape'){span.textContent=cur||''} })
      inp.addEventListener('blur',save)
    }
  })
  // Per-field note buttons: prompt for a note text, save as kind=note event with field key.
  $('#detail').querySelectorAll('.rep-note-btn').forEach(btn=>{
    btn.onclick=async()=>{
      const k=btn.dataset.key
      const fieldLabel=(REPORT_FIELDS.find(([f])=>f===k)||[k,k])[1]
      const dlg=await showDialog({title:'Add a note',inputLabel:'Note for: '+fieldLabel,inputPlaceholder:'Type your note here...',confirmLabel:'Save note'})
      const text=(dlg&&dlg.value||'').trim()
      if(!text) return
      const r=await api('/api/cases/'+encodeURIComponent(c.id)+'/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,field:k})})
      if(!r.ok){ toast(await failMsg(r,'note failed'),'err'); return }
      toast('note saved','ok'); lastCasesJson=''; await loadCases(); await openCase(c.id)
    }
  })
  $('#detail').querySelectorAll('.copy').forEach(b=>b.onclick=()=>{
    try{ navigator.clipboard.writeText(b.dataset.copy); toast('copied') }catch{ toast('copy failed','err') } })
  $('#save').onclick = async ()=>{
    const btn=$('#save'); btn.disabled=true
    const body = {subject:$('#f-subject').value, summary:$('#f-summary').value, priority:$('#f-priority').value, tags:$('#f-tags').value, assignee:$('#f-assignee').value, autonomy:$('#f-autonomy').value}
    const r = await api('/api/cases/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    btn.disabled=false; editing=false
    if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); return }
    toast('saved','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const send = async ()=>{
    const ta=$('#f-reply'), text=ta.value.trim(); if(!text) return
    const btn=$('#send-reply'); btn.disabled=true
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    btn.disabled=false; editing=false
    if(!r.ok){ toast(await failMsg(r,'send failed'),'err'); return }
    const j=await r.json().catch(()=>({})); ta.value=''
    toast(j.delivered?'reply sent':(j.sent?'reply sent but it did not reach the contact - check the timeline':'reply logged (channel not connected)'),'ok'); await openCase(id)
  }
  $('#send-reply').onclick = send
  $('#f-reply').addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); send() } })
  const replyCounter=$('#reply-counter')
  if(replyCounter){
    const updateCounter=()=>{ const n=$('#f-reply').value.length; replyCounter.textContent=n+' / 4096'
      replyCounter.className='reply-counter'+(n>3800?' warn':'')+(n>=4096?' over':'') }
    $('#f-reply').addEventListener('input',updateCounter)
  }
  const canEl = $('#canned')
  if(canEl){
    const cans = cannedReplies(c)
    canEl.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      const ta=$('#f-reply'); ta.value=cans[+b.dataset.i]; ta.focus()
      ta.setSelectionRange(ta.value.length,ta.value.length)
    })
  }
  const moreBtn = $('#more-events')
  if(moreBtn) moreBtn.onclick = async ()=>{
    const off = events.length
    const older = await api('/api/cases/'+encodeURIComponent(id)+'/events?offset='+off).then(r=>r.json())
    $('#timeline').insertAdjacentHTML('beforeend', renderEvents(older.events||[]))
    if(!older.events||!older.events.length||off+older.events.length>=events_total) moreBtn.remove()
  }
  document.querySelectorAll('.trans').forEach(b=>b.onclick=async()=>{
    const toLabel = stageLabel(b.dataset.to)
    const dlg=await showDialog({title:'Move to: '+toLabel,inputLabel:'Reason (optional)',inputPlaceholder:'e.g. operator contacted farmer directly',confirmLabel:'Move case'})
    if(dlg===null) return                   // operator cancelled
    const reason=dlg.value||''
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/transition',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:b.dataset.to,reason:reason||undefined})})
    if(!r.ok){ toast(await failMsg(r,'transition failed'),'err'); return }
    const updated = await r.json().catch(()=>({}))
    const NOTIFIED=['in_progress','waiting','resolved']
    toast(NOTIFIED.includes(updated.status)?'Moved to '+toLabel+'. A short note was queued to the contact.':'Moved to '+toLabel+'. The contact was not told.','ok')
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
  renderListFull(); renderTriage()              // reflect the new active row in both lists
}
// Load and render the "possibly the same case" suggestions for the open case.
// Isolated and best-effort: any failure leaves the panel empty rather than
// breaking the detail view. Each suggestion shows the plain-language reasons and
// a merge button that folds the OTHER case into the one being viewed.
async function loadDuplicateSuggestions(id){
  const panel=$('#dup-panel'); if(!panel) return
  let j
  try{ j = await api('/api/cases/'+encodeURIComponent(id)+'/suggestions').then(r=>r.ok?r.json():null) }catch{ return }
  if(!j||!j.suggestions||!j.suggestions.length){ panel.innerHTML=''; return }
  panel.innerHTML='<div class="dup"><h3 style="margin:14px 0 6px">Possibly the same case</h3>'
    + '<p class="hint">casey thinks these reports may be the same outbreak. Merge folds the other case into this one (you can review before confirming).</p>'
    + j.suggestions.map(s=>\`<div class="dup-row"><b>\${esc(s.ref)}</b> \${esc(s.subject||'')}
        <span class="when">\${esc(s.reasons.join(', '))}</span>
        <button class="merge-btn" data-into="\${esc(s.id)}" data-ref="\${esc(s.ref)}" style="background:#3a2a40">Merge \${esc(s.ref)} into this</button></div>\`).join('')
    + '</div>'
  panel.querySelectorAll('.merge-btn').forEach(b=>b.onclick=async()=>{
    const dlg=await showDialog({title:'Merge '+b.dataset.ref+' into this case?',message:'The other case becomes a redirect. This is lossless and can be reviewed on the timeline.',inputLabel:'Why are these the same outbreak? (optional)',inputPlaceholder:'e.g. same farm, same symptoms reported separately',confirmLabel:'Merge cases',danger:true})
    if(dlg===null) return
    const reason=dlg.value||''
    b.disabled=true
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/merge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({into:b.dataset.into,reason:reason||undefined})})
    b.disabled=false
    if(!r.ok){ toast(await failMsg(r,'merge failed'),'err'); return }
    const res=await r.json().catch(()=>({}))
    toast(res.alreadyMerged?'already merged':'merged '+b.dataset.ref+' in ('+(res.movedEvents||0)+' events)','ok')
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
}
function renderEvents(events){
  return events.map(e=>\`<div class="ev \${esc(e.kind)}"><span class="k">\${esc(e.kind)}/\${esc(e.actor)}</span> \${esc(e.text||'')} <span class="when" title="\${esc(fmtTime(e.created_at))}">\${esc(rel(e.created_at))}</span></div>\`).join('')
}
// Plain-language warning chips for the time-guardrail health:* tags the sweep
// maintains, so an operator sees at a glance that a case is going wrong over time.
const HEALTH_LABEL={'health:stale':'Going cold (no recent activity)','health:stuck':'Stuck in this stage too long','health:unanswered_handoff':'A person was asked for and not yet answered','health:abandoned_intake':'Intake left with on-site facts missing','health:never_closed':'Resolved but never closed','health:timestamp_corrupt':'Case time data looks wrong'}
function healthBadges(tags){
  const list=String(tags||'').split(',').map(s=>s.trim()).filter(t=>t.indexOf('health:')===0)
  if(!list.length) return ''
  return '<div class="health">'+list.map(t=>\`<span class="health-chip" title="\${esc(t)}">\${esc(HEALTH_LABEL[t]||t)}</span>\`).join('')+'</div>'
}
function intakeModeBadge(tags){
  const t=String(tags||'').split(',').map(s=>s.trim())
  if(t.includes('intake_mode:manual')) return '<span class="intake-mode-badge" title="Report entered by an operator via the dashboard">Entered by operator</span>'
  return ''
}
// --- theme ---
function applyTheme(t){ document.documentElement.dataset.theme=t; try{localStorage.casey_theme=t}catch{}
  $('#theme').textContent = t==='light'?'dark':'light' }
applyTheme((()=>{ try{return localStorage.casey_theme}catch{} })() || (matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'))
$('#theme').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light')
// --- plain-language / simple mode toggle (persisted like the theme) ---
function applySimple(on){ simple=!!on; try{localStorage.casey_simple=on?'1':''}catch{}
  $('#simple').classList.toggle('active',simple)
  $('#simple').title = simple ? 'Plain-language mode ON - click for technical stage names' : 'Plain-language mode: show friendly stage names'
  fillStatusFilter(); renderListFull(); if(activeId) openCase(activeId) }
applySimple((()=>{ try{return localStorage.casey_simple}catch{} })()==='1')
$('#simple').onclick=()=>applySimple(!simple)
// --- first-run help overlay (remembered in localStorage; re-openable via ? ) ---
let helpOpen = false
function helpSeen(){ try{ return localStorage.casey_help_seen==='1' }catch{ return false } }
function showHelp(){ helpOpen=true; $('#help-ovl').classList.add('show') }
function hideHelp(){ helpOpen=false; $('#help-ovl').classList.remove('show'); try{ localStorage.casey_help_seen='1' }catch{} }
$('#help').onclick = showHelp
$('#help-close').onclick = hideHelp
$('#help-ovl').addEventListener('click', e=>{ if(e.target===$('#help-ovl')) hideHelp() })
if(!helpSeen()) showHelp()
// --- filters ---
let qTimer
$('#q').addEventListener('input',e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ filt.q=e.target.value; lastCasesJson=''; loadCases() },300) })
$('#statusf').addEventListener('change',e=>{ filt.status=e.target.value; lastCasesJson=''; loadCases() })
$('#refresh').onclick=()=>{ lastCasesJson=''; loadCases() }
// --- keyboard nav: / focus search, j/k move, enter open, esc clear/back ---
document.addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
  if(e.key==='/' && !typing){ e.preventDefault(); $('#q').focus(); return }
  if(e.key==='Escape'){ if(helpOpen){hideHelp()} else if(typing){document.activeElement.blur()} else if($('#q').value){filt.q='';$('#q').value='';renderListFull()} return }
  if(typing) return
  if(e.key==='j'||e.key==='k'||e.key==='ArrowDown'||e.key==='ArrowUp'){
    const shown=allCases.filter(matchesFull); if(!shown.length)return
    let i=shown.findIndex(c=>c.id===activeId)
    i = (e.key==='j'||e.key==='ArrowDown') ? Math.min(shown.length-1,i+1) : Math.max(0,i<0?0:i-1)
    openCase(shown[i].id)
    const el=document.querySelector('.case.active'); if(el)el.scrollIntoView({block:'nearest'})
  }
})
// --- deep-link restore + poll ---
function restoreFromHash(){ const m=/#case=([^&]+)/.exec(location.hash); if(m) return decodeURIComponent(m[1]) }
async function restoreRefFromHash(){
  const m=/#ref=([^&]+)/.exec(location.hash); if(!m) return
  const ref=decodeURIComponent(m[1])
  // pre-populate search and fetch the matching case
  filt.q=ref; $('#q').value=ref; lastCasesJson=''
  await loadCases()
  const found=allCases.find(c=>c.ref===ref); if(found) openCase(found.id)
}
// Handoff banner click handlers (attached here so openCase is defined).
$('#handoff').onclick=(e)=>{ if(e.target.id==='handoff-dismiss') return
  const c=handoffQueue[handoffQueue.length-1]; if(c) openCase(c.id) }
$('#handoff-dismiss').onclick=(e)=>{ e.stopPropagation(); handoffQueue=[]; renderHandoff() }
// Plain-words AI-helper health pill. Green when online, amber otherwise; the
// title carries the full plain sentence so an operator sees WHY auto-replies may
// be paused. Failure to fetch is itself "unknown" (amber) -- never a silent green.
let lastHealth=null
async function refreshHealth(){
  const el=$('#aihealth'); if(!el) return
  let h
  try{ h=await api('/api/health').then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ h={ ok:false, label:'AI helper: unknown', detail:'Cannot reach the server to check the AI helper.' } }
  lastHealth=h
  el.textContent=h.label
  el.title=h.detail+(h.model?(' ('+h.model+')'):'')
  el.style.background=h.ok?'rgba(34,160,80,.18)':'rgba(200,140,0,.20)'
  el.style.color=h.ok?'#1c8c44':'#9a6a00'
}
// --- channel filter ---
function fillChannelFilter(){
  const cur=$('#channelf').value
  const channels=[...new Set(allCases.map(c=>c.channel).filter(Boolean))].sort()
  $('#channelf').innerHTML='<option value="">all channels</option>'+channels.map(ch=>\`<option value="\${esc(ch)}"\${ch===cur?' selected':''}>\${esc(ch)}</option>\`).join('')
  if(cur) $('#channelf').value=cur
}
$('#channelf').addEventListener('change',e=>{ filt.channel=e.target.value; lastCasesJson=''; loadCases() })
const _matchesOrig = matches
// patch matches to honour channel filter
;(()=>{
  const base = matches
  window._matchesFn = (c)=>{
    if(filt.channel && c.channel!==filt.channel) return false
    return base(c)
  }
})()
// replace matches with channel-aware version
function matchesFull(c){
  if(filt.channel && c.channel!==filt.channel) return false
  return matches(c)
}
// Re-define renderList to use matchesFull
function renderListFull(){
  const shown = allCases.filter(matchesFull)
  if(!allCases.length){ $('#cases').innerHTML='<div class="empty">No cases yet.<br>Run <code>casey sim</code> or connect a channel to create one.</div>'; return }
  if(!shown.length){ $('#cases').innerHTML='<div class="empty">No cases match your filter.</div>'; return }
  $('#cases').innerHTML = shown.map(c=>\`
    <div class="case \${c.id===activeId?'active':''}" data-id="\${esc(c.id)}">
      <div class="top">\${attn(c)?'<span class="dot attn" title="needs attention (autonomy: '+esc(c.autonomy)+')"></span>':''}
        <span class="ref">\${esc(c.ref)}</span><span class="badge \${esc(c.priority)}">\${esc(c.priority)}</span>
        <span class="when" style="margin-left:auto" title="\${esc(fmtTime(c.updated_at||c.created_at))}">\${esc(rel(c.updated_at||c.created_at))}</span></div>
      <div class="sub">\${esc(c.channel)} - \${esc(stageLabel(c.status))} - \${esc(c.subject||'(no subject)')}\${c.fill_rate?fillPill(c.fill_rate):''}</div>
    </div>\`).join('')
  document.querySelectorAll('.case').forEach(el=>el.onclick=()=>openCase(el.dataset.id))
}
filt.channel = ''

// --- intake form (New Case / Edit Report) ---
// Fields a field visit cannot recover once the worker leaves -- visit-critical
// fields come first and are marked required. textarea:true for long free-text.
const INTAKE_FIELDS=[
  // -- visit-critical (needed for a field visit) --
  ['species','Which animals?','e.g. cattle, sheep, goats, pigs',{required:true}],
  ['symptoms','What signs are you seeing?','e.g. drooling, limping, not eating, sudden death',{required:true,textarea:true}],
  ['location','Where are the animals?','Farm name, nearest town, or GPS coordinates',{required:true}],
  ['how_to_find','How do we find the place?','Road name, landmark, or directions from the nearest town',{required:true,textarea:true}],
  ['farmer_available','Will the farmer be there?','e.g. yes, or phone first on 082...',{required:true}],
  ['contact_fallback','Any other contact person?','Name and phone number if different from this one',{required:true}],
  // -- additional details --
  ['affected_count','How many are affected?','e.g. 5'],
  ['dead_count','How many have died?','e.g. 2 (write 0 if none)'],
  ['onset','When did it start?','e.g. yesterday morning, 3 days ago'],
  ['suspected_disease','Do you know what disease it might be?','e.g. FMD, lumpy skin - leave blank if unsure'],
  ['recent_movement','Have the animals moved recently?','e.g. yes, bought from market last week'],
  ['access_notes','Any access or travel notes?','e.g. gravel road, locked gate - call first',{textarea:true}],
  ['identifying_traits','How do we identify the animals?','e.g. red tag in ear, black-and-white Friesians'],
  ['photos','Are there photos?','yes / no, or a description of what they show'],
  ['audio','Are there voice notes?','yes / no'],
  ['notes','Anything else to note?','Any extra information',{textarea:true}],
]
const VC_KEYS = new Set(['species','symptoms','location','how_to_find','farmer_available','contact_fallback'])
let intakeCaseId = null    // set when editing existing case; null = new case
function openIntakeForm(caseRow){
  intakeCaseId = caseRow ? caseRow.id : null
  const isEdit = !!caseRow
  $('#intake-title').textContent = isEdit ? 'Edit report fields' : 'New case'
  const contactSection = $('#intake-contact-fields')
  contactSection.style.display = isEdit ? 'none' : ''
  // build report fields
  let existingReport = {}
  if(caseRow && caseRow.report){ try{ existingReport=JSON.parse(caseRow.report) }catch{} }
  // fill rate bar (edit mode only)
  const fillBar = $('#intake-fill-bar')
  if(isEdit){
    const total=INTAKE_FIELDS.length
    const filled=INTAKE_FIELDS.filter(([k])=>existingReport[k]!=null&&String(existingReport[k]).trim()!=='').length
    fillBar.style.display='flex'
    $('#intake-fill-label').textContent=filled+' of '+total+' fields filled'
    $('#intake-fill-pct').style.width=Math.round(filled/total*100)+'%'
  } else { fillBar.style.display='none' }
  // render fields: VC section header first, then additional-details header
  let _fhtml = '<div class="intake-section-head">Visit-critical fields <span class="intake-vc-note">(needed for a field visit)</span></div>'
  let _addHead = false
  for(const [k,label,hint,opts={}] of INTAKE_FIELDS){
    if(!VC_KEYS.has(k) && !_addHead){ _fhtml += '<div class="intake-section-head" style="margin-top:14px">Additional details</div>'; _addHead=true }
    const val=esc(existingReport[k]||'')
    const req=opts.required?' <span class="intake-req" title="Needed for a field visit">*</span>':''
    _fhtml += \`<label for="int-\${k}">\${esc(label)}\${req}</label>\`
    if(opts.textarea){ _fhtml += \`<textarea id="int-\${k}" name="\${k}" placeholder="\${esc(hint)}" rows="2" autocomplete="off">\${val}</textarea>\` }
    else { _fhtml += \`<input id="int-\${k}" name="\${k}" placeholder="\${esc(hint)}" value="\${val}" autocomplete="off">\` }
  }
  $('#intake-report-fields').innerHTML = _fhtml
  $('#intake-error').style.display='none'
  $('#intake-ovl').classList.add('show')
  setTimeout(()=>{ if(isEdit) document.getElementById('int-species')?.focus()
    else document.getElementById('int-name')?.focus() }, 80)
}
function closeIntakeOvl(){ $('#intake-ovl').classList.remove('show'); intakeCaseId=null }
$('#intake-cancel').onclick=closeIntakeOvl
$('#intake-ovl').addEventListener('click',e=>{ if(e.target===$('#intake-ovl')) closeIntakeOvl() })
// Escape closes the overlay; Tab order is natural (DOM order)
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&$('#intake-ovl').classList.contains('show')){ e.preventDefault(); closeIntakeOvl() }
})
$('#intake-submit').onclick=async()=>{
  const btn=$('#intake-submit'); btn.disabled=true
  const errEl=$('#intake-error'); errEl.style.display='none'
  try{
    let caseId=intakeCaseId
    if(!caseId){
      const rawPhone=$('#int-phone').value.trim()
      if(rawPhone){
        const digits=rawPhone.replace(/[\s\-()]/g,'')
        if(!/^0[0-9]{9}$/.test(digits)&&!/^\+27[0-9]{9}$/.test(digits)){
          errEl.textContent='Phone must be a South African number: 0821234567 or +27821234567'
          errEl.style.display=''; btn.disabled=false; return
        }
      }
      // create new case
      const body={
        name:$('#int-name').value.trim(),
        phone:rawPhone,
        subject:$('#int-subject').value.trim()||'Field report'
      }
      const r=await api('/api/cases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      if(r.status===409){
        const e=await r.json().catch(()=>({}))
        // offer to open the existing case instead of failing
        const open=window.confirm((e.error||'A case already exists for this contact')+' ('+e.existing_ref+'). Open it?')
        btn.disabled=false
        if(open){ $('#intake-ovl').classList.remove('show'); intakeCaseId=null; await openCase(e.existing_id) }
        return
      }
      if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'Failed to create case') }
      const j=await r.json(); caseId=j.id
    }
    // gather report fields (skip blanks)
    const report={}
    for(const [k] of INTAKE_FIELDS){
      const v=(document.getElementById('int-'+k)||{}).value||''
      if(v.trim()) report[k]=v.trim()
    }
    if(Object.keys(report).length){
      const r2=await api('/api/cases/'+encodeURIComponent(caseId)+'/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})
      if(!r2.ok){ const e=await r2.json().catch(()=>({})); throw new Error(e.error||'Failed to save report') }
    }
    const wasEdit=!!intakeCaseId
    $('#intake-ovl').classList.remove('show'); intakeCaseId=null
    toast(wasEdit?'Report updated':'Case created','ok')
    lastCasesJson=''; await loadCases(); await openCase(caseId)
  } catch(e){ errEl.textContent=e.message; errEl.style.display=''; }
  btn.disabled=false
}
$('#new-case-btn').onclick=()=>openIntakeForm(null)
// --- export CSV (fetch via api() so the X-Casey-Token header is sent, then save as blob) ---
$('#export-btn').onclick=async()=>{
  const params=new URLSearchParams()
  if(filt.status) params.set('status',filt.status)
  if(filt.channel) params.set('channel',filt.channel)
  const url='/api/cases/export.csv'+(params.toString()?'?'+params.toString():'')
  try{
    const r=await api(url)
    if(!r.ok){ toast('Export failed: '+r.status,'err'); return }
    const blob=await r.blob()
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='casey-cases.csv'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(()=>URL.revokeObjectURL(a.href),5000)
  }catch(e){ toast('Export failed: '+e.message,'err') }
}
// Inline modal replacement for native prompt()/confirm() -- works on mobile/PWA.
// Uses DOM creation (not innerHTML) to avoid conflicts with the outer template literal.
// Returns a Promise resolving to {value, confirmed:true} or null if cancelled.
function showDialog(opts){
  const { title='', message='', inputLabel='', inputPlaceholder='', confirmLabel='OK', cancelLabel='Cancel', danger=false } = opts || {}
  return new Promise(function(resolve){
    function mk(tag, css, txt){ const el=document.createElement(tag); if(css) el.style.cssText=css; if(txt!=null) el.textContent=txt; return el }
    const overlay=mk('div','position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true')
    const card=mk('div','background:var(--panel);border:1px solid var(--border);border-radius:10px;max-width:420px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px')
    if(title){ const h=mk('h3','margin:0 0 8px;font-size:16px',title); card.appendChild(h) }
    if(message){ const p=mk('p','margin:0 0 10px;color:var(--muted);line-height:1.5',message); card.appendChild(p) }
    let inp=null
    if(inputLabel){
      const lab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)',inputLabel); card.appendChild(lab)
      inp=document.createElement('textarea'); inp.rows=2; inp.placeholder=inputPlaceholder
      inp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;resize:vertical'
      card.appendChild(inp)
    }
    const row=mk('div','display:flex;gap:8px;margin-top:14px;justify-content:flex-end')
    const cancelBtn=mk('button','background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0',cancelLabel)
    const okBtn=mk('button','background:'+(danger?'var(--danger)':'var(--accent)')+';color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0',confirmLabel)
    row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    const close=function(confirmed, value){ overlay.remove(); resolve(confirmed?{value:value||'',confirmed:true}:null) }
    okBtn.onclick=function(){ close(true, inp?inp.value:'') }
    cancelBtn.onclick=function(){ close(false) }
    overlay.addEventListener('keydown',function(e){ if(e.key==='Escape') close(false) })
    setTimeout(function(){ if(inp) inp.focus(); else okBtn.focus() }, 60)
  })
}
async function boot(){
  await loadCases(); await refreshHealth()
  const id=restoreFromHash(); if(id){ openCase(id); return }
  await restoreRefFromHash()
}
boot(); const _casesIv = setInterval(loadCases, 5000); const _healthIv = setInterval(refreshHealth, 15000)
window.addEventListener('beforeunload', () => { clearInterval(_casesIv); clearInterval(_healthIv) })
window.__casey = { esc, rel, toast, loadCases, openCase, applyTheme, refreshHealth, get lastHealth(){return lastHealth},
  applySimple, stageLabel, STAGE_LABEL,
  get activeId(){return activeId}, get allCases(){return allCases}, get filt(){return filt},
  get editing(){return editing}, get simple(){return simple},
  setFilter(q){filt.q=q;renderListFull()},
  renderList: renderListFull, matchesFull, openIntakeForm,
  // help overlay + per-case hint, exposed for browser-witness
  showHelp, hideHelp, helpSeen, todoHint, get helpOpen(){return helpOpen},
  // triage inbox + coaching + handoff, exposed for browser-witness
  attnScore, attnReason, cannedReplies, renderTriage,
  checkHandoffs, clearHandoff, hasHandoff, contactMaybeNonEnglish,
  INTAKE_FIELDS,
  get handoffQueue(){return handoffQueue}, get handoffSeen(){return handoffSeen},
  showDialog }   // exposed for browser-witness
</script>
</body></html>`
