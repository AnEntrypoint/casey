

import { defTool, str, boundCase } from './case-tools-shared.js'
import { addFeedback, listFeedback, MAX_TEXT } from './feedback.js'
import { fmtTimeSAST } from './format.js'

export function buildFeedbackTools(store) {
  return [
    defTool('case_feedback', 'cases',
      'Save what this person said about the assistant or the service itself (for example that replies are too long, that it was helpful, that something was confusing or slow). Use it ONLY when their message comments on you or the system, not when it describes an animal or a problem to report; in that case use the report tool as usual. It stores their comment on its own and never changes the report. Pass their own words, shortened if long, and no phone numbers. After it succeeds, thank them in one short line in their language and carry on with the conversation.',
      { type: 'object', properties: { comment: str(`Their comment about the assistant or service, in their own words (max ${MAX_TEXT} characters)`), language: str('The language they wrote it in, e.g. English, isiZulu, Afrikaans') }, required: ['comment'] },
      async ({ comment, language = '' }, ctx) => {
        const r = await addFeedback(store(), { from: ctx?.contact?.id || '', tier: ctx?.tier || 'reporter', lang: language, text: comment, caseId: boundCase(ctx).id || '', source: 'whatsapp' })
        if (r.ok) return { ok: true, saved: true, note: 'Saved. Thank them briefly and continue. This did not change their report.' }
        return { ok: false, saved: false, note: r.reason === 'limit' ? 'Enough feedback has been saved from this person today. Thank them warmly and continue; do not mention any limit.' : 'Nothing was saved because there was no comment. Continue the conversation.' }
      }),
    defTool('team_feedback', 'cases',
      'What testers and team members have said about the assistant itself, newest first, with simple counts by week. Use when the operator asks how the system is being received or what feedback came in. Names are shown, phone numbers never.',
      { type: 'object', properties: { limit: { type: 'number', description: 'How many comments (default 8, max 25)' } } },
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
            `${out.total} comment${out.total === 1 ? '' : 's'} so far.`,
            ...out.by_week.slice(0, 4).map(w => `Week of ${w.week}: ${w.count}`),
            ...out.items.map(i => `${fmtTimeSAST(Math.floor(i.at / 1000))} ${i.from}${i.language ? ` (${i.language})` : ''}: ${i.text}`),
          ],
          note: 'Give these to the operator as short plain lines, one per comment. No tables, no bullets, no asterisks.',
        }
      }),
  ]
}
