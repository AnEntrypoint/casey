

export const SAST_TZ = process.env.CASEY_TZ || 'Africa/Johannesburg'
const TZ_LABEL = process.env.CASEY_TZ_LABEL || (process.env.CASEY_TZ ? '' : 'SAST')

export function isOpenCase(c) {
  return c && c.status !== 'resolved' && c.status !== 'closed'
}

const MS_NOT_SECONDS = 1e11

export function toDate(v) {
  if (v == null || v === '') return null
  if (!(typeof v === 'number' || /^\d+$/.test(String(v)))) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }

  const n = Number(v)
  const d = new Date(n >= MS_NOT_SECONDS ? n : n * 1000)
  return isNaN(d.getTime()) ? null : d
}

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

const COUNTRY_CODE = (process.env.CASEY_COUNTRY_CODE || '27').replace(/\D/g, '') || '27'

export function fmtPhone27(v) {
  const s = String(v || '')
  const digits = s.replace(/[^0-9]/g, '')
  const cc = COUNTRY_CODE
  const ccRe = new RegExp('^' + cc + '[0-9]{9}$')
  if (ccRe.test(digits)) { const n = digits.slice(cc.length); return '+' + cc + ' ' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5) }
  if (/^0[0-9]{9}$/.test(digits)) { return digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6) }
  return s
}

const DECEPTIVE_INVISIBLES = /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069\uFEFF]/g
export function markInvisibles(v) {
  if (v == null || typeof v !== 'string') return v
  return v.replace(DECEPTIVE_INVISIBLES, ch => '[U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ']')
}

export function hostTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' }
  catch { return '' }
}
export function hostIsSAST() {
  return hostTimezone() === SAST_TZ
}
