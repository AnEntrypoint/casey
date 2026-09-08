// hooks/case-writes.js -- the two case-write shapes the inbound path repeats.
//
// Neither of these is a new abstraction over the store: they are the exact
// literal shapes the inbound path writes at each site. `observation()` is
// `{ kind: 'observation', actor: 'system', text }`; flagNeedsHuman is the
// read-then-tag-then-notify-once sequence its four callers share (an explicit
// human request in service-controls.js, and observe mode, the
// jargon/false-confirmation hold and the assisted draft in turn-outcome.js),
// differing only in the extra tags and the log labels. Four copies of a
// notify-ONCE rule is four places for the "once" to drift, so it lives here
// once.

import { tagList } from '../timestamp.js'
import { mergeTag } from './heuristics.js'

// The system-observation event body. `data` is omitted entirely when absent --
// never passed as an explicit undefined -- so the written row carries no `data`
// key at all rather than one holding undefined.
export function observation(text, data) {
  return data ? { kind: 'observation', actor: 'system', text, data } : { kind: 'observation', actor: 'system', text }
}

// Flag a case as wanting an operator, and page the handoff webhook at most once
// per case. The notify is deliberately NOT idempotent the way mergeTag is: a
// contact repeating "person?" must not re-ping the team on every message, so the
// already-flagged read has to happen BEFORE the tag write, never after.
//
// `extraTags` carries the caller's additional tag (today: 'draft-pending' on the
// two draft-hold paths) and MUST merge BEFORE 'needs-human' -- tags are a
// comma-joined string, so the order is observable, not incidental. Tags merge
// onto the `caseRow.tags` the CALLER passed, never a fresh re-read, so a caller
// holding a stale row keeps its own behaviour.
//
// Best-effort by contract: a tag or notify failure is non-blocking -- the reply
// path must never die because an audit tag did not land -- so the whole sequence
// is guarded and logged, never thrown. The two log labels stay separate because
// the observe-mode call site's own two messages are not symmetric.
export async function flagNeedsHuman({ store, log, caseRow, notifyHandoff, channel, from, extraTags = [], flagLabel, notifyLabel }) {
  const alreadyFlagged = tagList(caseRow).includes('needs-human')
  try {
    let tags = caseRow.tags
    for (const t of extraTags) tags = mergeTag(tags, t)
    await store.updateCase(caseRow.id, { tags: mergeTag(tags, 'needs-human') })
    if (notifyHandoff && !alreadyFlagged) {
      try { await notifyHandoff({ case: caseRow, channel, from }) }
      catch (e) { log.warn?.(`[casey] ${notifyLabel} notify failed`, { caseId: caseRow.id, error: e.message }) }
    }
  } catch (e) { log.warn?.(`[casey] ${flagLabel} flag failed`, { caseId: caseRow.id, error: e.message }) }
}
