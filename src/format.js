import { LOCAL_TZ, TZ_LABEL, LOCALE, COUNTRY_CODE, INTERNATIONAL_DIGITS_RE, INTERNATIONAL_GROUPS, LOCAL_NUMBER_RE, LOCAL_GROUPS, spaced } from './locale.js'


export { LOCAL_TZ, LOCAL_TZ as SAST_TZ }

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

export function fmtTimeLocal(v) {
  const d = toDate(v)
  if (!d) return ''
  const suffix = TZ_LABEL ? ' ' + TZ_LABEL : ''
  try {
    return d.toLocaleString(LOCALE, {
      timeZone: LOCAL_TZ, year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + suffix
  } catch { return d.toLocaleString() + suffix }
}


export function fmtPhone27(v) {
  const s = String(v || '')
  const digits = s.replace(/[^0-9]/g, '')
  if (INTERNATIONAL_DIGITS_RE && INTERNATIONAL_DIGITS_RE.test(digits)) return '+' + COUNTRY_CODE + ' ' + spaced(digits.slice(COUNTRY_CODE.length), INTERNATIONAL_GROUPS)
  if (LOCAL_NUMBER_RE && LOCAL_NUMBER_RE.test(digits)) return spaced(digits, LOCAL_GROUPS)
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
export function hostIsLocal() {
  return hostTimezone() === LOCAL_TZ
}
export const fmtTimeSAST = fmtTimeLocal;
