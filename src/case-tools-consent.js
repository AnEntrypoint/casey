

import { defTool } from './case-tools-shared.js'
import { boundCase } from './case-tools-shared.js'
import { recordConsent, consentState, repliedBefore } from './phone-consent.js'
import { caseyText } from './deployment-text.js';

export function buildConsentTools(store) {
  return [
    defTool('case_consent', 'cases',
      caseyText("src/case-tools-consent.js#0"),
      {
        type: 'object',
        properties: {
          agreed: { type: 'boolean', description: caseyText("src/case-tools-consent.js#1") },
          volunteered: { type: 'boolean', description: caseyText("src/case-tools-consent.js#2") },
        },
        required: ['agreed'],
      },
      async ({ agreed, volunteered } = {}, ctx) => {
        if (typeof agreed !== 'boolean') return { ok: false, note: caseyText("src/case-tools-consent.js#3") }
        const bound = boundCase(ctx)
        const contactId = ctx?.contact?.id
        if (!bound.id || !contactId) return { ok: false, note: caseyText("src/case-tools-consent.js#4") }
        const s = store()

        if (!(volunteered === true && agreed === true) && !(await repliedBefore(s, contactId, { caseId: bound.id }))) return { ok: false, note: caseyText("src/case-tools-consent.js#5") }
        if (await consentState(s, contactId, { caseId: bound.id }) === (agreed ? 'agreed' : 'declined')) return { ok: true, already: true, note: caseyText("src/case-tools-consent.js#6") }
        await recordConsent(s, bound.id, agreed)
        return agreed
          ? { ok: true, note: caseyText("src/case-tools-consent.js#7") }
          : { ok: true, note: caseyText("src/case-tools-consent.js#8") }
      },
    ),
  ]
}
