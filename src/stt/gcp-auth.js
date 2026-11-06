import { SttError, STT_FAILURE } from './errors.js'

const metadataHost = () => process.env.GCE_METADATA_HOST || 'metadata.google.internal'
let token = null
let project = null

async function metadata(path, timeoutMs) {
  let r
  try {
    r = await fetch(`http://${metadataHost()}/computeMetadata/v1/${path}`, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) { throw new SttError(STT_FAILURE.AUTH, `metadata server unreachable: ${e.message}`) }
  if (!r.ok) throw new SttError(STT_FAILURE.AUTH, `metadata server answered ${r.status} for ${path}`)
  return r
}

export async function accessToken(timeoutMs = 5000) {
  if (token && token.expiresAt - 60000 > Date.now()) return token.value
  const j = await (await metadata('instance/service-accounts/default/token', timeoutMs)).json()
  if (!j?.access_token || !Number(j.expires_in)) throw new SttError(STT_FAILURE.AUTH, 'metadata server returned no access token')
  token = { value: j.access_token, expiresAt: Date.now() + Number(j.expires_in) * 1000 }
  return token.value
}

export async function projectId(timeoutMs = 5000) {
  if (project) return project
  project = (await (await metadata('project/project-id', timeoutMs)).text()).trim()
  if (!project) throw new SttError(STT_FAILURE.AUTH, 'metadata server returned no project id')
  return project
}

export function resetGcpAuthCache() { token = null; project = null }
