// Map view surfaces: case pins (agent-estimated lat/lon, no geocoding),
// field-worker live-location overlay, learned operator working-area
// identities, and dispatch-suggestion. All aggregate/PII-free like every
// other dashboard rollup (see AGENTS.md "The map is a visual rollup").
//
// deps: store, wrap, authed, actingOperator, isOpenCase, parseJsonArraySafe,
//   getRoster
export function registerMap(app, deps) {
  const { store, wrap, authed, actingOperator, isOpenCase, parseJsonArraySafe, getRoster } = deps

  // Learned operator identities -- the roster enriched with each operator's
  // working-area history (case-store.js learnOperatorActivity), for the map's
  // operator-coverage overlay and a "who covers where" panel. Internal-team data
  // (not contact PII), still gated by login like every other /api route --
  // never exposed on the unauthenticated /report surface.
  app.get('/api/operators/identities', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const rows = await store.listOperatorIdentities()
    const byId = new Map(rows.map(r => [r.operator_id, r]))
    const identities = (await getRoster()).map(o => {
      const r = byId.get(o.id)
      return {
        id: o.id, name: o.name,
        areas: r ? parseJsonArraySafe(r.areas) : [],
        last_seen_at: r?.last_seen_at || null,
        case_count: r?.case_count || 0,
      }
    })
    res.json({ identities })
  }))

  // Map view: every open + recently-closed case with a resolvable point. lat/lon
  // come ONLY from the agent's own case_report call -- its own best-effort
  // estimate from the location the worker described, using the model's own world
  // knowledge (see caseSystemPrompt); casey never looks anything up server-side.
  // Aggregate/PII-free like every other dashboard rollup: no external_id, no
  // owner_name/contact_fallback/present_person -- only what a map pin needs
  // (species, case_type, status, assignee, cluster membership). Capped like every
  // other list endpoint (PAGE_MAX-scale window) so clustering never chokes on an
  // unbounded pull; excluded-count is reported, never silently dropped.
  const MAP_CASE_CAP = 2000
  app.get('/api/map/cases', wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 365)
    const where = {}
    if (days > 0) where.created_at = { $gte: Math.floor(Date.now() / 1000) - days * 86400 }
    const all = await store.listCases(where, { limit: MAP_CASE_CAP + 1, offset: 0 })
    const truncated = all.length > MAP_CASE_CAP
    const pool = truncated ? all.slice(0, MAP_CASE_CAP) : all
    const { buildClusters } = await import('../../clusters.js')
    const clusters = buildClusters(pool.filter(isOpenCase))
    const clusterByRef = new Map()
    clusters.forEach((cl, i) => { for (const m of cl.members) clusterByRef.set(m.ref, i) })

    const pins = [], unresolved = []
    for (const c of pool) {
      let report = {}
      try { report = c.report ? JSON.parse(c.report) : {} } catch { report = {} }
      const lat = c.lat != null && c.lat !== '' ? Number(c.lat) : null
      const lon = c.lon != null && c.lon !== '' ? Number(c.lon) : null
      const row = {
        id: c.id, ref: c.ref, status: c.status, case_type: c.case_type || 'unset',
        species: report.species || null, location: report.location || null,
        symptoms: report.symptoms || null,
        affected_count: report.affected_count ?? null, dead_count: report.dead_count ?? null,
        onset: report.onset || null,
        assignee: c.assignee || null, priority: c.priority,
        cluster: clusterByRef.has(c.ref) ? clusterByRef.get(c.ref) : null,
        last_event_at: c.last_event_at,
      }
      if (lat != null && Number.isFinite(lat) && lon != null && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        pins.push({ ...row, lat, lon })
      } else {
        unresolved.push(row)
      }
    }
    res.json({
      pins, unresolved, unresolved_count: unresolved.length,
      clusters: clusters.map((cl, i) => ({
        index: i, count: cl.count, location: cl.location,
        species: cl.species, symptoms: cl.symptoms, reported_disease_names: cl.reported_disease_names,
      })),
      truncated, cap: MAP_CASE_CAP, total_considered: all.length,
    })
  }))

  // Field-worker location layer: recent case_checkin self-reports, for the map's
  // dispatch/direction overlay. Distinct from /api/map/cases (case pins) and from
  // /api/operators/identities (a dashboard-operator's LEARNED historical coverage
  // area) -- this is a field_worker CONTACT's own LIVE self-reported position.
  // Staleness-filtered by the tunable workerLocationStaleMs threshold (default 3h)
  // so an hours-old ping does not read as "here right now". Internal-team-only,
  // same gate as every other dashboard route -- never on the public /report form.
  app.get('/api/map/workers', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const th = (store.resolveThresholds ? await store.resolveThresholds() : null) || {}
    const staleMs = Number.isFinite(th.workerLocationStaleMs) ? th.workerLocationStaleMs : 3 * 3600e3
    const now = Date.now()
    const contacts = await store.listContacts({ limit: 1000 })
    const workers = contacts
      .filter(c => c.tier === 'field_worker' && c.last_location_lat != null && c.last_location_lon != null && c.last_location_at)
      .map(c => {
        const at = Date.parse(c.last_location_at)
        const ageMs = Number.isFinite(at) ? now - at : null
        return {
          id: c.id, display_name: c.display_name || null,
          lat: Number(c.last_location_lat), lon: Number(c.last_location_lon),
          last_location_at: c.last_location_at, age_ms: ageMs,
          stale: ageMs == null || ageMs > staleMs,
        }
      })
      .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lon) && Math.abs(w.lat) <= 90 && Math.abs(w.lon) <= 180)
    res.json({ workers, stale_ms: staleMs })
  }))

  // dispatch-from-map PRD row: an operator, looking at the map's case pins
  // alongside its field-worker location overlay (GET /api/map/workers just
  // above), selects a worker to direct to a case. This does NOT message the
  // worker directly -- casey's WhatsApp cost-policy invariant (this repo's own
  // earlier session work: casey must never autonomously originate a WhatsApp
  // message outside the free 24h session window) applies here exactly the
  // same as any other proactive outreach. A dispatch is recorded as a QUEUED
  // suggestion (an 'action' event on the case, tagged 'dispatch-suggested',
  // never an outbound send) -- the same queue-never-autofire discipline the
  // earlier session's pending-outreach design established for alert/nudge
  // messages. The worker only actually hears about it through casey's normal
  // reply path the next time THEY message in (their own inbound opens a free
  // session window; an LLM composing that turn's reply can surface the
  // pending dispatch then, per the existing "the agent drives the whole
  // conversation" design principle -- no new proactive-send code path is
  // introduced here, only the durable record a future turn can read).
  app.post('/api/cases/:id/dispatch', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const c = await store.getCase(req.params.id)
    if (!c) return res.status(404).json({ error: 'not found' })
    const workerId = String(req.body?.worker_id || '').trim()
    if (!workerId) return res.status(400).json({ error: 'worker_id is required' })
    const worker = await store.getContact?.(workerId).catch(() => null)
    if (!worker) return res.status(404).json({ error: 'worker not found' })
    if (worker.tier !== 'field_worker') return res.status(400).json({ error: 'selected contact is not a field_worker' })
    const op = actingOperator(req)
    const note = String(req.body?.note || '').trim().slice(0, 500)
    // PII discipline: the case's own timeline may already carry the contact's
    // external_id elsewhere (case timelines are operator-facing, not PII-
    // scrubbed -- see AGENTS.md), but the worker's own PII-free display name
    // (never external_id) is what identifies them in THIS event, matching
    // the same enquiryRow discipline used for every worker-facing surface.
    const label = worker.display_name || 'a field worker'
    const tags = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    if (!tags.includes('dispatch-suggested')) {
      await store.updateCase(c.id, { tags: [...tags, 'dispatch-suggested'].join(',') }, op)
    }
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `Dispatch suggested: ${label}${note ? ` -- ${note}` : ''}`,
      data: { dispatch_worker_id: worker.id, by: op.id, note: note || null },
    })
    res.json({ ok: true })
  }))
}
