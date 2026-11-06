
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

export function saveMediaFile(dataDir, caseId, buffer, { mimeType = '', kind = 'file' } = {}) {
  const dir = path.join(dataDir, 'media', String(caseId))
  fs.mkdirSync(dir, { recursive: true })
  const ext = (mimeType.split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '') || 'bin'
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}-${kind}.${ext}`
  const full = path.join(dir, name)
  fs.writeFileSync(full, buffer)
  return `media/${caseId}/${name}`
}
