import { findAccountForLogin, issueSetupLink, SETUP_TTL_HOURS } from '../auth.js'
import { documentHtml, esc } from './set-password.js'

const WINDOW_MS = 15 * 60e3
const MAX_IP_REQUESTS = 10
const ACCOUNT_WINDOW_MS = 60 * 60e3
const MAX_ACCOUNT_REQUESTS = 3
const MAX_IDENTIFIER = 254

export const RESET_ACK = `If the details match an active account with an email address on file, a one-time link to set a new password has been sent to that address. The link works once and expires after ${SETUP_TTL_HOURS} hours.`

const MESSAGES = {
  limited: 'Too many requests. Wait a few minutes and try again.',
  missing: 'Enter your username, email address or phone number.',
  unexpected: 'Something went wrong. Try again in a moment.',
}

const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown'

function take(map, key, max, windowMs, now) {
  if (map.size > 5000) for (const [k, v] of map) if (now - v.start > windowMs) map.delete(k)
  let b = map.get(key)
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; map.set(key, b) }
  b.count++
  return b.count <= max
}

function forgotHtml({ notice = '', error = '' }) {
  const body = `<h1>Forgot your password?</h1>
<p>Enter your username or the email address on your account. If it matches an active account with an email address on file, we will send a link to set a new password.</p>
${notice ? `<p role="status">${esc(notice)}</p>` : ''}${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/api/password-reset/request">
<label for="who">Username, email address or phone number</label>
<input id="who" type="text" name="identifier" maxlength="${MAX_IDENTIFIER}" required autocomplete="username">
<button type="submit">Send me a link</button>
</form>
<p><a href="/">Back to sign in</a></p>`
  return documentHtml({ title: 'Forgot your password', body })
}

export function createPasswordReset({ store, issueLink = issueSetupLink, now = () => Date.now() }) {
  const ipBuckets = new Map()
  const accountBuckets = new Map()
  const jobs = new Set()

  const eligible = (acct) => Boolean(acct) && acct.disabled !== '1' && acct.status !== 'deleted' && Boolean(acct.email)

  function dispatch(acct) {
    const job = Promise.resolve()
      .then(() => issueLink(store, acct, ''))
      .catch(() => {})
      .finally(() => jobs.delete(job))
    jobs.add(job)
  }

  async function handle(req) {
    const ts = now()
    if (!take(ipBuckets, ipOf(req), MAX_IP_REQUESTS, WINDOW_MS, ts)) return { status: 429, code: 'limited' }
    const identifier = String(req.body?.identifier ?? '').trim()
    if (!identifier || identifier.length > MAX_IDENTIFIER) return { status: 400, code: 'missing' }
    const acct = await findAccountForLogin(store, identifier)
    const key = acct ? `acct:${acct.id}` : `who:${identifier.toLowerCase()}`
    const allowed = take(accountBuckets, key, MAX_ACCOUNT_REQUESTS, ACCOUNT_WINDOW_MS, ts)
    if (allowed && eligible(acct)) dispatch(acct)
    return { status: 200 }
  }

  function respond(res, form, r) {
    if (form) {
      const notice = r.status === 200 ? RESET_ACK : ''
      const error = r.status === 200 ? '' : MESSAGES[r.code] || MESSAGES.unexpected
      return res.status(r.status).type('html').send(forgotHtml({ notice, error }))
    }
    if (r.status === 200) return res.json({ ok: true, message: RESET_ACK })
    return res.status(r.status).json({ error: MESSAGES[r.code] || MESSAGES.unexpected, code: r.code })
  }

  return {
    getForgotPassword() {
      return (req, res) => {
        res.set('Cache-Control', 'no-store')
        res.set('Referrer-Policy', 'no-referrer')
        res.type('html').send(forgotHtml({}))
      }
    },
    postRequest() {
      return async (req, res) => {
        res.set('Cache-Control', 'no-store')
        res.set('Referrer-Policy', 'no-referrer')
        const form = req.is('application/x-www-form-urlencoded')
        let r
        try { r = await handle(req) } catch { r = { status: 500, code: 'unexpected' } }
        return respond(res, form, r)
      }
    },
    async drain() {
      await Promise.all([...jobs])
    },
  }
}
