

import { tagList, parseReport } from './timestamp.js'
import { MANDATORY_MINIMUM_BLOCKED_STATUSES, missingMandatoryMinimum, fieldLabel, SIGNOFF_DIAGNOSIS_FIELDS } from './store/report-shape.js'
import { mergeTag, dropTag } from './hooks/heuristics.js'

export const HANDED_OFF_TAG = 'handed-off'
const UNCLAIMED = 'agent'
const DONE = new Set(['resolved', 'closed', ...MANDATORY_MINIMUM_BLOCKED_STATUSES])

export const isDone = (c) => DONE.has(String(c?.status || ''))
export function reopenedWithoutDiagnosis(c, toState) {
  if (!isDone(c) || isDone({ status: toState })) return null
  const report = parseReport(c)
  const previous = {}
  for (const k of SIGNOFF_DIAGNOSIS_FIELDS) {
    if (report[k] == null || String(report[k]).trim() === '') continue
    previous[k] = report[k]
    delete report[k]
  }
  return Object.keys(previous).length ? { report, previous } : null
}

export const isHandedOff = (c) => tagList(c).includes(HANDED_OFF_TAG)
export const isUnheld = (c) => { const a = String(c?.assignee || '').trim(); return !a || a === UNCLAIMED }

export function inSignOffQueue(c, unclaimedKey = UNCLAIMED) {
  if (!c || isDone(c)) return false
  if (missingMandatoryMinimum(parseReport(c)).length) return false
  if (isHandedOff(c)) return true
  const a = String(c.assignee || '').trim()
  return !a || a === unclaimedKey
}

export async function handoffToTechnician(store, caseId, { by = 'a team member', user, data = {}, note = '' } = {}) {
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c || c.channel === 'system') return { ok: false, code: 'not_found', error: 'No such report.' }
    if (isDone(c)) return { ok: false, code: 'finished', error: 'That report is already finished, so there is nothing to hand over.' }
    const missing = missingMandatoryMinimum(parseReport(c))
    if (missing.length) {
      return { ok: false, code: 'missing_minimum', missing, error: `Not ready to hand over: ${missing.map(fieldLabel).join(', ')} ${missing.length === 1 ? 'is' : 'are'} still not written down. Add ${missing.length === 1 ? 'it' : 'them'} first.` }
    }
    if (isHandedOff(c)) return { ok: true, already: true, ref: c.ref }
    await store.updateCase(c.id, { tags: mergeTag(c.tags || '', HANDED_OFF_TAG) }, user)
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `HANDED TO THE SIGN-OFF DESK by ${by}${note ? `: ${String(note).slice(0, 400)}` : ''}`,
      data: { ...data, by, handed_off: true },
    })
    return { ok: true, ref: c.ref }
  })
}

export async function withdrawHandoff(store, caseId, { by = 'a team member', user, reason = '', data = {} } = {}) {
  return store._withLock(`assign|${caseId}`, async () => {
    const c = await store.getCase(caseId)
    if (!c) return { ok: false, code: 'not_found', error: 'No such report.' }
    if (!isHandedOff(c)) return { ok: true, was: false, ref: c.ref }
    await store.updateCase(c.id, { tags: dropTag(c.tags || '', HANDED_OFF_TAG) }, user)
    await store.appendEvent(c.id, {
      kind: 'action', actor: 'operator',
      text: `HAND-OVER WITHDRAWN by ${by}${reason ? `: ${String(reason).slice(0, 400)}` : ''}`,
      data: { ...data, by, handoff_withdrawn: true },
    })
    return { ok: true, was: true, ref: c.ref }
  })
}

export async function sendBackToRanger(store, caseId, { by = 'a team member', user, text = '', missing = [], data = {} } = {}) {
  const c = await store.getCase(caseId)
  if (!c || c.channel === 'system') return { ok: false, error: 'No such report.' }
  const tags = tagList(c)
  if (!tags.includes('sent-back')) await store.updateCase(c.id, { tags: mergeTag(c.tags || '', 'sent-back') }, user)
  const line = `Sent back by ${by}${missing.length ? `: still needed -- ${missing.join(', ')}` : ''}${String(text).trim() ? `. ${String(text).trim()}` : ''}`
  await store.appendEvent(c.id, { kind: 'note', actor: 'operator', text: line, data: { ...data, by: data.by || by, sent_back: true, missing } })
  await withdrawHandoff(store, c.id, { by, user, reason: 'sent back' })
  return { ok: true, ref: c.ref }
}
