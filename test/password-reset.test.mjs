import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import express from 'express'

process.env.CASEY_CONFIG_DIR = fileURLToPath(new URL('./fixtures/config', import.meta.url))
const { createPasswordReset, RESET_ACK } = await import('../src/dashboard/routes/password-reset.js')
const { issueSetupToken, redeemSetupToken, SETUP_TTL_HOURS } = await import('../src/dashboard/auth.js')

const clone = (v) => structuredClone(v)

function fakeStore() {
  const tables = new Map()
  const rows = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name) }
  let seq = 0
  const locks = new Map()
  const t = {
    async list(table, filter = {}, { limit = 1000 } = {}) {
      return [...rows(table).values()]
        .filter(r => Object.entries(filter).every(([k, v]) => r[k] === v))
        .slice(0, limit).map(clone)
    },
    async get(table, id) { const r = rows(table).get(id); return r ? clone(r) : null },
    async create(table, data) {
      const r = { id: `${table}-${++seq}`, ...clone(data) }
      rows(table).set(r.id, r)
      return clone(r)
    },
    async update(table, id, patch) {
      const r = rows(table).get(id)
      if (!r) throw new Error(`no ${table} row ${id}`)
      Object.assign(r, clone(patch))
      return clone(r)
    },
  }
  const _withLock = (key, fn) => {
    const prev = locks.get(key) || Promise.resolve()
    const next = prev.then(fn, fn)
    locks.set(key, next.catch(() => {}))
    return next
  }
  return { t, _withLock, rows }
}

async function addAccount(store, fields) {
  return store.t.create('operator_account', {
    username: 'staff', password_hash: 'x', password_salt: 'y', display_name: 'Staff Member',
    role: 'operator', disabled: '0', must_change_password: '0', session_epoch: '3',
    email: 'staff@example.test', contact_phone: '', status: '', ...fields,
  })
}

function harness({ store, sent, issueLink } = {}) {
  const deliver = issueLink || (async (s, acct) => {
    const { token, expiresAt } = await issueSetupToken(s, acct.id)
    sent.push({ accountId: acct.id, token, expiresAt })
    return { status: 'sent', code: '', link: '' }
  })
  const reset = createPasswordReset({ store, issueLink: deliver })
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.get('/forgot-password', reset.getForgotPassword())
  app.post('/api/password-reset/request', reset.postRequest())
  return { app, reset }
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function post(base, body) {
  const res = await fetch(`${base}/api/password-reset/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

test('known and unknown identifiers get the same status and body, and only the known one is sent', async () => {
  const store = fakeStore()
  await addAccount(store, {})
  const sent = []
  const { app, reset } = harness({ store, sent })
  const srv = await listen(app)
  try {
    const known = await post(srv.base, { identifier: 'staff' })
    await reset.drain()
    const unknown = await post(srv.base, { identifier: 'nobody-here' })
    await reset.drain()
    const knownByEmail = await post(srv.base, { identifier: 'Staff@Example.test' })
    await reset.drain()
    assert.equal(known.status, 200)
    assert.deepEqual(known, unknown)
    assert.equal(knownByEmail.status, 200)
    assert.equal(knownByEmail.text, known.text)
    assert.equal(JSON.parse(known.text).message, RESET_ACK)
    assert.equal(sent.length, 2)
    assert.equal(known.text.includes('/set-password'), false)
    assert.equal(known.text.includes('token'), false)
  } finally { await srv.close() }
})

test('a disabled account, a deleted account and an account without email get no link, with the same response', async () => {
  const store = fakeStore()
  await addAccount(store, { username: 'off', disabled: '1' })
  await addAccount(store, { username: 'gone', status: 'deleted' })
  await addAccount(store, { username: 'phoneonly', email: '', contact_phone: '+27821234567' })
  const sent = []
  const { app, reset } = harness({ store, sent })
  const srv = await listen(app)
  try {
    const replies = []
    for (const identifier of ['off', 'gone', 'phoneonly', 'nobody']) replies.push(await post(srv.base, { identifier }))
    await reset.drain()
    assert.equal(sent.length, 0)
    for (const r of replies) assert.deepEqual(r, replies[0])
  } finally { await srv.close() }
})

test('the request never changes session_epoch or must_change_password', async () => {
  const store = fakeStore()
  const acct = await addAccount(store, { must_change_password: '0', session_epoch: '7' })
  const { app, reset } = harness({ store, sent: [] })
  const srv = await listen(app)
  try {
    await post(srv.base, { identifier: 'staff' })
    await reset.drain()
    const after = await store.t.get('operator_account', acct.id)
    assert.equal(after.session_epoch, '7')
    assert.equal(after.must_change_password, '0')
  } finally { await srv.close() }
})

test('per-IP limit answers 429 to every identifier once the window is spent', async () => {
  const store = fakeStore()
  await addAccount(store, {})
  const { app, reset } = harness({ store, sent: [] })
  const srv = await listen(app)
  try {
    const statuses = []
    for (let i = 0; i < 11; i++) statuses.push((await post(srv.base, { identifier: i % 2 ? 'staff' : 'nobody' })).status)
    await reset.drain()
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200))
    assert.equal(statuses[10], 429)
    const blocked = await post(srv.base, { identifier: 'staff' })
    assert.equal(blocked.status, 429)
  } finally { await srv.close() }
})

test('per-account limit stops sending after three requests but keeps the same response', async () => {
  const store = fakeStore()
  await addAccount(store, {})
  const sent = []
  const { app, reset } = harness({ store, sent })
  const srv = await listen(app)
  try {
    const replies = []
    for (let i = 0; i < 5; i++) replies.push(await post(srv.base, { identifier: 'staff' }))
    await reset.drain()
    assert.equal(sent.length, 3)
    for (const r of replies) assert.deepEqual(r, replies[0])
  } finally { await srv.close() }
})

test('a link is refused once its expiry has passed, and works once before that', async () => {
  const store = fakeStore()
  const acct = await addAccount(store, {})
  const sent = []
  const { app, reset } = harness({ store, sent })
  const srv = await listen(app)
  try {
    await post(srv.base, { identifier: 'staff' })
    await reset.drain()
    assert.equal(sent.length, 1)
    const { token, expiresAt } = sent[0]
    assert.equal(expiresAt - Date.now() > (SETUP_TTL_HOURS - 1) * 3600e3, true)
    const late = await redeemSetupToken(store, token, 'a-new-password', { now: expiresAt + 1 })
    assert.deepEqual(late, { ok: false, reason: 'expired' })
    const early = await redeemSetupToken(store, token, 'a-new-password', { now: expiresAt - 1000 })
    assert.equal(early.ok, true)
    assert.equal(early.account.id, acct.id)
    const again = await redeemSetupToken(store, token, 'a-new-password', { now: expiresAt - 1000 })
    assert.deepEqual(again, { ok: false, reason: 'invalid' })
  } finally { await srv.close() }
})

test('GET /forgot-password serves the form and an empty identifier is refused', async () => {
  const store = fakeStore()
  const { app } = harness({ store, sent: [] })
  const srv = await listen(app)
  try {
    const page = await fetch(`${srv.base}/forgot-password`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /action="\/api\/password-reset\/request"/)
    const empty = await post(srv.base, { identifier: '   ' })
    assert.equal(empty.status, 400)
  } finally { await srv.close() }
})
