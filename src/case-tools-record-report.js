import { AREA_FIELD } from './store/report-shape.js'


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
import { caseyText } from './deployment-text.js';

const OBSERVE_BLOCKED = { error: caseyText("src/case-tools-record-report.js#0") }

export function buildCaseReportTools(store) {
  return [
    defTool(REPORT_TOOL_NAME, 'cases',
      REPORT_TOOL_DESCRIPTION,
      {
        type: 'object',
        properties: {
          id: str(caseyText("src/case-tools-record-report.js#s0")),
          ...Object.fromEntries(REPORTER_FIELD_DEFS.filter(f => !SYSTEM_SET_FIELDS.has(f.key)).map(f => [f.key, str(f.description)])),
        },
        required: ['id'],
      },
      async ({ id, ...fields }, ctx) => {

        if (consentManaged() && ctx?.contact?.id && !canQueryCases(ctx?.tier)) {
          const state = await consentState(store(), ctx.contact.id, { caseId: boundCase(ctx).id })
          if (state !== 'agreed') return { held: true, nothing_recorded: true, note: state === 'declined'
            ? caseyText("src/case-tools-record-report.js#1")
            : caseyText("src/case-tools-record-report.js#2") }
        }

        const notDiagnosis = SIGNOFF_DIAGNOSIS_FIELDS.filter(k => k in fields)
        for (const k of notDiagnosis) delete fields[k]

        if (ctx?.contact?.id && !canQueryCases(ctx?.tier)) { const held = await returnGate(store(), ctx); if (held) return held }
        const elsewhere = await namesHeldRecord(store, ctx)
        if (elsewhere) return { error: caseyText("src/case-tools-record-report.js#3", [elsewhere, elsewhere]) }
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
        return { ok: true, report: res.report, fieldsRecorded: Object.keys(incoming), ...(notDiagnosis.length ? { notRecorded: caseyText("src/case-tools-record-report.js#4", [notDiagnosis.join(', ')]) } : {}), ...(locationDropped ? { locationNotRecorded: areaAskNote() } : {}), ...(res.cappedFields?.length ? { cappedFields: res.cappedFields } : {}) }
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
      text: caseyText("src/case-tools-record-report.js#5", [id, bound.id || '(none)']),
      data: { attemptedId: id, activeCaseId: bound.id, tool: 'case_report' },
    })
  } catch {  }
  return { error: bound.id
    ? caseyText("src/case-tools-record-report.js#6", [bound.ref || bound.id, id])
    : caseyText("src/case-tools-record-report.js#7") }
}

async function validateReportArgs(store, fields) {
  const incoming = pick(fields, [...REPORTER_KEYS])
  if (!Object.keys(incoming).length) return { error: caseyText("src/case-tools-record-report.js#s1") }
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
  return caseyText("src/case-tools-record-report.js#8", [loadDomainConfig().persona.areaQuestion])
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
        text: caseyText("src/case-tools-record-report.js#9"),
      })
    } catch {  }
  }
  if (res.cappedFields?.length) {
    try {
      await store().appendEvent(id, {
        kind: 'observation', actor: 'system',
        text: caseyText("src/case-tools-record-report.js#10", [res.cappedFields.join(', ')]),
        data: { cappedFields: res.cappedFields },
      })
    } catch {  }
  }
  return { res, priorReport: res.priorReport || {} }
}

async function assignByArea(store, id, incoming) {
  if (!('location' in incoming) && !(AREA_FIELD in incoming)) return
  try { const { autoAssignByArea } = await import('./areas.js'); await autoAssignByArea(store(), id) } catch (e) { store().log?.warn?.(caseyText("src/case-tools-record-report.js#s2"), { caseId: id, error: e.message }) }
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
    ? caseyText("src/case-tools-record-report.js#s3", [fieldsRecorded.join(', '), corrections.join(', ')])
    : caseyText("src/case-tools-record-report.js#s4", [fieldsRecorded.join(', ')])
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
