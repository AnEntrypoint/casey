// assignee-names.js  --  render a stored assignee for a person to read.
//
// `case.assignee` holds either an operator username, the unclaimed marker, or
// an opaque `contact:<id>` key (case-assignment.js). The key is storage, not
// display: every dashboard payload that SHOWS an assignee (lists, workload,
// handover, health, csv) passes the value through a namer built here, once per
// request, so a WhatsApp team member appears by name and neither the key nor
// their phone number is sent for display. One store lookup per distinct
// contact, never one per row.

import { isContactAssignee, contactIdOfAssignee, assigneeKeyFor } from '../case-assignment.js'
import { staffLabel } from '../hooks/staff-outbound.js'

// rows: any array; pick(row) returns the assignee value to resolve.
// { logins: true } also renders a dashboard login (a ranger or technician who works in
// the GUI) by the display name on its account, from ONE account listing per namer;
// without it a login passes through unchanged, because the staff screens compare it.
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
    names.set(id, contact ? staffLabel(contact) : 'a team member')
  }))
  const name = (value) => {
    const v = String(value ?? '').trim()
    if (!isContactAssignee(v)) return loginNames.get(v) ?? value ?? ''
    return names.get(contactIdOfAssignee(v)) || 'a team member'
  }
  // Roster entries ({id,name}) for every contact key held in `rows`, so a
  // rollup keyed by assignee can label them without inventing a card per contact.
  name.rosterEntries = () => [...names].map(([id, n]) => ({ id: assigneeKeyFor({ id }), name: n }))
  return name
}

const ASSIGNEE_DATA_KEYS = ['assignee', 'claimed_by', 'was']

// Timeline rows carry the key in event.data (edited assignee / claimed by);
// name it for the client and drop the raw contact id used for staff notices.
// Internal join keys that have no display use: never sent, for any login. A field
// login additionally never receives `to` (the reporter's raw routing number on an
// outbound row): the number is shown only on a case it works, through its audited reveal.
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
