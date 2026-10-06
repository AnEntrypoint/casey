import path from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'

const SITE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' }

export function publicSiteDir(env = process.env) {
  const configured = env.CASEY_PUBLIC_SITE_DIR
  if (!configured) return null
  if (!path.isAbsolute(configured)) throw new Error('CASEY_PUBLIC_SITE_DIR must be an absolute path')
  const root = realpathSync(configured)
  if (!statSync(root).isDirectory()) throw new Error('CASEY_PUBLIC_SITE_DIR must be a directory')
  if (!statSync(path.join(root, 'index.html')).isFile()) throw new Error('CASEY_PUBLIC_SITE_DIR must contain index.html')
  return root
}

const hasDotSegment = (segments) => segments.some(s => s.startsWith('.'))

function requestedSegments(rawPath) {
  let decoded
  try { decoded = decodeURIComponent(rawPath) } catch { return null }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').slice(1)
  if (!segments.length || segments.some(s => s === '') || hasDotSegment(segments)) return null
  return segments
}

async function sendSiteFile(root, segments, res) {
  let real
  try { real = await realpath(path.join(root, ...segments)) } catch { return res.status(404).end() }
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return res.status(404).end()
  if (hasDotSegment(rel.split(path.sep))) return res.status(404).end()
  let info
  try { info = await stat(real) } catch { return res.status(404).end() }
  if (!info.isFile()) return res.status(404).end()
  res.sendFile(rel, { root, dotfiles: 'deny', cacheControl: false, headers: SITE_HEADERS }, (err) => {
    if (err && !res.headersSent) res.status(404).end()
  })
}

export function registerPublicSiteAssets(app, root) {
  app.use('/site', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').end()
    const segments = requestedSegments(req.path)
    if (!segments) return res.status(404).end()
    sendSiteFile(root, segments, res).catch(next)
  })
}

export function landingHandler(root, sendShell) {
  return (req, res, next) => {
    if (req.caseyAccount) return sendShell(req, res)
    sendSiteFile(root, ['index.html'], res).catch(next)
  }
}
