export const VISIT_IDLE_MS = 2 * 3600e3

export async function visitOf(store, contactId, caseId, now = Date.now()) {
  const v = (await store.readStaffState(contactId)).visit
  if (!v) return null
  if (now - v.lastUsedAt > VISIT_IDLE_MS) {
    await store.mutateStaffState(contactId, (st) => { if (st.visit?.lastUsedAt === v.lastUsedAt) delete st.visit })
    return null
  }
  return v.caseId === caseId ? v : null
}

export async function saveVisit(store, contactId, v, now = Date.now()) {
  v.lastUsedAt = now
  await store.mutateStaffState(contactId, (st) => { st.visit = v })
  return v
}

export function newVisit(caseId, ref, queue, now = Date.now()) {
  return { caseId, ref, queue: [...queue], recorded: [], skipped: [], startedAt: now, lastUsedAt: now }
}

export async function endVisit(store, contactId) {
  await store.mutateStaffState(contactId, (st) => { delete st.visit })
}
