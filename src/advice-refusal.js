

import { toPlainChat } from './hooks/plain-text.js'
import { caseyText } from './deployment-text.js';

const MAX_CHARS = 420

export async function composeAdviceRefusal(callLLM, { inboundText = '', language = '' } = {}) {
  if (typeof callLLM !== 'function') return null
  const said = String(inboundText || '').replace(/<<(?:DATA|END)>>/g, '').slice(0, 400)
  const prompt = [
    caseyText("src/advice-refusal.js#0"),
    caseyText("src/advice-refusal.js#1", [language ? caseyText("src/advice-refusal.js#s0", [String(language).slice(0, 40)]) : '']),
    caseyText("src/advice-refusal.js#2"),
    caseyText("src/advice-refusal.js#3"),
    caseyText("src/advice-refusal.js#4"),
    `<<DATA>>`,
    said,
    `<<END>>`,
  ].join('\n')
  let out = ''
  try { out = toPlainChat(String((await callLLM({ messages: [{ role: 'user', content: prompt }], tools: [] }))?.content || '').trim()) }
  catch { return null }
  if (!out || out.length > MAX_CHARS || out.includes('?') || /\n\s*\n/.test(out)) return null
  return out
}
