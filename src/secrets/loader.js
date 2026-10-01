// secrets/loader.js -- reads the bot's secrets from Google Secret Manager, at PINNED versions, and fails closed.
//
// No cryptography here: Secret Manager encrypts at rest, the client library talks TLS, and credentials come from the
// platform (application default credentials from the VM's metadata server). There are no key files.
//
// The manifest names WHERE each secret lives and never holds a value, so it is safe to keep in plain config:
//   { "project": "my-project", "secrets": { "WHATSAPP_API_TOKEN": { "secret": "uhh-whatsapp-api-token", "version": "3" }, ... } }
// `version` must be a number: "latest" is refused unless allowLatest is set, because a pinned version is what makes a rotation
// a deliberate, reversible step (change the number, restart; change it back to roll back).
//
// FAIL CLOSED. Any entry that cannot be read, or reads empty, makes loadSecrets throw ONE error that names the environment
// variables that failed and a numeric status code, never a value and never the provider's message. Nothing is partially
// applied: the caller gets every secret or none. Values live only in the returned object; secrets-exec.mjs puts them in the
// child's environment and drops them.
const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$|^[0-9]{6,20}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/

export class SecretsError extends Error {
  constructor(message, failed = []) { super(message); this.name = 'SecretsError'; this.failed = failed }
}

export function validateManifest(m, { allowLatest = false } = {}) {
  if (!m || typeof m !== 'object') throw new SecretsError('secrets manifest is not an object')
  if (!PROJECT_ID.test(String(m.project || ''))) throw new SecretsError('secrets manifest has no valid "project"')
  const entries = Object.entries(m.secrets || {})
  if (!entries.length) throw new SecretsError('secrets manifest lists no secrets')
  const bad = []
  for (const [env, spec] of entries) {
    const okVersion = /^[1-9][0-9]{0,8}$/.test(String(spec?.version || '')) || (allowLatest && spec?.version === 'latest')
    if (!ENV_NAME.test(env) || !SECRET_ID.test(String(spec?.secret || '')) || !okVersion) bad.push(env)
  }
  if (bad.length) throw new SecretsError(`secrets manifest entries are invalid (name, secret id or pinned version): ${bad.join(', ')}`, bad)
  return entries.map(([env, spec]) => ({ env, secret: spec.secret, version: String(spec.version) }))
}

async function defaultClient() {
  let mod
  try { mod = await import('@google-cloud/secret-manager') }
  catch { throw new SecretsError('the @google-cloud/secret-manager package is not installed') }
  return new mod.SecretManagerServiceClient()
}

// -> { env: { NAME: value }, names: [NAME, ...] }. `client` is injectable (a fake in the checks).
export async function loadSecrets(manifest, { client = null, allowLatest = false } = {}) {
  const list = validateManifest(manifest, { allowLatest })
  const c = client || await defaultClient()
  const results = await Promise.all(list.map(async ({ env, secret, version }) => {
    try {
      const [res] = await c.accessSecretVersion({ name: `projects/${manifest.project}/secrets/${secret}/versions/${version}` })
      const raw = res?.payload?.data
      const value = (Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw ?? '')).replace(/[\r\n]+$/, '')
      return value ? { env, value } : { env, code: 'empty' }
    } catch (e) {
      return { env, code: Number.isFinite(Number(e?.code)) ? Number(e.code) : 'error' }
    }
  }))
  const failed = results.filter(r => r.value === undefined)
  if (failed.length) throw new SecretsError(`could not load ${failed.length} secret(s): ${failed.map(f => `${f.env} (${f.code})`).join(', ')}`, failed.map(f => f.env))
  return { env: Object.fromEntries(results.map(r => [r.env, r.value])), names: results.map(r => r.env) }
}
