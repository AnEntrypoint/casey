import { SttError, STT_FAILURE } from './errors.js'
import { caseyText } from '../deployment-text.js';

const metadataHost = () => process.env.GCE_METADATA_HOST || 'metadata.google.internal'
let token = null
let project = null

async function metadata(path) {
  let r
  try {
    r = await fetch(`http://${metadataHost()}/computeMetadata/v1/${path}`, { headers: { 'Metadata-Flavor': 'Google' } })
  } catch (e) { throw new SttError(STT_FAILURE.AUTH, caseyText("src/stt/gcp-auth.js#s0", [e.message])) }
  if (!r.ok) throw new SttError(STT_FAILURE.AUTH, caseyText("src/stt/gcp-auth.js#s1", [r.status, path]))
  return r
}

export async function accessToken() {
  if (token && token.expiresAt - 60000 > Date.now()) return token.value
  const j = await (await metadata('instance/service-accounts/default/token')).json()
  if (!j?.access_token || !Number(j.expires_in)) throw new SttError(STT_FAILURE.AUTH, caseyText("src/stt/gcp-auth.js#0"))
  token = { value: j.access_token, expiresAt: Date.now() + Number(j.expires_in) * 1000 }
  return token.value
}

export async function projectId() {
  if (project) return project
  project = (await (await metadata('project/project-id')).text()).trim()
  if (!project) throw new SttError(STT_FAILURE.AUTH, caseyText("src/stt/gcp-auth.js#s2"))
  return project
}

export function resetGcpAuthCache() { token = null; project = null }
