export const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 }
export const DEFAULT_INTENTS = (1 << 9) | (1 << 12) | (1 << 15)
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_FETCH_TIMEOUT_MS = 10000
export const SEND_TIMEOUT_MS = 15000
export const RECONNECT_BASE_MS = 3000
export const RECONNECT_MAX_MS = 30000
export const RECONNECT_MAX_RETRIES = 8
export const RECONNECT_GIVEUP_RETRY_MS = 60 * 60 * 1000
export const TYPING_REFRESH_MS = 8000

export function contentTypeCategory(contentType) {
  const t = (contentType || '').split('/')[0]
  if (t === 'image' || t === 'audio' || t === 'video') return t
  return 'other'
}
