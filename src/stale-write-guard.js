import crypto from 'node:crypto'
import { parseReport } from './timestamp.js'
import { evData } from './safe.js'
import { fieldLabel } from './store/report-shape.js'
import { assigneeNamer } from './dashboard/assignee-names.js'
import { findCase, deskAuthorityOn } from './case-tools-team-shared.js'
import { canQueryCases } from './contact-tiers.js'

const SEEN_CAP = 40
const COLUMN_LABELS = { 'col.subject': 'title', 'col.summary': 'summary', 'col.priority': 'priority', 'col.status': 'stage', 'col.position': 'map position' }
const digest = (v) => crypto.createHash('sha1').update(String(v ?? '')).digest('hex').slice(0, 10)
const EMPTY = digest('')
const looksLikeNumber = (s) => /^\+?[\d\s()-]{6,}$/.test(s)

export const reportKeysOf = (keys) => keys.map(k => `report.${k}`)

export function fingerprint(c) {
  const out = {}
  const report = parseReport(c)
  for (const k of Object.keys(report)) out[`report.${k}`] = digest(report[k])
  for (const k of ['subject', 'summary', 'priority', 'status']) out[`col.${k}`] = digest(c[k])
  out['col.position'] = digest(c.lat == null && c.lon == null ? '' : `${c.lat}|${c.lon}`)
  return out
}

const labelOf = (key) => COLUMN_LABELS[key] || fieldLabel(key.replace(/^report\./, ''))

export async function recordSeen(store, contactId, c, now = Date.now()) {
  if (!contactId) return
  const events = await store.listEvents(c.id)
  await store.mutateStaffState(contactId, (st) => {
    st.seen = { ...(st.seen || {}), [c.id]: { at: now, n: events.length, last: events.length ? events[events.length - 1].id : '', fp: fingerprint(c) } }
    const keep = Object.entries(st.seen).sort((a, b) => b[1].at - a[1].at).slice(0, SEEN_CAP)
    st.seen = Object.fromEntries(keep)
  })
}

export async function recordWrote(store, contactId, c, wroteKeys, now = Date.now()) {
  if (!contactId) return
  const snap = (await store.readStaffState(contactId)).seen?.[c.id]
  if (!snap) return recordSeen(store, contactId, c, now)
  const current = fingerprint(c)
  await store.mutateStaffState(contactId, (st) => {
    const fp = { ...st.seen[c.id].fp }
    for (const k of wroteKeys) { if (k in current) fp[k] = current[k]; else delete fp[k] }
    st.seen[c.id] = { ...st.seen[c.id], fp, at: now }
  })
}

function eventsSince(events, snap) {
  const at = snap.n - 1
  if (at < 0) return events
  if (events[at]?.id === snap.last) return events.slice(snap.n)
  return events.filter(e => Number(e.created_at) * 1000 >= snap.at)
}

async function whoChanged(store, me, events) {
  const raw = []
  for (const e of events) {
    const d = evData(e)
    if (d.staff_contact_id === me) continue
    if (e.kind === 'inbound') raw.push('the reporter')
    else if (/^casey-(agent|system)$/.test(String(d.by || ''))) raw.push('the assistant')
    else if (typeof d.by === 'string' && d.by.trim()) raw.push(looksLikeNumber(d.by.trim()) ? 'a team member' : d.by.trim())
    else if (e.actor === 'agent' || e.actor === 'system') raw.push('the assistant')
    else raw.push('a team member')
  }
  const name = await assigneeNamer(store, raw, (v) => v, { logins: true })
  return [...new Set(raw.map(v => String(name(v))))]
}

export async function checkStale(store, ctx, c, touched) {
  const me = ctx?.contact?.id
  if (!me) return null
  const snap = (await store.readStaffState(me)).seen?.[c.id]
  if (!snap) return null
  const now = fingerprint(c)
  const changed = touched.filter(k => (now[k] ?? EMPTY) !== (snap.fp[k] ?? EMPTY))
  if (!changed.length) return null
  const events = await store.listEvents(c.id)
  const by = await whoChanged(store, me, eventsSince(events, snap))
  await recordSeen(store, me, c)
  const fields = changed.map(labelOf)
  return {
    error: `Not recorded: ${fields.join(', ')} on ${c.ref} changed since they last looked${by.length ? ` (changes by ${by.join(', ')})` : ''}. Nothing was changed. Tell them in one plain sentence what changed, ask whether their update still stands, and only if it does repeat the same call.`,
    conflict: true,
    changed: fields,
    changed_by: by,
  }
}

export function shownCase(tool) {
  const handler = tool.handler
  return {
    ...tool,
    handler: async (args, ctx) => {
      const result = await handler(args, ctx)
      const me = ctx?.contact?.id
      const key = args?.case ?? args?.id ?? args?.ref
      if (!me || !key || result?.error || !canQueryCases(ctx?.tier)) return result
      const c = await findCase(ctx.store, key)
      if (c && deskAuthorityOn(ctx, c)) await recordSeen(ctx.store, me, c)
      return result
    },
  }
}
