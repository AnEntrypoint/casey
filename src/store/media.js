// store/media.js  --  the on-disk half of media intake. No thatcher row, no
// case lookup: a buffer, a case id, and the store's dataDir are everything this
// needs, so it stays a pure filesystem function the store delegates to.

import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

// Persist a downloaded media buffer (photo/voice note) to <dataDir>/media/<caseId>/
// and return its path relative to dataDir. A photo/voice note is a one-shot
// artifact -- once the worker leaves the site it cannot be recaptured -- so the
// actual bytes are written to disk here rather than only ever noted as text
// ("farmer sent a photo" with no photo anywhere). Failure
// to write must never block the reply path -- callers catch and log, same
// discipline as appendReportField's own callers.
export function saveMediaFile(dataDir, caseId, buffer, { mimeType = '', kind = 'file' } = {}) {
  const dir = path.join(dataDir, 'media', String(caseId))
  fs.mkdirSync(dir, { recursive: true })
  const ext = (mimeType.split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '') || 'bin'
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}-${kind}.${ext}`
  const full = path.join(dir, name)
  fs.writeFileSync(full, buffer)
  // Forward slashes always -- this value is embedded in a /media/<path> URL
  // (dashboard/server.js), not just used for a local fs.join, so a Windows
  // backslash join here would break the link on the very platform that produced it.
  return `media/${caseId}/${name}`
}
