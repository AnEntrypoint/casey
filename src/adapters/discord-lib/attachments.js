import { fetchWithTimeout } from '../webhook-platform-base.js'
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_FETCH_TIMEOUT_MS, contentTypeCategory } from './constants.js'
import { caseyText } from '../../deployment-text.js';

export async function fetchAttachment(self, a) {
  if (a.size > MAX_ATTACHMENT_BYTES) {
    console.error(caseyText("src/adapters/discord-lib/attachments.js#w0", [a.filename, a.size, MAX_ATTACHMENT_BYTES]))
    return null
  }
  try {
    const res = await fetchWithTimeout(a.url, {}, ATTACHMENT_FETCH_TIMEOUT_MS)
    if (!res.ok) throw new Error(`attachment fetch failed with status ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return { type: contentTypeCategory(a.content_type), mimeType: a.content_type || '', buffer, filename: a.filename }
  } catch (err) {
    console.error(caseyText("src/adapters/discord-lib/attachments.js#w1", [a.filename]), err)
    return null
  }
}
