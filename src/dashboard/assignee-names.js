import { isContactAssignee, contactIdOfAssignee, assigneeKeyFor } from '../case-assignment.js'
import { staffLabel } from '../hooks/staff-outbound.js'
import { caseyText } from '../deployment-text.js';

export async function assigneeNamer(store, rows, pick = (r) => r?.assignee, { logins = false } = {}) {
  const ids = new Set()
  const wanted = new Set()
  for (const r of rows || []) {
    const v = String(pick(r) || '').trim()
    const id = contactIdOfAssignee(v)
    if (id) ids.add(id)
    else if (v && v !== 'agent') wanted.add(v)
  }
  const loginNames = new Map()
  if (logins && wanted.size) {
    const accts = await store.t.list('operator_account', {}, { limit: 500 }).catch(() => [])
    for (const a of accts) if (a?.username && wanted.has(a.username)) loginNames.set(a.username, String(a.display_name || '').trim() || a.username)
  }
  const names = new Map()
  await Promise.all([...ids].map(async (id) => {
    const contact = await store.getContact(id).catch(() => null)
    names.set(id, contact ? staffLabel(contact) : caseyText("src/dashboard/assignee-names.js#w0"))
  }))
  const name = (value) => {
    const v = String(value ?? '').trim()
    if (!isContactAssignee(v)) return loginNames.get(v) ?? value ?? ''
    return names.get(contactIdOfAssignee(v)) || caseyText("src/dashboard/assignee-names.js#w1")
  }
  name.rosterEntries = () => [...names].map(([id, n]) => ({ id: assigneeKeyFor({ id }), name: n }))
  return name
}

const ASSIGNEE_DATA_KEYS = ['assignee', 'claimed_by', 'was']

const CONTACT_KEYS = ['assigned_contact_id', 'staff_contact_id', 'dispatch_worker_id', 'dispatch_response_by', 'announced_to']

export async function nameEventAssignees(store, events, { field = false } = {}) {
  const vals = []
  for (const e of events || []) for (const k of ASSIGNEE_DATA_KEYS) vals.push(e?.data?.[k])
  const name = await assigneeNamer(store, vals, (v) => v, { logins: field })
  return (events || []).map((e) => {
    const d = e?.data
    if (!d || typeof d !== 'object') return e
    const out = { ...d }
    for (const k of ASSIGNEE_DATA_KEYS) if (typeof out[k] === 'string') out[k] = name(out[k])
    for (const k of CONTACT_KEYS) delete out[k]
    if (field) delete out.to
    return { ...e, data: out }
  })
}
