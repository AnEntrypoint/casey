// Shared display formatters for the CLI (and any node-side consumer): absolute
// time in the deployment's local timezone (South Africa/SAST by default) and
// phone numbers in the deployment's country-code form (+27 by default),
// matching the dashboard SPA's inlined fmtTime/fmtPhone (server.js
// fmtTime/fmtPhone) byte for byte so the terminal and the web view never
// disagree. Display only -- the raw stored value (event created_at, case
// external_id) stays the key.

// The timezone casey shows absolute times in. Defaults to SAST (UTC+2, no
// DST) -- casey's shipped design is a South African deployment -- but is
// overridable via CASEY_TZ (any IANA zone name, e.g. "Africa/Lagos",
// "Asia/Karachi") for a deployment of casey's same architecture elsewhere.
// TZ_LABEL is the short suffix shown after a formatted time (e.g. "SAST");
// override with CASEY_TZ_LABEL when CASEY_TZ is set to a non-SAST zone, or
// the display would carry a misleading "SAST" suffix on a foreign timezone.
export const SAST_TZ = process.env.CASEY_TZ || 'Africa/Johannesburg'
const TZ_LABEL = process.env.CASEY_TZ_LABEL || (process.env.CASEY_TZ ? '' : 'SAST')

// A case is "open" when it is neither resolved nor closed. Several dashboard
// endpoints (clusters, geo, map) previously filtered on status!=='closed' alone,
// which counts a resolved case as still-open -- a resolved outbreak kept
// showing as an active cluster/hotspot pin on the map long after report.js's
// own "open" totals (which exclude resolved too) stopped counting it. Single
// source of truth so every open/active view agrees.
export function isOpenCase(c) {
  return c && c.status !== 'resolved' && c.status !== 'closed'
}

// Parse a stored timestamp into a Date, or null if absent/corrupt. thatcher
// event created_at is unix SECONDS (integer); case created_at likewise. A bare
// all-digit value is therefore seconds and is multiplied to ms; anything else is
// handed to the Date string parser. NaN dates (corrupt rows) return null so a
// caller can render a placeholder instead of crashing on toLocaleString.
export function toDate(v) {
  if (v == null || v === '') return null
  const d = (typeof v === 'number' || /^\d+$/.test(String(v))) ? new Date(Number(v) * 1000) : new Date(v)
  return isNaN(d.getTime()) ? null : d
}

// Absolute time in the deployment's timezone, with an explicit suffix (SAST
// by default, blank/custom when CASEY_TZ overrides the zone -- see TZ_LABEL
// above). Returns '' for a missing/corrupt timestamp (never throws) so a
// timeline row with a bad created_at still renders. Mirrors server.js fmtTime.
export function fmtTimeSAST(v) {
  const d = toDate(v)
  if (!d) return ''
  const suffix = TZ_LABEL ? ' ' + TZ_LABEL : ''
  try { return d.toLocaleString('en-ZA', { timeZone: SAST_TZ }) + suffix }
  catch { return d.toLocaleString() + suffix }
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
