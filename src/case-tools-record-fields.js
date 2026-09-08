// case-tools-record-fields.js  --  the write tool that edits a case's own
// editable COLUMNS (subject, summary, priority, assignee, autonomy, case_type),
// as opposed to the report blob (case-tools-record-report.js) or the timeline
// (case-tools-record-timeline.js).
//
// Split out of case-tools-record.js verbatim -- name, description, parameter
// schema and handler body are unchanged. Composed back in order by
// case-tools-record.js's buildRecordTools, which is still the only thing
// case-tools.js knows about.

import { AGENT_USER } from './case-store.js'
import { defTool, str, pick, ownsCase, slimCase } from './case-tools-shared.js'

export function buildCaseFieldTools(store, { caseTypeValues, priorityValues }) {
  return [
    defTool('case_update', 'cases',
      'Update editable case fields (subject, summary, priority, assignee, autonomy, case_type). Keep `summary` current -- it is your working memory of the case. You may set `case_type` ONLY when the worker or farmer directly and explicitly said which category applies (e.g. they used the word "outbreak", named a lab sample/test, or said the animals were recently moved/imported) -- never from your own inference about severity, onset speed, or whether a disease is notifiable. This is recording a stated fact, not diagnosing or triaging; a technician makes that call. Leave it unset whenever the category was not explicitly stated -- unset is correct and expected far more often than not.',
      {
        type: 'object',
        properties: {
          id: str('Case id'),
          subject: str('Short human title'),
          summary: str('One-paragraph rolling summary of the case state'),
          priority: str('Priority', { enum: priorityValues }),
          assignee: str('Operator handle, or "agent"'),
          case_type: str('Category, set ONLY when directly and explicitly stated by the worker/farmer -- never inferred from severity or symptoms. Leave unset when not explicitly stated.', { enum: caseTypeValues }),
        },
        required: ['id'],
      },
      async ({ id, ...patch }, ctx) => {
        const bad = validateEnumFields(store, patch, { caseTypeValues, priorityValues })
        if (bad) return bad
        const clean = pick(patch, ['subject', 'summary', 'priority', 'assignee', 'case_type'])
        if (!Object.keys(clean).length) return { error: 'no editable fields supplied' }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // A field_worker may learn another case's id via case_list/case_mine
        // (PII-free rows still carry `id`) -- ownership must be checked here too,
        // same gate case_get/case_switch already apply, or any worker could edit
        // a stranger's case (priority/assignee/case_type/subject/summary).
        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author)) {
          return { error: `case ${id} does not belong to you -- cannot update it` }
        }
        // Autonomy is operator control: it is set only from the dashboard, never by
        // the agent -- otherwise the agent could flip observe back to auto and
        // escape the very mode an operator used to stop it acting. So in observe
        // mode the agent may only observe; all content edits are blocked. Routed
        // through updateCaseChecked (re-reads autonomy INSIDE the per-conversation
        // lock, same discipline as mergeReport) rather than this outer read-then-
        // write, so an operator's dashboard observe-mode flip landing between this
        // handler's own read and its write cannot be raced.
        const result = await store().updateCaseChecked(id, clean, AGENT_USER)
        if (result.error === 'observe') {
          return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
        }
        if (result.error) return result
        await auditFieldUpdate(store, id, clean, result.prior)
        return { ok: true, case: slimCase(result.case) }
      }),
  ]
}

// Validate case_type/priority BEFORE pick()'s empty-string filtering: an
// explicit case_type:"" must be rejected the same way a bogus value is, not
// silently dropped as if the field were never supplied -- pick() would
// otherwise treat an empty-string write as a no-op, which looks like the
// update succeeded to a caller who doesn't check fieldsRecorded.
// Live config-declared enum (falling back to the same hint the model was
// shown, when the config leaves case_type/priority undeclared), so a
// deployment's own thatcher.config.yml options are the ones actually enforced,
// not a second hardcoded copy of the list. Hint and enforcement read the SAME
// store, so the model can no longer be offered a value this check would reject.
function validateEnumFields(store, patch, { caseTypeValues, priorityValues }) {
  const caseTypeValueSet = new Set(store().getFieldEnum('case.case_type', caseTypeValues))
  const priorityValueSet = new Set(store().getFieldEnum('case.priority', priorityValues))
  if ('case_type' in patch && !caseTypeValueSet.has(patch.case_type)) {
    return { error: `invalid case_type: ${patch.case_type}`, allowed: [...caseTypeValueSet] }
  }
  if ('priority' in patch && !priorityValueSet.has(patch.priority)) {
    return { error: `invalid priority: ${patch.priority}`, allowed: [...priorityValueSet] }
  }
  return null
}

// A case_type change is audited as its own from/to action, matching the
// dashboard's own reclassification event shape, so /api/report.json's per-type
// analytics can trace an agent-driven reclassification the same way as an
// operator one. Every other field lands in one combined "updated ..." event.
async function auditFieldUpdate(store, id, clean, prior) {
  const caseTypeChanged = 'case_type' in clean && (prior.case_type || 'unset') !== clean.case_type
  if (caseTypeChanged) {
    await store().appendEvent(id, {
      kind: 'action', actor: 'agent',
      text: `case_type ${prior.case_type || 'unset'} -> ${clean.case_type}`,
      data: { from: prior.case_type || 'unset', to: clean.case_type, field: 'case_type' },
    })
  }
  const otherKeys = Object.keys(clean).filter(k => k !== 'case_type')
  if (otherKeys.length) {
    await store().appendEvent(id, { kind: 'action', actor: 'agent', text: `updated ${otherKeys.join(', ')}`, data: Object.fromEntries(otherKeys.map(k => [k, clean[k]])) })
  }
}
