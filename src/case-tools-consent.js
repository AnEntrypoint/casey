// case-tools-consent.js -- case_consent: the person's answer to "is that okay?".
//
// The MODEL reads the answer in any language and calls this; nothing here reads a message or
// matches a word. In REPORT_ONLY_TOOLS (case-tools-gates.js) so every tier has it, though only a
// public contact on a deployment that sets persona.consentText is ever asked (phone-consent.js).
// Appended after case-tools-speaker.js in case-tools.js, so the earlier tools' pinned order holds.

import { defTool } from './case-tools-shared.js'
import { boundCase } from './case-tools-shared.js'
import { recordConsent, consentState } from './phone-consent.js'

export function buildConsentTools(store) {
  return [
    defTool('case_consent', 'cases',
      `Record the person's answer to your question about keeping what they tell you. Call it ONLY after you asked, in your own words, whether it is okay for the team to keep what they send, and they answered: agreed true when they said yes, in any language or wording; agreed false when they said no. Never call it on a guess, on silence, or because they reported something; a report is not a yes. Until it has been called with agreed true, case_report will not write anything.`,
      {
        type: 'object',
        properties: { agreed: { type: 'boolean', description: 'True if they said it is okay, false if they said it is not' } },
        required: ['agreed'],
      },
      async ({ agreed } = {}, ctx) => {
        if (typeof agreed !== 'boolean') return { ok: false, note: 'Say whether they agreed or not, and only after they have answered.' }
        const bound = boundCase(ctx)
        const contactId = ctx?.contact?.id
        if (!bound.id || !contactId) return { ok: false, note: 'Nothing could be recorded from here. Carry on with the conversation.' }
        const s = store()
        if (await consentState(s, contactId, { caseId: bound.id }) === (agreed ? 'agreed' : 'declined')) return { ok: true, already: true, note: 'That answer is already recorded. Carry on.' }
        await recordConsent(s, bound.id, agreed)
        return agreed
          ? { ok: true, note: 'Recorded. Now write down, with case_report, everything they have already told you in this chat, then carry on as usual. Do not ask again.' }
          : { ok: true, note: 'Recorded. Nothing will be written down. Tell them kindly, in their language and one or two sentences, that nothing will be kept and that they can come back any time, and offer to let a person from the team help them (case_handoff) if they want that.' }
      },
    ),
  ]
}
