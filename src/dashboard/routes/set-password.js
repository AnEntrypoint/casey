import { redeemSetupToken } from '../auth.js'

const WINDOW_MS = 15 * 60e3
const MAX_REQUESTS = 60
const MAX_FAILURES = 20
const buckets = new Map()

const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown'

function hit(req) {
  const now = Date.now()
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k)
  const ip = ipOf(req)
  let b = buckets.get(ip)
  if (!b || now - b.start > WINDOW_MS) { b = { start: now, requests: 0, failures: 0 }; buckets.set(ip, b) }
  b.requests++
  return b
}

const limited = (b) => b.requests > MAX_REQUESTS || b.failures >= MAX_FAILURES

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const MESSAGES = {
  invalid: 'This link is not valid. Ask your administrator for a new one.',
  expired: 'This link has expired. Ask your administrator for a new one.',
  short: 'Use at least 8 characters for your password.',
  mismatch: 'The two passwords do not match.',
  limited: 'Too many attempts. Wait a few minutes and try again.',
  unexpected: 'Something went wrong. Try again in a moment.',
}

function pageHtml({ token = '', error = '', done = false }) {
  const body = done
    ? '<h1>Password saved</h1><p>You can now sign in to the dashboard with your username and the new password.</p>'
    : `<h1>Set your password</h1>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/api/set-password">
<input type="hidden" name="token" value="${esc(token)}">
<label for="pw">New password (at least 8 characters)</label>
<input id="pw" type="password" name="new_password" minlength="8" required autocomplete="new-password">
<label for="pw2">Type it again</label>
<input id="pw2" type="password" name="new_password_confirm" minlength="8" required autocomplete="new-password">
<button type="submit">Save password</button>
</form>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Set your password</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#f4f6f9;color:#1a1f29}main{max-width:420px;margin:24px auto}label{display:block;margin-top:8px}input,button{display:block;width:100%;box-sizing:border-box;font:inherit;padding:10px;margin:6px 0 14px}button{min-height:44px}.err{color:#8a1c1c}</style></head><body><main>${body}</main></body></html>`
}

export function getSetPassword() {
  return (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    if (limited(hit(req))) return res.status(429).type('html').send(pageHtml({ error: MESSAGES.limited }))
    const done = req.query.done === '1'
    res.type('html').send(pageHtml({ done, token: String(req.query.token || '').slice(0, 200) }))
  }
}

export function postSetPassword({ store }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    const form = req.is('application/x-www-form-urlencoded')
    const token = String(req.body?.token || '').slice(0, 200)
    const password = String(req.body?.new_password || '')
    const confirm = req.body?.new_password_confirm
    const fail = (code, status = 400) => form
      ? res.status(status).type('html').send(pageHtml({ token, error: MESSAGES[code] }))
      : res.status(status).json({ error: MESSAGES[code], code })
    const b = hit(req)
    if (limited(b)) return fail('limited', 429)
    if (password.length < 8) return fail('short')
    if (confirm !== undefined && String(confirm) !== password) return fail('mismatch')
    try {
      const r = await redeemSetupToken(store, token, password)
      if (!r.ok) {
        if (r.reason !== 'short') b.failures++
        return fail(r.reason === 'short' ? 'short' : r.reason)
      }
      return form ? res.redirect(303, '/set-password?done=1') : res.json({ ok: true })
    } catch {
      return fail('unexpected', 500)
    }
  }
}
