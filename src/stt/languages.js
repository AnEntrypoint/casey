export const SA_LANGUAGES = Object.freeze([
  { key: 'zu', code: 'zu-ZA', label: 'isiZulu', names: ['zulu', 'isizulu'], chirp: true },
  { key: 'xh', code: 'xh-ZA', label: 'isiXhosa', names: ['xhosa', 'isixhosa'], chirp: true },
  { key: 'af', code: 'af-ZA', label: 'Afrikaans', names: ['afrikaans'], chirp: true },
  { key: 'nso', code: 'nso-ZA', label: 'Sepedi', names: ['sepedi', 'northern sotho', 'sesotho sa leboa'], chirp: true },
  { key: 'en', code: 'en-GB', label: 'English', names: ['english'], chirp: true },
  { key: 'st', code: 'st-ZA', label: 'Sesotho', names: ['sesotho', 'southern sotho', 'sotho'], chirp: false },
  { key: 'tn', code: 'tn-Latn-ZA', label: 'Setswana', names: ['setswana', 'tswana'], chirp: false },
  { key: 'ss', code: 'ss-Latn-ZA', label: 'siSwati', names: ['siswati', 'swati', 'swazi'], chirp: false },
  { key: 've', code: 've-ZA', label: 'Tshivenda', names: ['tshivenda', 'venda'], chirp: false },
  { key: 'ts', code: 'ts-ZA', label: 'Xitsonga', names: ['xitsonga', 'tsonga', 'shangaan'], chirp: false },
])

const BY_KEY = new Map(SA_LANGUAGES.map(l => [l.key, l]))
const BY_NAME = new Map(SA_LANGUAGES.flatMap(l => l.names.map(n => [n, l])))

export function languageOf(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  const base = raw.split(/[-_]/)[0]
  return BY_KEY.get(base) || BY_NAME.get(raw) || null
}

export function longModelLanguage(hint) {
  const lang = languageOf(hint)
  return lang && !lang.chirp ? lang : null
}
