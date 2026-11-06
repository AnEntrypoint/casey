

export const ASSIGNEE_PREFIX = 'contact:'

export function assigneeKeyFor(contact) {
  const id = contact?.id
  return id ? `${ASSIGNEE_PREFIX}${id}` : ''
}

export function isContactAssignee(value) {
  return typeof value === 'string' && value.startsWith(ASSIGNEE_PREFIX) && value.length > ASSIGNEE_PREFIX.length
}

export function contactIdOfAssignee(value) {
  return isContactAssignee(value) ? value.slice(ASSIGNEE_PREFIX.length) : ''
}

export function isAssignedTo(caseRow, contact) {
  const key = assigneeKeyFor(contact)
  if (!key) return false
  return String(caseRow?.assignee || '').trim() === key
}

export function isOwnConversation(caseRow, contact) {
  const me = String(contact?.external_id || '')
  if (!me || String(caseRow?.channel || '') !== String(contact?.channel || '')) return false
  const ext = String(caseRow?.external_id || '')
  return ext === me || ext.split(':').pop() === me
}

export function publicAssignee(value, viewer = null) {
  if (!isContactAssignee(value)) return value
  return assigneeKeyFor(viewer) === value ? 'you' : 'a team member'
}
