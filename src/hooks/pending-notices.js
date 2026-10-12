export const PENDING_NOTICE_KIND = 'pending_notice'
export const NOTICE_DELIVERED_KIND = 'notice_delivered'

function evDataOf(e) {
  if (!e?.data) return {}
  if (typeof e.data === 'object') return e.data
  try { return JSON.parse(e.data) || {} } catch { return {} }
}

export async function queueNotice(store, caseRow, { notice, stage = '', text }) {
  return store.appendEvent(caseRow.id, {
    kind: PENDING_NOTICE_KIND, actor: 'system', text: '',
    data: { notice, stage, text, at: new Date().toISOString() },
    touch: false,
  })
}

async function sameReplyTargetCases(store, caseRow) {
  let others = []
  if (caseRow.contact_id) {
    try { others = await store.t.list('case', { contact_id: caseRow.contact_id }, { limit: 200 }) }
    catch { others = [] }
  }
  const same = others.filter(c => c.id !== caseRow.id && c.channel === caseRow.channel && c.external_id === caseRow.external_id)
  return [caseRow, ...same]
}

export async function pendingNoticesFor(store, caseRow) {
  if (!caseRow?.id) return []
  const out = []
  for (const c of await sameReplyTargetCases(store, caseRow)) {
    const events = await store.listEvents(c.id)
    const delivered = new Set()
    for (const e of events) {
      if (e.kind === NOTICE_DELIVERED_KIND) for (const id of evDataOf(e).ids || []) delivered.add(String(id))
    }
    for (const e of events) {
      if (e.kind !== PENDING_NOTICE_KIND || delivered.has(String(e.id))) continue
      const d = evDataOf(e)
      out.push({ id: String(e.id), case_id: c.id, notice: d.notice || '', stage: d.stage || '', text: String(d.text || ''), at: d.at || e.created_at || '' })
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

export async function markNoticesDelivered(store, items, { msgId = '' } = {}) {
  const byCase = new Map()
  for (const it of items) {
    if (!byCase.has(it.case_id)) byCase.set(it.case_id, [])
    byCase.get(it.case_id).push(it.id)
  }
  for (const [caseId, ids] of byCase) {
    await store.appendEvent(caseId, {
      kind: NOTICE_DELIVERED_KIND, actor: 'agent', text: '',
      data: { ids, in_reply_to: msgId || null }, touch: false,
    })
  }
}

export function pendingNoticeNote(items) {
  const lines = items.map(i => `- ${i.text}${i.at ? ` (noted ${i.at})` : ''}`)
  return `\n\n[System note: these notices are owed to this person and have not reached them yet. Work every one of them into your reply naturally, in the language they are writing in, as part of what you are saying anyway. Never send them as a separate message, a list, a block or a heading, and never ask them to act on them. Each line is a fact to convey, not wording to copy.]\n${lines.join('\n')}`
}
