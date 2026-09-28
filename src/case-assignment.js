// case-assignment.js  --  who a case is assigned to, as a fail-closed predicate.
//
// `case.assignee` is free text with two historical shapes: an operator's
// dashboard username ("thabo") and the unclaimed marker "agent". Neither can
// name a WhatsApp CONTACT reliably (a display name is not unique, and the phone
// number must never be stored there), so a person who works over WhatsApp is
// assigned by a STABLE KEY: `contact:<contact.id>`. Existing usernames keep
// meaning exactly what they meant; a key is just one more string the column can
// hold, so nothing needs migrating.
//
// The whole surface, deliberately tiny:
//
//   assigneeKeyFor(contact)          -> 'contact:<id>' ('' when there is no id)
//   isAssignedTo(caseRow, contact)   -> true ONLY when caseRow.assignee is
//                                       exactly that contact's key. Fail-closed:
//                                       a missing contact, a contact with no id,
//                                       an empty/blank/legacy assignee are all
//                                       false, never "no assignee means anyone".
//   isContactAssignee(value)         -> the value is a contact key (not a
//                                       dashboard username, not 'agent')
//   contactIdOfAssignee(value)       -> the contact id inside a key, or ''
//   publicAssignee(value, viewer?)   -> a display-safe rendering for anything a
//                                       model or another contact reads: the key
//                                       becomes 'you' (viewer's own) or 'a team
//                                       member'; every other value is unchanged.
//
// Pure: no I/O, no clock, no config. The dashboard renders a key by looking the
// contact up by id (store.getContact) -- it never parses a name out of it.

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

export function publicAssignee(value, viewer = null) {
  if (!isContactAssignee(value)) return value
  return assigneeKeyFor(viewer) === value ? 'you' : 'a team member'
}
