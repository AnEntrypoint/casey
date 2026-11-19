import { caseyText } from '../deployment-text.js';


export async function judgeReply(callLLM, replyText, { lastOutboundText = null, hadSuccessfulWrite = null, latestInbound = null, missingFacts = [], knownFacts = [], shape = null, adviceRefusal = null, controlNoted = false, consentOwed = false, consentAgreed = false, clarifyOwed = false, recordedLanguage = '' } = {}) {
  if (!replyText || !String(replyText).trim()) return { clean: true, reasons: [], category: null }
  if (typeof callLLM !== 'function') return { clean: true, reasons: [], category: null }

  const judgePrompt = [
    caseyText("src/hooks/reply-judge.js#0"),
    caseyText("src/hooks/reply-judge.js#1"),
    caseyText("src/hooks/reply-judge.js#2"),
    caseyText("src/hooks/reply-judge.js#3"),
    caseyText("src/hooks/reply-judge.js#4"),
    caseyText("src/hooks/reply-judge.js#5"),
    caseyText("src/hooks/reply-judge.js#6"),
    caseyText("src/hooks/reply-judge.js#7"),
    caseyText("src/hooks/reply-judge.js#8"),
    caseyText("src/hooks/reply-judge.js#9"),
    caseyText("src/hooks/reply-judge.js#10"),
    caseyText("src/hooks/reply-judge.js#11"),
    caseyText("src/hooks/reply-judge.js#12"),
    caseyText("src/hooks/reply-judge.js#13"),
    caseyText("src/hooks/reply-judge.js#14"),
    caseyText("src/hooks/reply-judge.js#15"),
    caseyText("src/hooks/reply-judge.js#16"),
    caseyText("src/hooks/reply-judge.js#17"),
    caseyText("src/hooks/reply-judge.js#18"),
    caseyText("src/hooks/reply-judge.js#19"),
    caseyText("src/hooks/reply-judge.js#20"),
    caseyText("src/hooks/reply-judge.js#21"),
    caseyText("src/hooks/reply-judge.js#22"),
    caseyText("src/hooks/reply-judge.js#23"),
    caseyText("src/hooks/reply-judge.js#24"),
    caseyText("src/hooks/reply-judge.js#25"),
    caseyText("src/hooks/reply-judge.js#26"),
    caseyText("src/hooks/reply-judge.js#27"),
    caseyText("src/hooks/reply-judge.js#28"),

    hadSuccessfulWrite === false ? [
      caseyText("src/hooks/reply-judge.js#29"),
      caseyText("src/hooks/reply-judge.js#30"),
      caseyText("src/hooks/reply-judge.js#31"),
      caseyText("src/hooks/reply-judge.js#32"),
      caseyText("src/hooks/reply-judge.js#33"),
      caseyText("src/hooks/reply-judge.js#34"),
      caseyText("src/hooks/reply-judge.js#35"),
      caseyText("src/hooks/reply-judge.js#36"),
      caseyText("src/hooks/reply-judge.js#37"),
      caseyText("src/hooks/reply-judge.js#s0"),
    ].join('\n') : null,

    missingFacts.length ? [
      caseyText("src/hooks/reply-judge.js#38"),
      caseyText("src/hooks/reply-judge.js#39"),
      caseyText("src/hooks/reply-judge.js#40"),
      `   implies): ${missingFacts.join(', ')}.`,
      caseyText("src/hooks/reply-judge.js#41"),
      caseyText("src/hooks/reply-judge.js#42"),
      caseyText("src/hooks/reply-judge.js#43"),
      caseyText("src/hooks/reply-judge.js#44"),
      caseyText("src/hooks/reply-judge.js#45"),
      caseyText("src/hooks/reply-judge.js#46"),
      caseyText("src/hooks/reply-judge.js#47"),
      caseyText("src/hooks/reply-judge.js#48"),
      caseyText("src/hooks/reply-judge.js#49"),
      caseyText("src/hooks/reply-judge.js#50"),
      caseyText("src/hooks/reply-judge.js#51"),

      caseyText("src/hooks/reply-judge.js#52"),
      caseyText("src/hooks/reply-judge.js#53"),
      caseyText("src/hooks/reply-judge.js#54"),
      caseyText("src/hooks/reply-judge.js#55"),
      caseyText("src/hooks/reply-judge.js#56"),
      caseyText("src/hooks/reply-judge.js#s1"),
    ].join('\n') : null,

    (lastOutboundText || knownFacts.length) ? [
    caseyText("src/hooks/reply-judge.js#57"),
    caseyText("src/hooks/reply-judge.js#58"),
    caseyText("src/hooks/reply-judge.js#59"),
    caseyText("src/hooks/reply-judge.js#60"),
    caseyText("src/hooks/reply-judge.js#61"),
    caseyText("src/hooks/reply-judge.js#62"),
    caseyText("src/hooks/reply-judge.js#63"),
    caseyText("src/hooks/reply-judge.js#64"),
    caseyText("src/hooks/reply-judge.js#s2"),
    consentOwed ? caseyText("src/hooks/reply-judge.js#65") : null,

    caseyText("src/hooks/reply-judge.js#66"),
    caseyText("src/hooks/reply-judge.js#67"),
    caseyText("src/hooks/reply-judge.js#68"),
    caseyText("src/hooks/reply-judge.js#69"),
    caseyText("src/hooks/reply-judge.js#70"),
    caseyText("src/hooks/reply-judge.js#71"),
    caseyText("src/hooks/reply-judge.js#72"),
    caseyText("src/hooks/reply-judge.js#s3"),
    ].join('\n') : null,

    caseyText("src/hooks/reply-judge.js#73"),
    caseyText("src/hooks/reply-judge.js#74"),
    caseyText("src/hooks/reply-judge.js#75"),
    caseyText("src/hooks/reply-judge.js#76"),
    caseyText("src/hooks/reply-judge.js#77"),
    caseyText("src/hooks/reply-judge.js#78"),
    caseyText("src/hooks/reply-judge.js#79"),
    caseyText("src/hooks/reply-judge.js#80"),
    adviceRefusal ? caseyText("src/hooks/reply-judge.js#81", [adviceRefusal]) : null,
    caseyText("src/hooks/reply-judge.js#82"),
    caseyText("src/hooks/reply-judge.js#83"),
    caseyText("src/hooks/reply-judge.js#84"),
    caseyText("src/hooks/reply-judge.js#85"),
    caseyText("src/hooks/reply-judge.js#86"),
    caseyText("src/hooks/reply-judge.js#87"),
    caseyText("src/hooks/reply-judge.js#88"),
    caseyText("src/hooks/reply-judge.js#89"),
    caseyText("src/hooks/reply-judge.js#90"),
    caseyText("src/hooks/reply-judge.js#91"),
    caseyText("src/hooks/reply-judge.js#92"),
    caseyText("src/hooks/reply-judge.js#93"),
    caseyText("src/hooks/reply-judge.js#94"),
    caseyText("src/hooks/reply-judge.js#95"),
    caseyText("src/hooks/reply-judge.js#96"),
    controlNoted ? caseyText("src/hooks/reply-judge.js#97") : null,
    caseyText("src/hooks/reply-judge.js#s4"),
    consentOwed ? [
      caseyText("src/hooks/reply-judge.js#98"),
      caseyText("src/hooks/reply-judge.js#99"),
      caseyText("src/hooks/reply-judge.js#100"),
      caseyText("src/hooks/reply-judge.js#s5"),
    ].join('\n') : null,

    clarifyOwed ? [
      caseyText("src/hooks/reply-judge.js#101"),
      caseyText("src/hooks/reply-judge.js#102"),
      caseyText("src/hooks/reply-judge.js#103"),
      caseyText("src/hooks/reply-judge.js#104"),
    ].join('\n') : null,

    consentAgreed ? [
      caseyText("src/hooks/reply-judge.js#105"),
      caseyText("src/hooks/reply-judge.js#106"),
      caseyText("src/hooks/reply-judge.js#107"),
      caseyText("src/hooks/reply-judge.js#108"),
      caseyText("src/hooks/reply-judge.js#109"),
      caseyText("src/hooks/reply-judge.js#s6"),
    ].join('\n') : null,

    (hadSuccessfulWrite === false && missingFacts.length && latestInbound) ? [
      caseyText("src/hooks/reply-judge.js#110"),
      caseyText("src/hooks/reply-judge.js#111"),
      caseyText("src/hooks/reply-judge.js#112"),
      caseyText("src/hooks/reply-judge.js#s7"),
      caseyText("src/hooks/reply-judge.js#113"),
      caseyText("src/hooks/reply-judge.js#114", [missingFacts.join(', ')]),
      caseyText("src/hooks/reply-judge.js#115"),
      caseyText("src/hooks/reply-judge.js#116"),
      caseyText("src/hooks/reply-judge.js#117"),
      caseyText("src/hooks/reply-judge.js#118"),
      caseyText("src/hooks/reply-judge.js#119"),
      caseyText("src/hooks/reply-judge.js#120"),
      caseyText("src/hooks/reply-judge.js#121"),
      caseyText("src/hooks/reply-judge.js#s8"),
      caseyText("src/hooks/reply-judge.js#s9"),
    ].join('\n') : null,

    ``,
    caseyText("src/hooks/reply-judge.js#122"),
    caseyText("src/hooks/reply-judge.js#123"),
    caseyText("src/hooks/reply-judge.js#124"),
    caseyText("src/hooks/reply-judge.js#125"),
    caseyText("src/hooks/reply-judge.js#s10"),
    ``,
    lastOutboundText ? caseyText("src/hooks/reply-judge.js#126", [String(lastOutboundText).slice(0, 500)]) : null,
    latestInbound ? caseyText("src/hooks/reply-judge.js#127", [String(latestInbound).slice(0, 500)]) : null,

    knownFacts.length ? caseyText("src/hooks/reply-judge.js#128", [knownFacts.join(', ')]) : null,
    caseyText("src/hooks/reply-judge.js#s11"),
    String(replyText).slice(0, 2000),
    ``,
    caseyText("src/hooks/reply-judge.js#129"),
    caseyText("src/hooks/reply-judge.js#130"),
    caseyText("src/hooks/reply-judge.js#131"),
    caseyText("src/hooks/reply-judge.js#132"),
    caseyText("src/hooks/reply-judge.js#133"),
    caseyText("src/hooks/reply-judge.js#134", [[missingFacts.length ? '"farewell-gap"' : null, consentOwed ? '"consent-not-asked"' : null, clarifyOwed ? '"clarify-not-asked"' : null].filter(Boolean).join(', ') || caseyText("src/hooks/reply-judge.js#s12")]),
    caseyText("src/hooks/reply-judge.js#135"),
    caseyText("src/hooks/reply-judge.js#136"),
    caseyText("src/hooks/reply-judge.js#137", [[
      missingFacts.length ? 'shape 9 "farewell-gap"' : null,
      (lastOutboundText || knownFacts.length) ? 'shape 10 "repeat-ask"' : null,
      'shape 11 "advice-given"', 'shape 12 "promise-made"',
      consentOwed ? 'shape 15 "consent-not-asked"' : null,
      clarifyOwed ? 'shape 16 "clarify-not-asked"' : null,
      consentAgreed ? 'shape 17 "consent-reask"' : null,
      (hadSuccessfulWrite === false && missingFacts.length && latestInbound) ? 'shape 18 "not-recorded"' : null,
    ].filter(Boolean).join(', ')]),
  ].filter(line => line !== null).join('\n')

  const norm = (t) => String(t ?? '').toLowerCase().replace(/[\u2018\u2019\u201c\u201d"'`]/g, '').replace(/\s+/g, ' ').trim()
  const haystack = norm(replyText)
  const ABSENCE = /farewell.?gap|consent.?not.?asked|clarify.?not.?asked/i
  async function pass() {
    let raw = ''
    for (let tryNo = 0; tryNo < 2 && !raw; tryNo++) {
      try { raw = ((await callLLM({ messages: [{ role: 'user', content: judgePrompt }], tools: [] }))?.content || '').toString().trim() } catch { raw = '' }
    }
    if (!raw) return null
    try {

      const match = raw.match(/\{[\s\S]*\}/)
      const parsed = JSON.parse(match ? match[0] : raw)
      return (Array.isArray(parsed.findings) ? parsed.findings : [])
        .map(f => ({ shape: String(f?.shape || '').trim(), quote: norm(f?.quote) }))
        .filter(f => f.shape && (ABSENCE.test(f.shape) || (f.quote.length >= 4 && haystack.includes(f.quote))))
        .map(f => f.shape)
    } catch { return null }
  }
  const [first, wrongLanguage] = await Promise.all([pass(), languageDiffers(callLLM, replyText, latestInbound, recordedLanguage)])
  const langReasons = wrongLanguage ? ['wrong-language'] : []
  const verdict = langReasons.length ? { clean: false, reasons: langReasons, category: 'other' } : { clean: true, reasons: [], category: null }
  if (first === null) return { ...verdict, fault: 'judge-unavailable' }
  if (!first.length) return verdict

  const second = await pass()

  const FIRST_PASS_ONLY = /farewell.?gap/i
  const agreed = [...new Set(first)].filter(w => FIRST_PASS_ONLY.test(w) || (second || []).some(x => x.toLowerCase() === w.toLowerCase()))
  const reasons = [...agreed, ...langReasons]
  return reasons.length ? { clean: false, reasons, category: 'other' } : { clean: true, reasons: [], category: null }
}

export async function languageDiffers(callLLM, replyText, latestInbound, recordedLanguage = '') {
  const msg = String(latestInbound || '').trim()
  if ((msg.match(/\p{L}/gu) || []).length < 3 || !String(replyText || '').trim()) return false
  const recorded = String(recordedLanguage || '').replace(/["\n]/g, ' ').slice(0, 40).trim()
  const prompt = [
    caseyText("src/hooks/reply-judge.js#138"),
    recorded ? caseyText("src/hooks/reply-judge.js#139", [recorded]) : null,
    caseyText("src/hooks/reply-judge.js#s13"), msg.slice(0, 500), '', caseyText("src/hooks/reply-judge.js#s14"), String(replyText).slice(0, 1500), '',
    caseyText("src/hooks/reply-judge.js#140"),
  ].filter(l => l !== null).join('\n')
  try {
    const raw = String((await callLLM({ messages: [{ role: 'user', content: prompt }], tools: [] }))?.content || '')
    const m = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(m ? m[0] : raw).same === false
  } catch { return false }
}
