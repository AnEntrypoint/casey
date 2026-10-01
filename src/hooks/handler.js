

import { makeAdmissionControl } from './admission.js'
import { runInboundTurn } from './inbound-turn.js'
import { resolveAdapter } from './delivery.js'

const CHANNEL_DEFAULT = { whatsapp: 'whatsapp', discord: 'discord', sim: 'sim' }

export function makeCaseHandler(store, { callLLM = null, llmStatus = null, autoRespond = true, log = console, notifyHandoff = null } = {}) {

  const admission = makeAdmissionControl({ log, store })
  const deps = { store, callLLM, llmStatus, autoRespond, log, notifyHandoff, admission }

  async function handleInboundOnce(platform, msg) {
    const channel = CHANNEL_DEFAULT[platform] || platform || 'other'
    const external_id = conversationKey(msg)
    const replyTo = replyTarget(msg)

    if (!msg.burstReplay && admission.isClaimed(external_id)) {
      log.info?.('[casey] skipping concurrent LLM turn, buffered for replay', { channel })
      msg.burstReplay = true
      admission.bufferBurst(external_id, msg, channel)
      return { to: replyTo, text: '', platform, skipped: true, buffered: true }
    }
    admission.claim(external_id)
    try {
      return await runInboundTurn(this, deps, { platform, msg, channel, external_id, replyTo })
    } finally {
      admission.release(external_id)
    }
  }

  async function handleInbound(platform, msg) {

    const adapter = resolveAdapter(this, platform)
    let result
    try {
      result = await handleInboundOnce.call(this, platform, msg)
    } finally {
      try { adapter?.stopTyping?.(replyTarget(msg)) } catch {  }
    }
    const external_id = conversationKey(msg)
    const next = admission.takeBuffered(external_id)
    if (next) {

      const tracked = this.gateway?.handleInbound || this.handleInbound
      if (typeof tracked !== 'function') {
        log.error?.('[casey] burst replay dropped: no tracked handleInbound on the bound receiver', { platform })
      } else {
        Promise.resolve(tracked.call(this, platform, next))
          .catch(e => log.error?.('[casey] burst replay failed', { error: e?.message || String(e) }))
      }
    }
    return result
  }

  handleInbound.isClaimed = (externalId) => admission.isClaimed(externalId)
  return handleInbound
}

export function conversationKey(msg) {
  const container = msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || ''
  const author = msg.from || ''
  if (container && author && container !== author) return `${container}:${author}`
  return container || author || 'unknown'
}

export function splitExternalId(externalId) {
  const parts = String(externalId || '').split(':')
  return { container: parts[0], author: parts[parts.length - 1] }
}

export function replyTarget(msg) {
  return msg.raw?.channel_id || msg.raw?.chatId || msg.chatId || msg.from || 'unknown'
}

export function caseDeliveryTarget(caseRow) {
  const ext = String(caseRow?.external_id || '')
  if ((caseRow?.channel || '') === 'discord' && ext.includes(':')) return splitExternalId(ext).container
  return ext
}
