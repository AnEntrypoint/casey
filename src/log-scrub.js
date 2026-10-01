// log-scrub.js -- redacts secrets from everything the process writes to stdout and stderr.
//
// Two layers, both cheap string work (no cryptography):
//   1. every environment variable whose NAME ends in KEY / TOKEN / SECRET / PASSWORD (value 8+ characters) is registered
//      by value, and any occurrence of that exact value is replaced with [REDACTED:NAME] (longest first);
//   2. token-shaped strings are replaced whatever their source: Meta access tokens (EAA...), "Bearer ..." / "Bot ..."
//      authorization values, Discord bot tokens, and `sha256=<64 hex>` signatures.
// installLogScrub() wraps process.stdout.write and process.stderr.write once, so console.log, the structured logger and
// crash output all pass through it. Limit: a secret split across two separate write() calls is not caught (the loggers write
// whole lines).
const NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASS)$/
const PATTERNS = [
  [/\bEAA[A-Za-z0-9]{20,}\b/g, '[REDACTED:meta-token]'],
  [/\b(Bearer|Bot)\s+[A-Za-z0-9._~+\/=-]{16,}/gi, '$1 [REDACTED]'],
  [/\b[MN][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}\b/g, '[REDACTED:discord-token]'],
  [/\bsha256=[0-9a-f]{64}\b/gi, 'sha256=[REDACTED]'],
]
const values = new Map()   // value -> NAME

export function registerSecretValue(name, value) {
  const v = String(value ?? '')
  if (v.length >= 8) values.set(v, String(name || 'secret'))
}

export function registerEnvSecrets(env = process.env) {
  for (const [k, v] of Object.entries(env)) if (NAME_RE.test(k) && typeof v === 'string') registerSecretValue(k, v)
}

export function redact(text) {
  let s = String(text)
  if (!s) return s
  for (const v of [...values.keys()].sort((a, b) => b.length - a.length)) {
    if (s.includes(v)) s = s.split(v).join(`[REDACTED:${values.get(v)}]`)
  }
  for (const [re, to] of PATTERNS) s = s.replace(re, to)
  return s
}

let installed = false
export function installLogScrub({ env = process.env } = {}) {
  registerEnvSecrets(env)
  if (installed) return
  installed = true
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream)
    stream.write = (chunk, encoding, cb) => {
      if (typeof chunk === 'string') return orig(redact(chunk), encoding, cb)
      if (chunk instanceof Uint8Array) return orig(redact(Buffer.from(chunk).toString('utf8')), typeof encoding === 'string' ? encoding : undefined, typeof encoding === 'function' ? encoding : cb)
      return orig(chunk, encoding, cb)
    }
  }
}
