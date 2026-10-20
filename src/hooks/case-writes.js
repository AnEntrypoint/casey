

import { tagList } from '../timestamp.js'
import { mergeTag } from './heuristics.js'

export function observation(text, data) {
  return data ? { kind: 'observation', actor: 'system', text, data } : { kind: 'observation', actor: 'system', text }
}

export async function flagNeedsHuman({ store, log, caseRow, notifyHandoff, channel, from, extraTags = [], flagLabel, notifyLabel }) {
  const alreadyFlagged = tagList(caseRow).includes('needs-human')
  try {
    let tags = caseRow.tags
    for (const t of extraTags) tags = mergeTag(tags, t)
    await store.updateCase(caseRow.id, { tags: mergeTag(tags, 'needs-human') })
    if (notifyHandoff && !alreadyFlagged) {
      try { await notifyHandoff({ case: caseRow, channel, from }) }
      catch (e) { log.warn?.(`[casey] ${notifyLabel} notify failed`, { caseId: caseRow.id, error: e.message }) }
    }
  } catch (e) { log.warn?.(`[casey] ${flagLabel} flag failed`, { caseId: caseRow.id, error: e.message }) }
}

export async function raiseOperatorItem({ store, log, caseId, code, level = 'warn', fields = {} }) {
  log?.[level]?.(`[casey] ${code}`, { code, caseId, ...fields })
  try {
    const caseRow = await store.getCase(caseId)
    if (caseRow) await flagNeedsHuman({ store, log, caseRow, flagLabel: code, notifyLabel: code })
  } catch {
    log?.error?.(`[casey] ${code} operator item not raised`, { code, caseId })
  }
}
