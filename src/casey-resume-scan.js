// casey-resume-scan.js  --  deciding WHICH interrupted turn (if any) a case
// still has worth re-driving. Pure over an event log and a clock: no store, no
// gateway, no adapters.
//
// Split out of casey-resume.js verbatim. The two caps below and the timestamp
// discipline they depend on are the whole reason this is its own module: they
// are the part of the sweep that decides whether a real reporter ever gets an
// answer, and they must be readable without also reading the re-drive plumbing.

import { tagList, tsMs } from './timestamp.js'
import { evData } from './safe.js'

// "The contact got their answer, so every turn started before this is no longer
// pending." The one shared answer for this scan and casey-drain.js's, so the two
// cannot drift on it.
//
// A GUARANTEED FALLBACK IS NOT AN ANSWER. hooks/delivery.js's
// sendGuaranteedFallback writes a real kind:'outbound' row carrying
// turn-deadlines.js's TURN_TIMEOUT_TEXT -- a status message that says casey is
// having trouble and asks the person to send their message again. Counting it as a
// completion makes the one thing this whole sweep exists for -- a turn that
// started and never answered -- unreachable for the commonest way a live turn
// dies, and leaves a reporter who was told to resend with nothing recorded and
// nothing said about their animals. casey-drain.js's own degrade path guards the
// identical burn by recording an observation instead of an outbound; the live path
// cannot, because the live-turn guarantee requires it to send something.
//
// Keyed on data.guaranteedFallback, the flag the sender already stamps -- never on
// the text, which is language-neutral copy a deployer may reword.
//
// Re-driving what this leaves pending is bounded and cannot double-answer: a
// background re-drive stays SILENT on a second degrade
// (hooks/inbound-turn.js's isBackgroundRedrive branch), the attempt cap and
// resumeMaxAgeMs still bound it, and a contact who did resend has a real outbound
// on the timeline which completes the old msgId here.
export function completesTurn(ev) {
  if (ev?.kind !== 'outbound' && ev?.kind !== 'draft') return false
  return evData(ev).guaranteedFallback !== true
}

// A msgId marked resume-attempted with NO resume-degraded marker is treated as a
// genuine, silent completion (the handler threw, or something unexpected
// happened with no observation recorded) and is not retried: unlike degraded,
// there is no positive signal here that another attempt would behave
// differently. This cap bounds total retries across all future boots so a
// permanently-broken backend still stops trying eventually, the same discipline
// as drainQueuedTurns' retryCap -> queue-drive-failed dead-letter.
export const RESUME_DEGRADED_RETRY_CAP = 5

// Age ceiling, independent of attempt count: a message that has sat unanswered
// this long has almost certainly had its sender move on, so continuing to
// resume-retry it provides no real value and only keeps consuming provider budget
// shared with live traffic. It bounds the total number of BOOTS a stuck msgId can
// ever be retried across, which the attempt-count cap alone does not do: a case
// with many old distinct pending msgIds otherwise keeps finding a fresh
// under-cap one to retry, boot after boot, indefinitely.
export function resumeMaxAgeMs() {
  return Number(process.env.CASEY_RESUME_MAX_AGE_MS) || 24 * 60 * 60 * 1000
}

// Cheapest possible short-circuit, applied before a case's event log is even
// fetched. A case already flagged resume-exhausted has NO genuinely-pending
// msgId left -- every one it ever had is either completed or has hit
// RESUME_DEGRADED_RETRY_CAP. The per-msgId cap alone is not enough: a case with
// MANY historical inbound messages (a contact who sent several messages during
// an outage) picks a DIFFERENT still-under-cap msgId on each boot's sweep, so the
// case as a whole never stops being re-driven, and every walk burns a full
// provider-chain attempt per msgId, competing directly with live traffic for the
// same rate-limited capacity. A dead-lettered case still shows up in the
// operator's needs-human queue -- nothing is lost, it just stops silently
// consuming provider budget forever.
export function isResumeCandidate(c, { openStatuses, adapters }) {
  // Only re-drive cases still open (a closed/won case wants no further reply).
  if (openStatuses.size && !openStatuses.has(c.status)) return false
  // Skip channels with no live adapter to send on.
  if (!adapters[c.channel]?.send) return false
  if (tagList(c).includes('resume-exhausted')) return false
  return true
}

// Walk chronologically. Track, per msgId, whether its turn started, whether a
// completion (outbound/draft) followed, how many resumes were attempted, and how
// many of those came back degraded. A completion or a later inbound for the SAME
// msgId is positional.
//
// `attemptCount` counts resume-attempted markers across ALL boots, not this boot's
// pass -- markResumeAttempted (casey-resume-redrive.js) writes one per attempt, so
// it is the total-attempt bound that stops a permanently-broken msgId being
// re-driven forever, and it must not be collapsed to a per-boot set.
//
// `interrupted` is the msgIds whose LATEST resume attempt started a turn
// (TURN-START) that nothing then completed. That is a re-drive killed mid-flight --
// a reload, a crash, or a handler that threw after the turn began -- which is the
// exact failure this sweep exists to recover and NOT evidence that the message was
// answered. Without it, an attempt with no resume-degraded marker beside it reads
// as a silent completion and the reporter is abandoned permanently on the first
// interruption, which is what markResumeAttempted's own contract ("it does NOT mean
// permanently done") says must not happen.
export function scanTurnMarkers(events) {
  const started = new Map()       // msgId -> inbound event
  const completedAfter = new Set()
  const attemptCount = new Map()  // msgId -> count of resume-attempted markers across ALL boots
  const degradedCount = new Map() // msgId -> count of resume-degraded markers across ALL boots
  const startsSinceAttempt = new Map() // msgId -> TURN-STARTs since its latest attempt, cleared on completion
  for (const ev of events) {
    if (ev.kind === 'inbound' && ev.msg_id) started.set(ev.msg_id, ev)
    else if (ev.kind === 'observation' && typeof ev.text === 'string') {
      let m = ev.text.match(/^resume-attempted:(.+)$/)
      if (m) { attemptCount.set(m[1], (attemptCount.get(m[1]) || 0) + 1); startsSinceAttempt.set(m[1], 0) }
      m = ev.text.match(/^resume-degraded:(.+)$/)
      if (m) degradedCount.set(m[1], (degradedCount.get(m[1]) || 0) + 1)
      m = ev.text.match(/^TURN-START:(.+)$/)
      if (m && startsSinceAttempt.has(m[1])) startsSinceAttempt.set(m[1], startsSinceAttempt.get(m[1]) + 1)
    }
    // Any REAL outbound/draft completes EVERY turn started before it: a reply on
    // the conversation answers the latest inbound, so an earlier unanswered
    // inbound is no longer pending (the contact got a response on this thread).
    // A guaranteed-fallback status message is not such a reply -- see
    // completesTurn above.
    if (completesTurn(ev)) {
      for (const id of started.keys()) completedAfter.add(id)
      startsSinceAttempt.clear()
    }
  }
  const interrupted = new Set([...startsSinceAttempt].filter(([, n]) => n > 0).map(([id]) => id))
  return { started, completedAfter, attemptCount, degradedCount, interrupted }
}

// The pending msgId: started, not completed, and with an attempt budget left --
// either never attempted, or attempted and the attempt demonstrably did not answer
// (it came back degraded, or it was interrupted mid-turn). `anyCapped` reports
// whether at least one uncompleted msgId was a REAL exhausted retry, which is what
// licenses the caller to dead-letter the case.
//
// An attempt that neither degraded nor left an interrupted turn behind is the one
// case still treated as a silent completion and left alone: the handler returned
// without starting a turn and without reporting a failure, so there is no signal
// another attempt would behave differently.
export function selectPendingTurn({ started, completedAfter, attemptCount, degradedCount, interrupted }, nowMs) {
  const maxAgeMs = resumeMaxAgeMs()
  let pending = null
  let anyCapped = false
  for (const [id, ev] of started) {
    if (completedAfter.has(id)) continue
    const attempts = attemptCount.get(id) || 0
    const wasAttempted = attempts > 0 && !interrupted.has(id)
    const degraded = degradedCount.get(id) || 0
    if (wasAttempted && degraded === 0) continue           // silent non-degraded completion: leave it alone
    // tsMs, never a bare Number(). busybase hands created_at back as a
    // numeric-SECONDS string, so Number() yields a seconds count subtracted
    // from a MILLISECONDS clock: every pending turn measures ~56 years old
    // and trips this ceiling on its very first boot, so the sweep can never
    // resume anything -- it only dead-letters, tagging the case
    // resume-exhausted/needs-human with a message claiming a retry cap that
    // was never reached, and a turn interrupted mid-flight (TURN-START
    // written, no outbound) leaves the reporter in permanent silence. tsMs
    // returns NaN for an unreadable stamp, so `|| nowMs` is the fail-safe: an
    // unparseable timestamp ages 0 and is never capped.
    const ageMs = nowMs - (tsMs(ev.created_at) || nowMs)
    // ATTEMPTS, not degrades, is the counter the cap reads. One resume-attempted
    // marker is written per attempt and a resume-degraded marker only when the
    // attempt reported a degrade, so attempts >= degrades always and counting
    // degrades alone leaves an attempt that keeps getting INTERRUPTED (never
    // reporting anything) uncapped -- re-driven on every boot for the whole
    // resumeMaxAgeMs window, which on a deployment that reloads often is
    // thousands of provider calls competing with live traffic. For a msgId that
    // does report its degrades the two counts agree, so this is the same bound it
    // always had.
    if (Math.max(attempts, degraded) >= RESUME_DEGRADED_RETRY_CAP || ageMs >= maxAgeMs) { anyCapped = true; continue }  // exhausted retries or too old: stop trying
    // tsMs, never a bare >= on the raw column. busybase hands created_at
    // back as a numeric-SECONDS STRING, so a bare >= compares strings --
    // which happens to order correctly only while every value is the same
    // digit length, and silently stops doing so the moment one arrives as
    // an ISO stamp or the epoch gains a digit.
    if (!pending || tsMs(ev.created_at) >= tsMs(pending.ev.created_at)) pending = { id, ev }
  }
  return { pending, anyCapped }
}
