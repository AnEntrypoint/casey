// Shared display formatters for the CLI (and any node-side consumer): absolute
// time in South African Standard Time and phone numbers in +27 form, matching
// the dashboard SPA's inlined fmtTime/fmtPhone (server.js fmtTime/fmtPhone) byte
// for byte so the terminal and the web view never disagree. Display only -- the
// raw stored value (event created_at, case external_id) stays the key.

// The one timezone casey shows absolute times in. Field teams work in SAST
// (UTC+2, no DST); an operator anywhere reads the same wall-clock the team does.
export const SAST_TZ = 'Africa/Johannesburg'

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

// Absolute time in SAST with an explicit 'SAST' suffix. Returns '' for a
// missing/corrupt timestamp (never throws) so a timeline row with a bad
// created_at still renders. Mirrors server.js fmtTime.
export function fmtTimeSAST(v) {
  const d = toDate(v)
  if (!d) return ''
  try { return d.toLocaleString('en-ZA', { timeZone: SAST_TZ }) + ' SAST' }
  catch { return d.toLocaleString() + ' SAST' }
}

// Show a SA phone number the way an operator expects: a WhatsApp MSISDN like
// 27821234567 becomes +27 82 123 4567; a local 0821234567 stays 082 123 4567.
// Non-phone external_ids (discord/sim ids) pass through unchanged. Mirrors
// server.js fmtPhone.
export function fmtPhone27(v) {
  const s = String(v || '')
  const digits = s.replace(/[^0-9]/g, '')
  if (/^27[0-9]{9}$/.test(digits)) { const n = digits.slice(2); return '+27 ' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5) }
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
