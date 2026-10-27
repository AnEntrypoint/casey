

import { AGENT_USER } from './case-store.js'
import { REPORTER_FIELD_DEFS, REPORTER_KEYS, REPORT_TOOL_NAME, REPORT_TOOL_DESCRIPTION, SIGNOFF_DIAGNOSIS_FIELDS, SYSTEM_SET_FIELDS } from './store/report-shape.js'
import { normalizeLocation } from './location-normalize.js'
import { recordProvenanceObservation } from './provenance-wire.js'
import { defTool, str, pick, boundCase } from './case-tools-shared.js'
import { findCase, deskAuthorityOn, claimSelfFiledReport } from './case-tools-team-shared.js'
import { canQueryCases } from './contact-tiers.js'
import { stampReporter } from './phone-persons.js'
import { consentManaged, consentState } from './phone-consent.js'
import { returnGate } from './return-clarify.js'
import { loadDomainConfig } from './config-loader.js'

const OBSERVE_BLOCKED = { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }

export function buildCaseReportTools(store) {
  return [
    defTool(REPORT_TOOL_NAME, 'cases',
      REPORT_TOOL_DESCRIPTION,
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          ...Object.fromEntries(REPORTER_FIELD_DEFS.filter(f => !SYSTEM_SET_FIELDS.has(f.key)).map(f => [f.key, str(f.description)])),
        },
        required: ['id'],
      },
      async ({ id, ...fields }, ctx) => {

        if (consentManaged() && ctx?.contact?.id && !canQueryCases(ctx?.tier)) {
          const state = await consentState(store(), ctx.contact.id, { caseId: boundCase(ctx).id })
          if (state !== 'agreed') return { held: true, nothing_recorded: true, note: state === 'declined'
            ? 'This person said no to what is kept, so nothing is written down. Do not record this. Be kind, offer a person from the team (case_handoff) if they want help, and only if they change their mind and say yes call case_consent with agreed true.'
            : 'Nothing was recorded, so never say or imply that anything was noted or saved. This phone has not said it is okay for the team to keep what they send. In THIS reply, in your own words, tell them briefly what is kept and ask if that is okay (this is your one question). Do not say you are recording or that you need permission: just talk to them. When they say yes, call case_consent with agreed true and then record everything they have told you in this chat.' }
        }

        const notDiagnosis = SIGNOFF_DIAGNOSIS_FIELDS.filter(k => k in fields)
        for (const k of notDiagnosis) delete fields[k]

        if (ctx?.contact?.id && !canQueryCases(ctx?.tier)) { const held = await returnGate(store(), ctx); if (held) return held }
        const elsewhere = await namesHeldRecord(store, ctx)
        if (elsewhere) return { error: `This message is about ${elsewhere}, a record held by this team member, not about their own report. Nothing was recorded on their own report. Say which record it is (${elsewhere}), ask them to confirm it in their next message, then use case_focus and case_edit for it.` }
        const target = await resolveReportTarget(store, id, ctx)
        if (target.error) return { error: target.error }
        id = target.id
        const args = await validateReportArgs(store, fields)
        if (args.error) return { error: args.error }
        const { incoming, locationDropped } = args
        if (locationDropped && !Object.keys(incoming).length) return { ok: true, nothing_recorded: true, locationNotRecorded: areaAskNote() }

        const merged = await mergeIncomingReport(store, id, incoming)
        if (merged.error) return { error: merged.error }
        const { res, priorReport } = merged

        if (ctx?.contact?.id && !canQueryCases(ctx?.tier)) { try { await stampReporter(store(), ctx.contact.id, id) } catch {  } }
        await claimSelfFiledReport(store(), ctx, id)

        await syncDerivedLocation(store, id, incoming)
        await assignByArea(store, id, incoming)
        await auditReportWrite(store, id, { incoming, priorReport })
        await wireProvenance(store, ctx, id, { incoming, res })
        return { ok: true, report: res.report, fieldsRecorded: Object.keys(incoming), ...(notDiagnosis.length ? { notRecorded: `${notDiagnosis.join(', ')} -- only the animal health technician records these, when signing off; say nothing about it` } : {}), ...(locationDropped ? { locationNotRecorded: areaAskNote() } : {}), ...(res.cappedFields?.length ? { cappedFields: res.cappedFields } : {}) }
      }),
  ]
}

async function namesHeldRecord(store, ctx) {
  const named = ctx?.inboundRefs || []
  if (!named.length || !ctx?.contact) return null
  const own = String(boundCase(ctx).ref || '').toUpperCase()
  for (const ref of named) {
    if (ref === own) continue
    const c = await findCase(store(), ref)
    if (c && deskAuthorityOn(ctx, c)) return c.ref
  }
  return null
}

async function namesARecord(store, id) {
  const key = String(id ?? '').trim()
  if (!key) return false
  try {
    if (await store().getCase(key)) return true
    return !!(typeof store().getCaseByRef === 'function' && await store().getCaseByRef(key))
  } catch { return true }
}

async function resolveReportTarget(store, id, ctx) {
  const bound = boundCase(ctx)
  if (bound.id && (id === bound.id || id === bound.ref)) return { id: bound.id }

  if (bound.id && (ctx?.activeCaseBinding?.left?.has(id) || !(await namesARecord(store, id)))) return { id: bound.id }
  try {
    const logTarget = bound.id || id
    await store().appendEvent(logTarget, {
      kind: 'observation', actor: 'system',
      text: `SECURITY: case_report called with id=${id} but this turn's active case is ${bound.id || '(none)'}; write rejected.`,
      data: { attemptedId: id, activeCaseId: bound.id, tool: 'case_report' },
    })
  } catch {  }
  return { error: bound.id
    ? `case_report must target this conversation's active case (${bound.ref || bound.id}), not ${id}`
    : 'case_report has no bound active case on this turn -- cannot target an arbitrary case id' }
}

async function validateReportArgs(store, fields) {
  const incoming = pick(fields, [...REPORTER_KEYS])
  if (!Object.keys(incoming).length) return { error: 'no report fields supplied' }
  let locationDropped = false
  if (typeof incoming.location === 'string') {
    const { generalAreaFor } = await import('./areas.js')
    const area = await generalAreaFor(store(), incoming.location)
    locationDropped = !area
    if (area) incoming.location = area
    else delete incoming.location
  }
  return { incoming, locationDropped }
}

function areaAskNote() {
  return `The place was not a known area, so it was not recorded. Ask, in their language: "${loadDomainConfig().persona.areaQuestion}"`
}

async function mergeIncomingReport(store, id, incoming) {
  if (!Object.keys(incoming).length) return { res: { report: null }, priorReport: {} }
  const res = await store().mergeReport(id, incoming, AGENT_USER)
  if (res.error === 'observe') return { error: OBSERVE_BLOCKED.error }
  if (res.error) return { error: res.error }
  if (res.reportWasCorrupted) {
    try {
      await store().appendEvent(id, {
        kind: 'observation', actor: 'system',
        text: 'WARNING: this case\'s stored report JSON was corrupted and has been reset before merging in this turn\'s fields -- some previously recorded fields may be lost. Review the case history for what was said before this point.',
      })
    } catch {  }
  }
  if (res.cappedFields?.length) {
    try {
      await store().appendEvent(id, {
        kind: 'observation', actor: 'system',
        text: `WARNING: field(s) ${res.cappedFields.join(', ')} reached their maximum accumulated length -- this turn's new note(s) were NOT attached. A human should review the case for a length reset.`,
        data: { cappedFields: res.cappedFields },
      })
    } catch {  }
  }
  return { res, priorReport: res.priorReport || {} }
}

async function assignByArea(store, id, incoming) {
  if (!('location' in incoming) && !('association' in incoming)) return
  try { const { autoAssignByArea } = await import('./areas.js'); await autoAssignByArea(store(), id) } catch (e) { store().log?.warn?.('[casey] area auto-assign failed', { caseId: id, error: e.message }) }
}

async function syncDerivedLocation(store, id, incoming) {
  if (!('location' in incoming) || typeof store().systemUpdateDerived !== 'function') return
  try { await store().systemUpdateDerived(id, { normalized_location: normalizeLocation(incoming.location) }) }
  catch {  }
}

async function auditReportWrite(store, id, { incoming, priorReport }) {
  const fieldsRecorded = Object.keys(incoming)
  const corrections = Object.keys(incoming)
    .filter(k => k !== 'photos' && k !== 'audio' && k !== 'sites')
    .filter(k => priorReport[k] != null && String(priorReport[k]).trim() !== '' && String(priorReport[k]) !== String(incoming[k]))
    .map(k => `${k} ${priorReport[k]} -> ${incoming[k]}`)
  const text = corrections.length
    ? `recorded report fields: ${fieldsRecorded.join(', ')}; changed: ${corrections.join(', ')}`
    : `recorded report fields: ${fieldsRecorded.join(', ')}`
  await store().appendEvent(id, { kind: 'action', actor: 'agent', text, data: { ...incoming, ...(corrections.length ? { corrections } : {}) } })
}

async function wireProvenance(store, ctx, id, { incoming, res }) {
  try {
    const dataDir = store().dataDir
    const provenanceIncoming = res.cappedFields?.length
      ? Object.fromEntries(Object.entries(incoming).filter(([k]) => !res.cappedFields.includes(k)))
      : incoming
    if (dataDir) await recordProvenanceObservation({ dataDir, caseId: id, author: ctx?.author, incoming: provenanceIncoming })
  } catch {  }
}
