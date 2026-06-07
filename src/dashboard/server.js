// dashboard/server.js -- casey's observe + manual-edit UI.
//
// Serves a small single-page app styled with anentrypoint-design's CSS, backed
// by a JSON API over the CaseStore. This is the human surface of casey:
//   - observe   read every case, open one, read its full timeline
//   - edit      change subject/summary/priority/tags/assignee/autonomy
//   - override  force any valid workflow transition as an operator
//   - reply     send a message to the contact on their channel as a human
//
// Everything written here goes through the same CaseStore the agent uses, so
// agent and operator share one timeline. The API is the operator-override
// surface, so an optional bearer token (CASEY_DASHBOARD_TOKEN) gates it.

import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESIGN_DIR = path.resolve(__dirname, '..', '..', 'node_modules', 'anentrypoint-design')

const OPERATOR = { id: 'dashboard-operator', role: 'operator' }
const PAGE_MAX = 200

// opts.token   shared secret; when set, /api and / require ?token= or Bearer header.
// opts.sendReply(caseRow, text) -> Promise; lets the operator reply on the channel.
export function createDashboard(store, { port = 4000, token = process.env.CASEY_DASHBOARD_TOKEN, sendReply = null } = {}) {
  const app = express()
  app.use(express.json())

  // Token gate (only when a token is configured). Accepts Authorization: Bearer
  // <token>, X-Casey-Token header, or ?token= query (for the page load).
  const authed = (req) => {
    if (!token) return true
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
    return bearer === token || req.get('x-casey-token') === token || req.query.token === token
  }
  app.use((req, res, next) => {
    if (req.path.startsWith('/design')) return next()
    if (authed(req)) return next()
    res.status(401).json({ error: 'unauthorized' })
  })

  app.use('/design', express.static(DESIGN_DIR))

  const clampLimit = (v, d) => Math.min(PAGE_MAX, Math.max(1, parseInt(v, 10) || d))
  const offsetOf = (v) => Math.max(0, parseInt(v, 10) || 0)

  app.get('/api/cases', async (req, res) => {
    try {
      const where = {}
      if (req.query.status) where.status = req.query.status
      const limit = clampLimit(req.query.limit, 50)
      const offset = offsetOf(req.query.offset)
      const cases = await store.listCases(where, { limit, offset })
      const total = await store.countCases(where)
      res.json({ cases, total, limit, offset })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/cases/:id', async (req, res) => {
    try {
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      const events_total = await store.countEvents(c.id)
      // newest window first by default; UI loads older via /events?offset=
      const limit = clampLimit(req.query.events_limit, 50)
      const events = await store.listEventsPage(c.id, { limit, offset: 0 })
      const transitions = store.availableTransitions(c, OPERATOR)
      res.json({ case: c, events, events_total, transitions })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.get('/api/cases/:id/events', async (req, res) => {
    try {
      const limit = clampLimit(req.query.limit, 50)
      const offset = offsetOf(req.query.offset)
      const events = await store.listEventsPage(req.params.id, { limit, offset })
      res.json({ events, offset, limit })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.patch('/api/cases/:id', async (req, res) => {
    try {
      const allowed = ['subject', 'summary', 'priority', 'tags', 'assignee', 'autonomy']
      const patch = {}
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no editable fields' })
      const updated = await store.updateCase(req.params.id, patch, OPERATOR)
      if (!updated) return res.status(404).json({ error: 'not found' })
      await store.appendEvent(req.params.id, { kind: 'action', actor: 'operator', text: `edited ${Object.keys(patch).join(', ')}`, data: patch })
      res.json(updated)
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.post('/api/cases/:id/transition', async (req, res) => {
    try {
      await store.transition(req.params.id, req.body.to, { user: OPERATOR, reason: req.body.reason || 'operator override' })
      res.json(await store.getCase(req.params.id))
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.post('/api/cases/:id/note', async (req, res) => {
    const text = (req.body.text || '').toString()
    if (!text.trim()) return res.status(400).json({ error: 'empty note' })
    await store.appendEvent(req.params.id, { kind: 'note', actor: 'operator', text })
    res.json({ ok: true })
  })

  // Operator takes over the conversation: send a message to the contact on
  // their channel and record it as an outbound event.
  app.post('/api/cases/:id/reply', async (req, res) => {
    try {
      const text = (req.body.text || '').toString().trim()
      if (!text) return res.status(400).json({ error: 'empty reply' })
      const c = await store.getCase(req.params.id)
      if (!c) return res.status(404).json({ error: 'not found' })
      if (sendReply) await sendReply(c, text)
      await store.appendEvent(c.id, { kind: 'outbound', actor: 'operator', channel: c.channel, text, data: { to: c.external_id } })
      res.json({ ok: true, sent: !!sendReply })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })

  app.get('/', (_req, res) => res.type('html').send(PAGE))

  const server = app.listen(port)
  return { app, server, port, close: () => new Promise(r => server.close(r)) }
}

// Self-contained page. Uses anentrypoint-design's CSS variables/typography for
// theming; the interactive shell is plain webjsx-flavoured DOM so it needs no
// build step. Kept deliberately small  --  the API is the contract.
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>casey - cases</title>
<link rel="stylesheet" href="/design/colors_and_type.css">
<link rel="stylesheet" href="/design/app-shell.css">
<link rel="stylesheet" href="/design/editor-primitives.css">
<style>
  body{margin:0;font-family:var(--font-sans,system-ui);background:var(--bg,#0f1115);color:var(--fg,#e6e6e6)}
  .wrap{display:grid;grid-template-columns:340px 1fr;height:100vh}
  .list{border-right:1px solid var(--border,#262a33);overflow:auto}
  .detail{overflow:auto;padding:20px}
  .case{padding:12px 16px;border-bottom:1px solid var(--border,#20242c);cursor:pointer}
  .case:hover{background:var(--bg-hover,#171a21)}
  .case.active{background:var(--accent-soft,#1b2430)}
  .ref{font-weight:600}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#2a2f3a;margin-left:6px}
  .badge.high,.badge.urgent{background:#5a2230}
  .ev{padding:8px 0;border-bottom:1px dashed #20242c;font-size:13px}
  .ev .k{display:inline-block;min-width:88px;color:#8aa0c0}
  h1{font-size:15px;margin:0;padding:14px 16px;border-bottom:1px solid #20242c}
  label{display:block;margin:8px 0 2px;font-size:12px;color:#9aa6b2}
  input,select,textarea{width:100%;background:#11141a;border:1px solid #262a33;color:#e6e6e6;border-radius:6px;padding:6px 8px;box-sizing:border-box}
  button{background:var(--accent,#3b6ea5);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;margin-top:8px}
  .row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
  .pill{display:inline-block;padding:2px 10px;border-radius:12px;background:#1b2430;font-size:12px;margin-right:6px}
</style></head>
<body>
<div class="wrap">
  <div class="list"><h1>casey cases</h1><div id="cases"></div></div>
  <div class="detail" id="detail"><p style="color:#677">Select a case.</p></div>
</div>
<script type="module">
const $ = (s,r=document)=>r.querySelector(s)
// Escape contact-supplied content before it enters innerHTML. Every value that
// originates from a message (subject/summary/tags/external_id/event text) is
// attacker-controlled, so it is escaped here, not trusted.
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// Carry the ?token= through every API call so the auth gate passes.
const TOKEN = new URLSearchParams(location.search).get('token')
const api = (url,opts={})=>{
  const sep = url.includes('?')?'&':'?'
  const u = TOKEN ? url+sep+'token='+encodeURIComponent(TOKEN) : url
  return fetch(u,opts)
}
let activeId = null
let lastCasesJson = ''
async function loadCases(){
  const resp = await api('/api/cases').then(r=>r.json())
  const cases = resp.cases || []
  const json = JSON.stringify(cases.map(c=>[c.id,c.ref,c.priority,c.channel,c.status,c.subject]))
  if(json===lastCasesJson) return        // no change -> no re-render, no flicker
  lastCasesJson = json
  $('#cases').innerHTML = cases.map(c=>\`
    <div class="case \${c.id===activeId?'active':''}" data-id="\${esc(c.id)}">
      <div><span class="ref">\${esc(c.ref)}</span><span class="badge \${esc(c.priority)}">\${esc(c.priority)}</span></div>
      <div style="font-size:12px;color:#9aa6b2">\${esc(c.channel)} - \${esc(c.status)} - \${esc(c.subject||'')}</div>
    </div>\`).join('') || '<p style="padding:16px;color:#677">No cases yet.</p>'
  document.querySelectorAll('.case').forEach(el=>el.onclick=()=>openCase(el.dataset.id))
}
function opt(val,cur){ return \`<option\${val===cur?' selected':''}>\${esc(val)}</option>\` }
async function openCase(id){
  activeId = id
  const {case:c, events, transitions, events_total} = await api('/api/cases/'+encodeURIComponent(id)).then(r=>r.json())
  const more = events_total!=null && events.length<events_total
  $('#detail').innerHTML = \`
    <h2 style="margin:0 0 4px">\${esc(c.ref)} <span class="badge">\${esc(c.status)}</span></h2>
    <div style="color:#9aa6b2;margin-bottom:12px">\${esc(c.channel)}/\${esc(c.external_id)}</div>
    <div class="row">
      <div><label>Priority</label><select id="f-priority">\${['low','normal','high','urgent'].map(p=>opt(p,c.priority)).join('')}</select></div>
      <div><label>Autonomy</label><select id="f-autonomy">\${['auto','assisted','observe'].map(p=>opt(p,c.autonomy)).join('')}</select></div>
      <div><label>Assignee</label><input id="f-assignee" value="\${esc(c.assignee||'')}"></div>
    </div>
    <label>Subject</label><input id="f-subject" value="\${esc(c.subject||'')}">
    <label>Tags</label><input id="f-tags" value="\${esc(c.tags||'')}">
    <label>Summary</label><textarea id="f-summary" rows="3">\${esc(c.summary||'')}</textarea>
    <button id="save">Save edits</button>
    <div style="margin-top:14px"><label>Override workflow stage</label>
      \${transitions.map(t=>\`<button class="trans" data-to="\${esc(t)}" style="background:#2a3340">-&gt; \${esc(t)}</button>\`).join(' ')||'<span style="color:#677">no transitions available</span>'}
    </div>
    <div style="margin-top:14px"><label>Reply to contact on \${esc(c.channel)}</label>
      <textarea id="f-reply" rows="2" placeholder="Send a message as a human operator..."></textarea>
      <button id="send-reply">Send reply</button>
    </div>
    <h3 style="margin:18px 0 6px">Timeline\${events_total!=null?\` (\${events.length}/\${events_total})\`:''}</h3>
    <div id="timeline">\${renderEvents(events)}</div>
    \${more?'<button id="more-events" style="background:#2a3340">Load older events</button>':''}
  \`
  $('#save').onclick = async ()=>{
    const body = {subject:$('#f-subject').value, summary:$('#f-summary').value, priority:$('#f-priority').value, tags:$('#f-tags').value, assignee:$('#f-assignee').value, autonomy:$('#f-autonomy').value}
    const r = await api('/api/cases/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    if(!r.ok){ alert((await r.json()).error||'save failed') }
    lastCasesJson=''; await loadCases(); await openCase(id)
  }
  $('#send-reply').onclick = async ()=>{
    const text = $('#f-reply').value.trim(); if(!text) return
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    if(!r.ok){ alert((await r.json()).error||'send failed') }
    await openCase(id)
  }
  const moreBtn = $('#more-events')
  if(moreBtn) moreBtn.onclick = async ()=>{
    const off = events.length
    const older = await api('/api/cases/'+encodeURIComponent(id)+'/events?offset='+off).then(r=>r.json())
    $('#timeline').insertAdjacentHTML('beforeend', renderEvents(older.events||[]))
    if(!older.events||!older.events.length||off+older.events.length>=events_total) moreBtn.remove()
  }
  document.querySelectorAll('.trans').forEach(b=>b.onclick=async()=>{
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/transition',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:b.dataset.to})})
    if(!r.ok){ alert((await r.json()).error||'transition failed') }
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
}
function fmtTime(v){
  if(v==null||v==='') return ''
  const d = (typeof v==='number' || /^\\d+$/.test(String(v))) ? new Date(Number(v)*1000) : new Date(v)
  return isNaN(d) ? '' : d.toLocaleString()
}
function renderEvents(events){
  return events.map(e=>\`<div class="ev"><span class="k">\${esc(e.kind)}/\${esc(e.actor)}</span> \${esc(e.text||'')} <span style="color:#556;font-size:11px">\${esc(fmtTime(e.created_at))}</span></div>\`).join('')
}
loadCases(); setInterval(loadCases, 5000)
window.__casey = { esc, loadCases, openCase, get activeId(){return activeId} }   // exposed for browser-witness
</script>
</body></html>`
