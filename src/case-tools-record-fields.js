

import { AGENT_USER } from './case-store.js'
import { defTool, str, pick, ownsCase, slimCase } from './case-tools-shared.js'
import { isContactAssignee } from './case-assignment.js'
import { canQueryCases, isOperator } from './contact-tiers.js'
import { caseyText } from './deployment-text.js';

export function buildCaseFieldTools(store, { caseTypeValues, priorityValues }) {
  return [
    defTool('case_update', 'cases',
      caseyText("src/case-tools-record-fields.js#0"),
      {
        type: 'object',
        properties: {
          id: str(caseyText("src/case-tools-record-fields.js#s0")),
          subject: str(caseyText("src/case-tools-record-fields.js#s1")),
          summary: str(caseyText("src/case-tools-record-fields.js#1")),
          priority: str('Priority', { enum: priorityValues }),
          assignee: str(caseyText("src/case-tools-record-fields.js#s2")),
          case_type: str(caseyText("src/case-tools-record-fields.js#2"), { enum: caseTypeValues }),
        },
        required: ['id'],
      },
      async ({ id, ...patch }, ctx) => {
        const bad = validateEnumFields(store, patch, { caseTypeValues, priorityValues })
        if (bad) return bad
        const clean = pick(patch, ['subject', 'summary', 'priority', 'assignee', 'case_type'])
        if (!Object.keys(clean).length) return { error: caseyText("src/case-tools-record-fields.js#s3") }

        if (isContactAssignee(clean.assignee)) return { error: caseyText("src/case-tools-record-fields.js#s4") }
        const c = await store().getCase(id)
        if (!c) return { error: caseyText("src/case-tools-record-fields.js#s5", [id]) }

        const author = ctx?.author || ctx?.principal?.id
        if (!ownsCase(c.external_id, author) && !canQueryCases(ctx?.tier)) {
          return { error: caseyText("src/case-tools-record-fields.js#3", [id]) }
        }
        if (clean.assignee !== undefined && !ownsCase(c.external_id, author) && !isOperator(ctx?.tier)) {
          return { error: caseyText("src/case-tools-record-fields.js#4") }
        }

        const result = await store().updateCaseChecked(id, clean, AGENT_USER)
        if (result.error === 'observe') {
          return { error: caseyText("src/case-tools-record-fields.js#5") }
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
    return { error: caseyText("src/case-tools-record-fields.js#s6", [patch.case_type]), allowed: [...caseTypeValueSet] }
  }
  if ('priority' in patch && !priorityValueSet.has(patch.priority)) {
    return { error: caseyText("src/case-tools-record-fields.js#s7", [patch.priority]), allowed: [...priorityValueSet] }
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
