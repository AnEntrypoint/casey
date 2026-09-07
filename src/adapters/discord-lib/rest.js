// Discord REST call internals for DiscordAdapter: outbound message send and
// typing-indicator management.
import { fetchWithTimeout, verifiedSend } from '../webhook-platform-base.js'
import { SEND_TIMEOUT_MS, TYPING_REFRESH_MS } from './constants.js'

export async function send(self, reply) {
  if (!self.token) throw new Error('DiscordAdapter: token required')
  const url = `${self.api}/channels/${reply.to}/messages`
  // Verify actual delivery: a non-2xx Discord response (bad token, missing
  // permission, unknown channel/404) still returns a JSON body but with no
  // message `id` -- checking only res.ok would treat that as a real send.
  const checked = (sendFn) => verifiedSend(sendFn, (body) => body?.id, 'DiscordAdapter')
  // Optional audio attachment: raw bytes go as a multipart file so the
  // reporter hears a voice reply. A text-only reply keeps the original
  // JSON POST byte-for-byte -- audio is purely additive.
  const a = reply.audio
  if (a && a.data_base64) {
    const ext = /mpeg|mp3/.test(a.mime || '') ? 'mp3' : /wav/.test(a.mime || '') ? 'wav' : 'ogg'
    const fd = new FormData()
    fd.append('payload_json', JSON.stringify({ content: reply.text || '' }))
    fd.append('files[0]', new Blob([Buffer.from(a.data_base64, 'base64')], { type: a.mime || 'audio/ogg' }), `reply.${ext}`)
    return checked(() => fetchWithTimeout(url, { method: 'POST', headers: { authorization: `Bot ${self.token}` }, body: fd }, SEND_TIMEOUT_MS))
  }
  return checked(() => fetchWithTimeout(url, { method: 'POST', headers: { authorization: `Bot ${self.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: reply.text }) }, SEND_TIMEOUT_MS))
}

// Trigger Discord's "X is typing..." indicator for a channel. Discord's own
// indicator expires ~10s after a single POST, so a caller wanting it shown
// for the duration of a slow operation must call this repeatedly -- see
// startTyping()/stopTyping() below, which do that for you.
export async function triggerTyping(self, channelId) {
  if (!self.token) throw new Error('DiscordAdapter: token required')
  try {
    const res = await fetchWithTimeout(`${self.api}/channels/${channelId}/typing`, { method: 'POST', headers: { authorization: `Bot ${self.token}` } }, SEND_TIMEOUT_MS)
    if (!res.ok && res.status !== 204) self.log?.warn?.('[discord] triggerTyping non-ok response', { channelId, status: res.status })
  } catch (e) {
    // Typing is a best-effort UX affordance, never load-bearing: a failed
    // POST must never throw into a caller's turn-handling path.
    self.log?.warn?.('[discord] triggerTyping failed', { channelId, error: e.message })
  }
}

// Keep the typing indicator alive for channelId until stopTyping(channelId)
// is called. Idempotent per channel (a second startTyping while one is
// already running for the same channel is a no-op, not a second timer).
export function startTyping(self, channelId) {
  if (self._typingTimers.has(channelId)) return
  triggerTyping(self, channelId)
  const timer = setInterval(() => triggerTyping(self, channelId), TYPING_REFRESH_MS)
  if (timer.unref) timer.unref()
  self._typingTimers.set(channelId, { timer })
}

export function stopTyping(self, channelId) {
  const t = self._typingTimers.get(channelId)
  if (!t) return
  clearInterval(t.timer)
  self._typingTimers.delete(channelId)
}
