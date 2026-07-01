// case-tools.js  --  the agent's hands on the case system of record.
//
// These are freddie tools ({ name, toolset, schema, handler }). They give the
// agent full autonomous control over a case while keeping every action on the
// append-only timeline, so a human can observe and override. The handlers close
// over a CaseStore (resolved lazily from case-runtime so the freddie plugin
// loader can import this without the store existing yet).

import { getCaseStore } from './case-runtime.js'
import { AGENT_USER } from './case-store.js'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

// Build the array of tool objects bound to an explicit store (used by tests and
// by anywhere that wants the tools without the runtime singleton).
export function buildCaseToolset(storeOrNull) {
  const store = () => storeOrNull || getCaseStore()

  const tools = [
    {
      name: 'case_get',
      toolset: 'cases',
      schema: {
        name: 'case_get',
        description: 'Fetch a case by id, including its recent timeline events. Use to refresh your view before acting.',
        parameters: { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      },
      handler: async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const events = await store().listEvents(id, { limit: 30 })
        // slimCase parses the report into structured fields so the agent sees
        // what it already has and never re-asks the farmer (matches case_list /
        // case_update, which both slim; case_get must not be the odd one out).
        return { case: slimCase(c), events: events.map(slimEvent) }
      },
    },
    {
      name: 'case_list',
      toolset: 'cases',
      schema: {
        name: 'case_list',
        description: 'List cases, optionally filtered by status/channel/assignee/location. Use `location` (a town, area, or place a person mentions) to find reports in a place -- this is the place-enquiry tool. Returns most-recently-active first, PII-free.',
        parameters: {
          type: 'object',
          properties: {
            status: str('Filter by workflow status', { enum: ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed'] }),
            channel: str('Filter by channel'),
            assignee: str('Filter by assignee'),
            location: str('A place name (town/area) to match reports whose location contains it'),
            limit: { type: 'number', default: 25 },
          },
        },
      },
      handler: async ({ status, channel, assignee, location, limit = 25 }) => {
        const where = {}
        if (status) where.status = status
        if (channel) where.channel = channel
        if (assignee) where.assignee = assignee
        // A place enquiry: location lives in the free-text report JSON, not a queryable
        // column, so pull a wider window and JS-filter on the report location substring.
        const pull = location ? Math.max(limit * 20, 500) : limit
        let rows = await store().listCases(where, { limit: pull })
        if (location) {
          const needle = String(location).toLowerCase()
          rows = rows.filter(c => {
            let loc = ''
            try { loc = (c.report ? JSON.parse(c.report) : {}).location || '' } catch { loc = '' }
            return String(loc).toLowerCase().includes(needle)
          }).slice(0, limit)
        }
        // A LIST spans cases the asker may not own, so project each row PII-FREE
        // (enquiryRow: ref/status/species/location only) -- NEVER the full slimCase
        // report, which carries owner_name/contact_fallback/other-worker contact text.
        return { count: rows.length, cases: rows.map(enquiryRow) }
      },
    },
    {
      name: 'case_update',
      toolset: 'cases',
      schema: {
        name: 'case_update',
        description: 'Update editable case fields (subject, summary, priority, tags, assignee, autonomy). Keep `summary` current -- it is your working memory of the case.',
        parameters: {
          type: 'object',
          properties: {
            id: str('Case id'),
            subject: str('Short human title'),
            summary: str('One-paragraph rolling summary of the case state'),
            priority: str('Priority', { enum: ['low', 'normal', 'high', 'urgent'] }),
            tags: str('Comma-separated tags'),
            assignee: str('Operator handle, or "agent"'),
          },
          required: ['id'],
        },
      },
      handler: async ({ id, ...patch }) => {
        const clean = pick(patch, ['subject', 'summary', 'priority', 'tags', 'assignee'])
        if (!Object.keys(clean).length) return { error: 'no editable fields supplied' }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // Autonomy is operator control: it is set only from the dashboard, never by
        // the agent -- otherwise the agent could flip observe back to auto and
        // escape the very mode an operator used to stop it acting. So in observe
        // mode the agent may only observe; all content edits are blocked.
        if (c.autonomy === 'observe') {
          return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
        }
        const updated = await store().updateCase(id, clean, AGENT_USER)
        await store().appendEvent(id, { kind: 'action', actor: 'agent', text: `updated ${Object.keys(clean).join(', ')}`, data: clean })
        return { ok: true, case: slimCase(updated) }
      },
    },
    {
      name: 'case_report',
      toolset: 'cases',
      schema: {
        name: 'case_report',
        description: 'Record what you have learned about an animal-disease report, one field at a time, as the farmer gives it. Pass ONLY the fields you actually learned this turn -- they merge into the running report, so you never lose earlier facts and never need to repeat a field the farmer already gave. This is how the organisers see a structured, organised report without the farmer being interrogated. Leave a field out if you do not know it yet; do not guess.',
        parameters: {
          type: 'object',
          properties: {
            id: str('Case id'),
            species: str('Animal(s): cattle, sheep, goats, pigs, etc.'),
            symptoms: str('What the farmer sees: drooling, blisters, lameness, sudden death, etc.'),
            location: str('Where: farm name, nearest town, district, GPS, or the farmer\'s own description'),
            how_to_find: str('Directions / landmarks to reach the place in the bush'),
            affected_count: str('How many animals are affected (number or "a few"/"many")'),
            dead_count: str('How many have died, if any'),
            onset: str('When it started and how fast it is spreading'),
            suspected_disease: str('A disease the farmer names or you reasonably infer (record, do not diagnose or alarm)'),
            recent_movement: str('Recent animal movement/contact: auctions, new stock, shared grazing'),
            identifying_traits: str('Markings, ear tags, breed -- anything to identify the animals'),
            access_notes: str('Access/travel notes: gate, road condition, 4x4 needed, permission'),
            farmer_available: str('Will the farmer be there on arrival? When are they reachable?'),
            contact_fallback: str('Who else to contact / another number if the farmer is unreachable'),
            photos: str('Note that the farmer sent a photo (set to a short description)'),
            audio: str('Note that the farmer sent a voice note (set to a short description or transcription)'),
            notes: str('Anything else worth recording for the organisers'),
          },
          required: ['id'],
        },
      },
      handler: async ({ id, ...fields }) => {
        const REPORT_KEYS = ['species', 'symptoms', 'location', 'how_to_find', 'affected_count',
          'dead_count', 'onset', 'suspected_disease', 'recent_movement', 'identifying_traits',
          'access_notes', 'farmer_available', 'contact_fallback', 'photos', 'audio', 'notes']
        const incoming = pick(fields, REPORT_KEYS)
        if (!Object.keys(incoming).length) return { error: 'no report fields supplied' }
        // Atomic read-merge-write in the store, under the per-conversation lock, so
        // two concurrent agent turns for the same case cannot read the same stale
        // report and clobber each other's fields. Later messages refine earlier
        // ones; a field already given is never lost.
        const res = await store().mergeReport(id, incoming, AGENT_USER)
        if (res.error === 'observe') return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
        if (res.error) return { error: res.error }
        await store().appendEvent(id, { kind: 'action', actor: 'agent', text: `recorded report fields: ${Object.keys(incoming).join(', ')}`, data: incoming })
        return { ok: true, report: res.report, fieldsRecorded: Object.keys(incoming) }
      },
    },
    {
      name: 'case_observe',
      toolset: 'cases',
      schema: {
        name: 'case_observe',
        description: 'Record an observation or internal note on the case timeline WITHOUT replying to the contact. Use for triage reasoning, flags, or anything an operator should see.',
        parameters: {
          type: 'object',
          properties: { id: str('Case id'), text: str('The observation') },
          required: ['id', 'text'],
        },
      },
      handler: async ({ id, text }) => {
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      },
    },
    {
      name: 'case_intent',
      toolset: 'cases',
      schema: {
        name: 'case_intent',
        description: 'Declare what the person\'s latest message IS, so casey routes it correctly. Call this when the message is NOT a fresh animal report -- e.g. they are asking about existing cases ("what is on today", "my cases", "any reports in <a town or province like Margate or KZN>"), asking how many reports are open ("how many open cases"), where the hotspots are ("which area has the most reports"), which outbreaks are suspected ("where are the outbreaks"), an overall picture ("how are we doing"), or what is overdue for a reply ("whats running late") -- as well as a general question or a greeting. casey lists the reports / answers the question itself; you do not need to. Leave report intake to your normal tools.',
        parameters: {
          type: 'object',
          properties: {
            id: str('Case id'),
            kind: str('What the message is', { enum: ['report', 'enquiry', 'question', 'chitchat', 'status', 'help', 'human', 'stop'] }),
            enquiry_kind: str('For an enquiry: which view', { enum: ['today', 'mine', 'open', 'near', 'count', 'geo', 'outbreaks', 'overview', 'overdue'] }),
            place: str('For a place enquiry: the town or province named (e.g. "Margate" or "kzn" / "Eastern Cape")'),
          },
          required: ['id', 'kind'],
        },
      },
      // The declaration is recorded as a durable, append-only observation. The gateway
      // reads the most recent INTENT-DECLARED marker for the current message and lets
      // it OVERRIDE the deterministic soft fallback -- so a capable model's reading of
      // an ambiguous message wins, while a weak model that says nothing still routes
      // via the fallback. Recording-only here keeps the tool side-effect-light and the
      // routing decision in one place (the gateway).
      handler: async ({ id, kind, enquiry_kind, place }) => {
        const payload = { kind, ...(enquiry_kind ? { enquiry_kind } : {}), ...(place ? { place } : {}) }
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: `INTENT-DECLARED ${JSON.stringify(payload)}`, data: payload })
        return { ok: true, intent: payload }
      },
    },
    {
      name: 'case_transition',
      toolset: 'cases',
      schema: {
        name: 'case_transition',
        description: 'Move the case to a new workflow stage. Valid targets depend on current stage (new->triaging->in_progress->waiting->resolved->closed, with reopen paths). Call case_get first if unsure. Honour the case autonomy setting.',
        parameters: {
          type: 'object',
          properties: {
            id: str('Case id'),
            to: str('Target stage', { enum: ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed'] }),
            reason: str('Why you are transitioning (recorded on the timeline)'),
          },
          required: ['id', 'to'],
        },
      },
      handler: async ({ id, to, reason = '' }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        if (c.autonomy === 'observe') return { error: 'case autonomy is "observe"; transitions are operator-only' }
        try {
          await store().transition(id, to, { user: AGENT_USER, reason })
          return { ok: true, from: c.status, to }
        } catch (e) {
          return { error: e.message }
        }
      },
    },
    {
      name: 'case_transitions_available',
      toolset: 'cases',
      schema: {
        name: 'case_transitions_available',
        description: 'List the workflow stages you are allowed to move this case to right now.',
        parameters: { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      },
      handler: async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const avail = store().availableTransitions(c, AGENT_USER)
        return { current: c.status, available: avail }
      },
    },
    {
      name: 'case_link_suggestions',
      toolset: 'cases',
      schema: {
        name: 'case_link_suggestions',
        description: 'Find OTHER open cases that look like the SAME real-world outbreak as this one -- same place, same animals, a shared contact or fallback number, reported around the same time. Use this to decide whether two reports should be one case. Returns ranked candidates with the reasons for each, strongest first. It only SUGGESTS; you decide whether to case_merge.',
        parameters: { type: 'object', properties: { id: str('Case id to find matches for'), limit: { type: 'number', default: 5 } }, required: ['id'] },
      },
      handler: async ({ id, limit = 5 }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const { suggestLinks } = await import('./correlate.js')
        // Scan a recent window of cases; exclude closed and already-merged ones --
        // suggesting a merge into a closed/merged shell would be noise.
        const pool = (await store().listCases({}, { limit: 200 }))
          .filter(o => o.id !== id && o.status !== 'closed'
            && !((o.tags || '').split(',').map(s => s.trim()).includes('merged')))
        const suggestions = suggestLinks(slimCase(c), pool.map(slimCase)).slice(0, limit)
        return { count: suggestions.length, suggestions }
      },
    },
    {
      name: 'case_merge',
      toolset: 'cases',
      schema: {
        name: 'case_merge',
        description: 'Fold one case (source) into another (target) when they are the SAME outbreak -- the target keeps the full combined report and timeline; the source becomes a redirect. Lossless and safe to retry. Use after case_link_suggestions confirms a real match. The TARGET is the case you keep.',
        parameters: {
          type: 'object',
          properties: {
            source: str('Case id to fold IN (becomes a redirect)'),
            target: str('Case id to keep (gathers everything)'),
            reason: str('Why these are the same outbreak (recorded on both timelines)'),
          },
          required: ['source', 'target'],
        },
      },
      handler: async ({ source, target, reason = '' }) => {
        const res = await store().mergeCases(source, target, AGENT_USER, { reason })
        if (res.error === 'observe') return { error: 'target case autonomy is "observe"; merging is operator-only' }
        if (res.error) return { error: res.error }
        return { ok: true, alreadyMerged: !!res.alreadyMerged, movedEvents: res.movedEvents, target: slimCase(res.target) }
      },
    },
    {
      name: 'case_split',
      toolset: 'cases',
      schema: {
        name: 'case_split',
        description: 'Carve a set of timeline events out of a case into a NEW case, when one thread actually holds TWO separate outbreaks (e.g. a contact reported a second, unrelated sick herd). The named events move to the new case; both are linked. Get event ids from case_get.',
        parameters: {
          type: 'object',
          properties: {
            id: str('Case id to split FROM'),
            event_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the events to move into the new case' },
            subject: str('Short title for the new case'),
            reason: str('Why these belong to a separate outbreak (recorded on both timelines)'),
          },
          required: ['id', 'event_ids'],
        },
      },
      handler: async ({ id, event_ids, subject = '', reason = '' }) => {
        const res = await store().splitCase(id, event_ids, { subject, reason }, AGENT_USER)
        if (res.error === 'observe') return { error: 'case autonomy is "observe"; splitting is operator-only' }
        if (res.error) return { error: res.error }
        return { ok: true, movedEvents: res.movedEvents, newCase: slimCase(res.newCase) }
      },
    },
    {
      name: 'case_health',
      toolset: 'cases',
      schema: {
        name: 'case_health',
        description: 'Check whether a case is going wrong over time -- stale (no activity), stuck in a stage too long, an unanswered request for a person, an abandoned intake with on-site facts still missing, or resolved-but-never-closed. Returns the current guardrail breaches with how long each has been true. Use it to decide what needs attention.',
        parameters: { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      },
      handler: async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const { classifyCaseHealth } = await import('./case-health.js')
        const breaches = classifyCaseHealth(c, Date.now())
        return { id, status: c.status, healthy: breaches.length === 0, breaches }
      },
    },
    // ---- worker-enquiry surface: answer FOR the asking worker (ctx.author), scoped
    // and PII-free (enquiryRow). ctx carries {author, principal, activeCaseRef} that
    // casey builds per turn in gateway-hooks; scoping is by the assignee owner field.
    {
      name: 'case_mine',
      toolset: 'cases',
      schema: { name: 'case_mine', description: "List the asking worker's OWN open cases (their itinerary). PII-free.", parameters: { type: 'object', properties: { limit: { type: 'number', default: 25 } } } },
      handler: async ({ limit = 25 }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        const rows = await store().listCases({ status: { $in: ['new', 'triaging', 'in_progress', 'waiting'] } }, { limit, user: ctx?.principal || (author ? { id: author, role: 'worker' } : null) })
        return { count: rows.length, cases: rows.map(enquiryRow) }
      },
    },
    {
      name: 'case_today',
      toolset: 'cases',
      schema: { name: 'case_today', description: "List cases active today for the asking worker (today's list). PII-free.", parameters: { type: 'object', properties: { limit: { type: 'number', default: 25 } } } },
      handler: async ({ limit = 25 }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        // Open cases the worker owns, most-recently-active first (the store sorts by
        // recency); "today" is the practical itinerary of what is live for them.
        const rows = await store().listCases({ status: { $in: ['new', 'triaging', 'in_progress', 'waiting'] } }, { limit, user: ctx?.principal || (author ? { id: author, role: 'worker' } : null) })
        return { count: rows.length, cases: rows.map(enquiryRow) }
      },
    },
    {
      name: 'case_new',
      toolset: 'cases',
      schema: { name: 'case_new', description: 'Open a NEW case for the worker and bind it active. Use ONLY when the worker is clearly starting a fresh report (a different animal/place/incident), never to auto-open one.', parameters: { type: 'object', properties: { subject: str('Optional short subject') } } },
      handler: async ({ subject }, ctx) => {
        const author = ctx?.author || ctx?.principal?.id
        if (!store().createCase) return { error: 'store does not support explicit case creation' }
        const c = await store().createCase({ subject: subject || '', assignee: author || 'agent', channel: ctx?.channel || 'enquiry' })
        if (store().setActiveCase && author) await store().setActiveCase(author, c.id)
        await store().appendEvent(c.id, { kind: 'note', actor: 'system', text: `case explicitly opened for a fresh report by ${author || 'unknown'}` })
        return { ok: true, activeCase: enquiryRow(c) }
      },
    },
    {
      name: 'case_stop',
      toolset: 'cases',
      schema: { name: 'case_stop', description: 'The person asked to STOP receiving messages (opt out). Records the opt-out. Use ONLY on a clear opt-out.', parameters: { type: 'object', properties: { id: str('Case id') }, required: ['id'] } },
      handler: async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const tags = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        if (!tags.includes('opted-out')) tags.push('opted-out')
        await store().updateCase(id, { tags: tags.join(',') })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'OPT-OUT: the person asked to stop; no more automatic replies.' })
        return { ok: true }
      },
    },
    {
      name: 'case_handoff',
      toolset: 'cases',
      schema: { name: 'case_handoff', description: 'The person wants a real person / operator to help. Flags the case for a human. Use on a clear ask for a person.', parameters: { type: 'object', properties: { id: str('Case id') }, required: ['id'] } },
      handler: async ({ id }) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        const tags = String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        if (!tags.includes('needs-human')) tags.push('needs-human')
        await store().updateCase(id, { tags: tags.join(',') })
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text: 'HANDOFF REQUESTED: the person asked for a real person.' })
        return { ok: true }
      },
    },
  ]
  return tools
}

function slimCase(c) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, report, tags, assignee, autonomy, last_event_at } = c
  // Parse the report so the agent reads it as structured fields (and knows which
  // it already has, so it never re-asks). Tolerate a malformed/empty report.
  let reportObj = null
  try { reportObj = report ? JSON.parse(report) : null } catch { reportObj = null }
  return { id, ref, channel, status, priority, subject, summary, report: reportObj, tags, assignee, autonomy, last_event_at }
}
// PII-FREE projection for a LIST row (an enquiry spanning cases the asker may not
// own). Keeps only ref/status/species/location -- NEVER the full report object, which
// carries owner_name/contact_fallback/present_person and other contact-supplied free
// text that must not reach the model context (and thence a reply) for a case the
// worker does not own. species/location are flattened out of the report so a place/
// species list still reads naturally without exposing the rest.
function enquiryRow(c) {
  if (!c) return null
  let report = {}
  try { report = c.report ? JSON.parse(c.report) : {} } catch { report = {} }
  return {
    id: c.id, ref: c.ref, status: c.status, priority: c.priority,
    species: report.species || null, location: report.location || null,
    assignee: c.assignee || null, last_event_at: c.last_event_at,
  }
}
function slimEvent(e) {
  return { kind: e.kind, actor: e.actor, text: e.text, at: e.created_at }
}
function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '' && String(obj[k]).trim() !== '') out[k] = obj[k]
  return out
}
