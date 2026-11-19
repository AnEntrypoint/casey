

import { defTool, str, boundCase } from './case-tools-shared.js'
import { addFeedback, listFeedback, MAX_TEXT } from './feedback.js'
import { fmtTimeSAST } from './format.js'
import { caseyText } from './deployment-text.js';

export function buildFeedbackTools(store) {
  return [
    defTool('case_feedback', 'cases',
      caseyText("src/case-tools-feedback.js#0"),
      { type: 'object', properties: { comment: str(caseyText("src/case-tools-feedback.js#1", [MAX_TEXT])), language: str(caseyText("src/case-tools-feedback.js#2")) }, required: ['comment'] },
      async ({ comment, language = '' }, ctx) => {
        const r = await addFeedback(store(), { from: ctx?.contact?.id || '', tier: ctx?.tier || 'reporter', lang: language, text: comment, caseId: boundCase(ctx).id || '', source: 'whatsapp' })
        if (r.ok) return { ok: true, saved: true, note: caseyText("src/case-tools-feedback.js#3") }
        return { ok: false, saved: false, note: r.reason === 'limit' ? caseyText("src/case-tools-feedback.js#4") : caseyText("src/case-tools-feedback.js#5") }
      }),
    defTool('team_feedback', 'cases',
      caseyText("src/case-tools-feedback.js#6"),
      { type: 'object', properties: { limit: { type: 'number', description: caseyText("src/case-tools-feedback.js#s0") } } },
      async ({ limit = 8 }) => {
        const s = store()
        const names = new Map()
        const nameOf = async (from) => {
          if (String(from).startsWith('login:')) return String(from).slice(6)
          if (!names.has(from)) { const c = await s.getContact(from).catch(() => null); const n = String(c?.display_name || '').trim(); names.set(from, n && !/^\+?[\d\s()-]{6,}$/.test(n) ? n : 'a reporter') }
          return names.get(from)
        }
        const out = await listFeedback(s, { limit: Math.min(Math.max(Number(limit) || 8, 1), 25), nameOf })
        return {
          total: out.total,
          say: [
            caseyText("src/case-tools-feedback.js#s1", [out.total, out.total === 1 ? '' : 's']),
            ...out.by_week.slice(0, 4).map(w => caseyText("src/case-tools-feedback.js#s2", [w.week, w.count])),
            ...out.items.map(i => `${fmtTimeSAST(Math.floor(i.at / 1000))} ${i.from}${i.language ? ` (${i.language})` : ''}: ${i.text}`),
          ],
          note: caseyText("src/case-tools-feedback.js#7"),
        }
      }),
  ]
}
