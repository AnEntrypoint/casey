// Attachment-fetch internals for DiscordAdapter's inbound MESSAGE_CREATE path.
import { fetchWithTimeout } from '../webhook-platform-base.js'
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_FETCH_TIMEOUT_MS, contentTypeCategory } from './constants.js'

export async function fetchAttachment(self, a) {
  if (a.size > MAX_ATTACHMENT_BYTES) {
    console.error(`DiscordAdapter: skipping attachment ${a.filename} (${a.size} bytes exceeds ${MAX_ATTACHMENT_BYTES} byte guard)`)
    return null
  }
  try {
    const res = await fetchWithTimeout(a.url, {}, ATTACHMENT_FETCH_TIMEOUT_MS)
    if (!res.ok) throw new Error(`attachment fetch failed with status ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return { type: contentTypeCategory(a.content_type), mimeType: a.content_type || '', buffer, filename: a.filename }
  } catch (err) {
    console.error(`DiscordAdapter: attachment fetch failed for ${a.filename}`, err)
    return null
  }
}
