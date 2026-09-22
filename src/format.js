// Shared display formatters for the CLI (and any node-side consumer): absolute
// time in the deployment's local timezone (South Africa/SAST by default) and
// phone numbers in the deployment's country-code form (+27 by default),
// rendering the same strings as the dashboard SPA's own
// public/src/format.js so the terminal and the web view never disagree.
// Display only -- the raw stored value (event created_at, case external_id)
// stays the key.
//
// Pass explicit format options, never toLocaleString's bare locale default:
// the en-ZA default renders "2026/07/02, 09:29:48 SAST" where the SPA renders
// "02 Jul 2026, 09:29 SAST" -- a different date order, a different month form,
// and seconds on one side only. The option bag below is the SPA's, verbatim,
// so an operator reading a case aloud off the terminal and one reading it off
// the dashboard say the same words, and no numeric date order is left
// orderable two ways by a reader who does not know which convention it is in.

// The timezone casey shows absolute times in. Defaults to SAST (UTC+2, no
// DST) -- casey's shipped design is a South African deployment -- but is
// overridable via CASEY_TZ (any IANA zone name, e.g. "Africa/Lagos",
// "Asia/Karachi") for a deployment of casey's same architecture elsewhere.
// TZ_LABEL is the short suffix shown after a formatted time (e.g. "SAST");
// override with CASEY_TZ_LABEL when CASEY_TZ is set to a non-SAST zone, or
// the display would carry a misleading "SAST" suffix on a foreign timezone.
export const SAST_TZ = process.env.CASEY_TZ || 'Africa/Johannesburg'
const TZ_LABEL = process.env.CASEY_TZ_LABEL || (process.env.CASEY_TZ ? '' : 'SAST')

// A case is "open" when it is neither resolved nor closed. Single source of
// truth so every open/active view agrees: a dashboard endpoint (clusters, geo,
// map) that filters on status!=='closed' alone counts a resolved case as
// still-open, and a resolved outbreak then keeps showing as an active
// cluster/hotspot pin on the map long after report.js's own "open" totals
// (which exclude resolved too) have stopped counting it.
export function isOpenCase(c) {
  return c && c.status !== 'resolved' && c.status !== 'closed'
}

// Parse a stored timestamp into a Date, or null if absent/corrupt. thatcher
// event created_at is unix SECONDS (integer); case created_at likewise. A bare
// all-digit value is therefore seconds and is multiplied to ms; anything else is
// handed to the Date string parser. NaN dates (corrupt rows) return null so a
// caller can render a placeholder instead of crashing on toLocaleString.
// A bare digit value above this can only be milliseconds: as SECONDS it is the
// year 5138. Real case timestamps are nowhere near it, and a millisecond
// timestamp today is ~1.79e12, an order of magnitude above.
const MS_NOT_SECONDS = 1e11

export function toDate(v) {
  if (v == null || v === '') return null
  if (!(typeof v === 'number' || /^\d+$/.test(String(v)))) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  // Seconds is the convention every caller follows, and the millisecond call
  // sites divide explicitly (reports.js's secs(), casey-store-commands.js's
  // Math.floor(x / 1000)). This guard exists because that convention is hand
  // maintained across seven call sites with nothing enforcing it, and getting it
  // wrong here does not throw -- it renders. A millisecond value multiplied
  // again put an operator-facing date in the year 58656. The seconds/millisecond
  // confusion has already shipped twice in this codebase (the boot resume sweep
  // measured every pending turn 56 years old and dead-lettered it;
  // buildClosureCompleteness pinned itself at zero), so an eighth call site
  // getting it wrong is a matter of time rather than a hypothetical.
  const n = Number(v)
  const d = new Date(n >= MS_NOT_SECONDS ? n : n * 1000)
  return isNaN(d.getTime()) ? null : d
}

// Absolute time in the deployment's timezone, with an explicit suffix (SAST
// by default, blank/custom when CASEY_TZ overrides the zone -- see TZ_LABEL
// above). Returns '' for a missing/corrupt timestamp (never throws) so a
// timeline row with a bad created_at still renders. The option bag is the
// dashboard SPA's (public/src/format.js fmtTime), character for character --
// the two are a matched pair and an edit to either is a bug unless it lands
// in both. Only the SOURCE of the zone and label differs by design: here they
// come from CASEY_TZ/CASEY_TZ_LABEL, there from state.config.
export function fmtTimeSAST(v) {
  const d = toDate(v)
  if (!d) return ''
  const suffix = TZ_LABEL ? ' ' + TZ_LABEL : ''
  try {
    return d.toLocaleString('en-ZA', {
      timeZone: SAST_TZ, year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + suffix
  } catch { return d.toLocaleString() + suffix }
}

// The country calling code casey formats phone numbers for. Defaults to South
// Africa (27) -- casey's shipped design -- but overridable via
// CASEY_COUNTRY_CODE (digits only, e.g. "234" for Nigeria) for a deployment
// elsewhere. Digit-grouping below stays SA-shaped (2-3-4) even under an
// override: a truly correct international formatter needs a per-country
// grouping table, which is out of scope here -- an overridden deployment gets
// a consistently-grouped, if not idiomatic, display rather than the SA-coded
// prefix on someone else's numbers.
const COUNTRY_CODE = (process.env.CASEY_COUNTRY_CODE || '27').replace(/\D/g, '') || '27'

// Show a phone number the way an operator expects: a WhatsApp MSISDN like
// 27821234567 becomes +27 82 123 4567; a local 0821234567 stays 082 123 4567.
// Non-phone external_ids (discord/sim ids) pass through unchanged. Mirrors
// server.js fmtPhone.
export function fmtPhone27(v) {
  const s = String(v || '')
  const digits = s.replace(/[^0-9]/g, '')
  const cc = COUNTRY_CODE
  const ccRe = new RegExp('^' + cc + '[0-9]{9}$')
  if (ccRe.test(digits)) { const n = digits.slice(cc.length); return '+' + cc + ' ' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5) }
  if (/^0[0-9]{9}$/.test(digits)) { return digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6) }
  return s
}

// Bidi and invisible format characters in CONTACT-SUPPLIED text, turned into a
// visible ASCII marker.
//
// HTML-escaping does not touch these and was never meant to: they are legal
// characters, not markup. So a case subject carrying U+202E (RIGHT-TO-LEFT
// OVERRIDE) renders the rest of its line backwards -- in the operator console and
// in a terminal alike -- and a count or a place name can therefore READ as
// something other than what the reporter actually sent. U+200B and friends are
// worse in a different way: they are simply not there to the eye, so "1<ZWSP>20"
// and "120" look identical while a copy-paste of one into another system fails.
//
// Live-witnessed over Discord: a probe report whose counts carried U+200B and
// whose sentence carried U+200F/U+200E reached case.subject and event.text with
// every one of those characters intact. That probe's U+202E did NOT arrive --
// Discord filtered it on send -- so the override half of this guard is not
// something Discord alone can deliver. It stays in the set because Discord is not
// the only inbound path: the WhatsApp webhook hands casey the message body as
// posted, with no platform filtering in front of it, and the public /report form
// even less.
//
// MARKED, NEVER STRIPPED, for the same reason every other field is recorded as
// the person said it: the text is the record. The operator reads it in logical
// order AND can see that a control character was present -- nothing is silently
// removed, and nothing silently reads as something it is not.
//
// Two classes are deliberately left ALONE. Combining marks (the 'zalgo' shape)
// are ordinary diacritics in real languages this deployment serves, and they
// distort layout rather than meaning -- a CSS clipping concern, not a text one.
// ZWJ/ZWNJ join rather than reorder, and ZWJ carries real emoji sequences, so
// marking them would corrupt an ordinary photo caption.
//
// Applied SERVER-side, at the projection every case row already passes through,
// rather than in the SPA's mirror of this file: one application covers the SPA,
// the CSV/HTML report and the CLI at once, and there is no second copy to drift.
const DECEPTIVE_INVISIBLES = /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069\uFEFF]/g
export function markInvisibles(v) {
  if (v == null || typeof v !== 'string') return v
  return v.replace(DECEPTIVE_INVISIBLES, ch => '[U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ']')
}

// True when the host process is not running in SAST, so the CLI/doctor can warn
// that its own clock-derived output (if any) differs from the SAST display.
// Resolved timezone is compared, not the offset, so a UTC+2 zone that observes
// DST is still flagged as not-SAST.
export function hostTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' }
  catch { return '' }
}
export function hostIsSAST() {
  return hostTimezone() === SAST_TZ
}
