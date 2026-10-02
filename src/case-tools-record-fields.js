

import { AGENT_USER } from './case-store.js'
import { defTool, str, pick, ownsCase, slimCase } from './case-tools-shared.js'
import { isContactAssignee } from './case-assignment.js'
import { canQueryCases, isOperator } from './contact-tiers.js'

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

        if (isContactAssignee(clean.assignee)) return { error: 'that assignee cannot be set here' }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }

        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: `case ${id} does not belong to you -- cannot update it` }
        }
        if (clean.assignee !== undefined && !ownsCase(c.external_id, author) && !isOperator(ctx?.tier)) {
          return { error: 'Who holds a record is not changed from here -- ask an operator to assign it. Nothing was changed.' }
        }

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
