

import { tagList } from '../timestamp.js'

export const OPTED_OUT_TAG = 'opted-out'

export const RESERVED_TAG = /^(opted-out|needs-human|draft-pending|ai-offline|flagged-reply|dispatch-suggested|handed-off|health:|intake_mode:)/i

export function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '...' : s }

export function stripThinkingBlock(text) {
  if (!text) return text
  let out = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '')
  out = out.replace(/<think>[\s\S]*$/i, '')
  return out.trim()
}

export const CASE_REF_RE = /CASE-\d+-[a-z0-9]+/gi

export function sanitizeOutboundRef(text, realRef, extraAllowedRefs = []) {
  if (!text || !realRef) return { text, corrected: [] }
  const allowed = new Set([String(realRef).toLowerCase(), ...extraAllowedRefs.map(r => String(r).toLowerCase())])
  const corrected = []
  const fixed = String(text).replace(CASE_REF_RE, (tok) => {
    if (allowed.has(tok.toLowerCase())) return tok
    corrected.push(tok)
    return realRef
  })
  return { text: fixed, corrected }
}

export function stripChannelMarkup(text) {
  return (text || '')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#][!&]?\d+>/g, ' ')
    .replace(/^\s*@[\w.-]+\b/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function detectContactIntent(text) {
  const t = normalizeIntentText(text)
  if (t === 'stop') return 'stop'
  if (t === 'help') return 'help'
  return null
}

function normalizeIntentText(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function mergeTag(tags, tag) {
  const list = tagList({ tags })
  if (!list.includes(tag)) list.push(tag)
  return list.join(',')
}

export function dropTag(tags, ...names) {
  return tagList({ tags }).filter(t => !names.includes(t)).join(',')
}

export function canAgentAct(caseRow, action = 'reply') {
  const mode = caseRow?.autonomy || 'auto'
  if (mode === 'observe') return 'none'
  if (mode === 'assisted') return 'draft'
  return 'send'
}

export function stageNote(status) {
  return ({
    in_progress: 'Someone is looking at what you sent us now.',
    waiting:     'We are still busy with what you sent us. There is nothing you need to do for now.',
    resolved:    'What you sent us has been dealt with. If something is still wrong, just reply here.',
  })[status] || ''
}

