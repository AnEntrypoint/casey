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
        return { case: c, events: events.map(slimEvent) }
      },
    },
    {
      name: 'case_list',
      toolset: 'cases',
      schema: {
        name: 'case_list',
        description: 'List cases, optionally filtered by status/channel/assignee. Returns most-recently-active first.',
        parameters: {
          type: 'object',
          properties: {
            status: str('Filter by workflow status', { enum: ['new', 'triaging', 'in_progress', 'waiting', 'resolved', 'closed'] }),
            channel: str('Filter by channel'),
            assignee: str('Filter by assignee'),
            limit: { type: 'number', default: 25 },
          },
        },
      },
      handler: async ({ status, channel, assignee, limit = 25 }) => {
        const where = {}
        if (status) where.status = status
        if (channel) where.channel = channel
        if (assignee) where.assignee = assignee
        const rows = await store().listCases(where, { limit })
        return { count: rows.length, cases: rows.map(slimCase) }
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
            autonomy: str('Autonomy level', { enum: ['auto', 'assisted', 'observe'] }),
          },
          required: ['id'],
        },
      },
      handler: async ({ id, ...patch }) => {
        const clean = pick(patch, ['subject', 'summary', 'priority', 'tags', 'assignee', 'autonomy'])
        if (!Object.keys(clean).length) return { error: 'no editable fields supplied' }
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // In observe mode the agent may only observe; the sole allowed change is
        // an operator/agent raising autonomy back up (never the agent editing
        // case content). Block content edits.
        if (c.autonomy === 'observe') {
          const editsContent = Object.keys(clean).some(k => k !== 'autonomy')
          if (editsContent) return { error: 'case autonomy is "observe"; agent edits are disabled. Use case_observe to record notes.' }
        }
        const updated = await store().updateCase(id, clean, AGENT_USER)
        await store().appendEvent(id, { kind: 'action', actor: 'agent', text: `updated ${Object.keys(clean).join(', ')}`, data: clean })
        return { ok: true, case: slimCase(updated) }
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
  ]
  return tools
}

function slimCase(c) {
  if (!c) return null
  const { id, ref, channel, status, priority, subject, summary, tags, assignee, autonomy, last_event_at } = c
  return { id, ref, channel, status, priority, subject, summary, tags, assignee, autonomy, last_event_at }
}
function slimEvent(e) {
  return { kind: e.kind, actor: e.actor, text: e.text, at: e.created_at }
}
function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') out[k] = obj[k]
  return out
}
