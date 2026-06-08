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
// build step. The API is the contract; this page is the operator's whole world,
// so it carries the friendliness affordances: live search + status filter,
// non-blocking toasts (no alert()), empty/loading/connection states, relative
// timestamps, keyboard nav, a light/dark toggle, attention indicators, a
// shareable case deep-link, and a poll that pauses while you type so it never
// clobbers an in-progress edit. Every contact-controlled value still flows
// through esc() before it touches innerHTML.
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>casey - cases</title>
<link rel="stylesheet" href="/design/colors_and_type.css">
<link rel="stylesheet" href="/design/app-shell.css">
<link rel="stylesheet" href="/design/editor-primitives.css">
<style>
  :root{--bg:#0f1115;--fg:#e6e6e6;--panel:#11141a;--border:#262a33;--border-soft:#20242c;
        --muted:#9aa6b2;--faint:#6b7685;--accent:#3b6ea5;--accent-soft:#1b2430;--hover:#171a21;--danger:#5a2230}
  html[data-theme=light]{--bg:#f6f7f9;--fg:#1a1f29;--panel:#fff;--border:#d6dbe2;--border-soft:#e4e8ee;
        --muted:#5a6675;--faint:#8a94a3;--accent:#2f6fb0;--accent-soft:#e7f0fa;--hover:#eef1f5;--danger:#c0392b}
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--font-sans,system-ui);background:var(--bg);color:var(--fg)}
  .wrap{display:grid;grid-template-columns:360px 1fr;height:100vh}
  .list{border-right:1px solid var(--border);overflow:auto;display:flex;flex-direction:column;min-height:0}
  .detail{overflow:auto;padding:20px}
  .topbar{padding:10px 14px;border-bottom:1px solid var(--border-soft);position:sticky;top:0;background:var(--bg);z-index:2}
  .topbar h1{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
  .counts{font-size:11px;color:var(--muted);font-weight:400}
  .icon-btn{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;
        padding:3px 8px;cursor:pointer;margin:0;font-size:12px;line-height:1}
  .icon-btn:hover{background:var(--hover);color:var(--fg)}
  .icon-btn.active{background:var(--accent-soft);color:var(--fg);border-color:var(--accent)}
  .filters{display:flex;gap:6px}
  .filters input{flex:2}.filters select{flex:1}
  .caselist{overflow:auto;flex:1;min-height:0}
  .case{padding:12px 14px;border-bottom:1px solid var(--border-soft);cursor:pointer}
  .case:hover{background:var(--hover)}
  .case.active{background:var(--accent-soft)}
  .case .top{display:flex;align-items:center;gap:6px}
  .ref{font-weight:600}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto}
  .dot.attn{background:#d8a000}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:var(--border);margin-left:2px}
  .badge.high,.badge.urgent{background:var(--danger);color:#fff}
  .sub{font-size:12px;color:var(--muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .when{font-size:11px;color:var(--faint)}
  .ev{padding:8px 0 8px 10px;border-bottom:1px dashed var(--border-soft);font-size:13px;border-left:3px solid transparent}
  .ev.inbound{border-left-color:#3b6ea5}.ev.outbound{border-left-color:#2e8b57}
  .ev.note{border-left-color:#8a6d3b}.ev.action{border-left-color:#6a5acd}
  .ev.transition{border-left-color:#b07cc6}.ev.observation{border-left-color:#7a8290}
  .ev .k{display:inline-block;min-width:120px;color:#8aa0c0;font-size:11px}
  label{display:block;margin:8px 0 2px;font-size:12px;color:var(--muted)}
  .hint{font-size:11px;color:var(--faint);margin:2px 0 0}
  input,select,textarea{width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px}
  button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;margin-top:8px}
  button:disabled{opacity:.55;cursor:default}
  .row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
  .empty{padding:20px 16px;color:var(--faint);font-size:13px;line-height:1.5}
  .conn{display:none;background:var(--danger);color:#fff;font-size:12px;padding:5px 14px;text-align:center}
  .conn.show{display:block}
  #toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:50;max-width:340px}
  .toast{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--accent);
        border-radius:6px;padding:9px 12px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer}
  .toast.err{border-left-color:var(--danger)}.toast.ok{border-left-color:#2e8b57}
  .copy{background:transparent;color:var(--faint);border:0;cursor:pointer;padding:0 4px;margin:0;font-size:12px}
  .copy:hover{color:var(--fg)}
  @media(max-width:720px){
    .wrap{grid-template-columns:1fr}
    .wrap.detail-open .list{display:none}
    .wrap:not(.detail-open) .detail{display:none}
    .back{display:inline-block}
  }
  .back{display:none}
  /* --- plain-words help overlay + per-case "what to do now" hint --- */
  .help-ovl{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:none;
        align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px}
  .help-ovl.show{display:flex}
  .help-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
        max-width:560px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.45);font-size:14px;line-height:1.55}
  .help-card h2{margin:0 0 4px;font-size:18px}
  .help-card h3{margin:16px 0 4px;font-size:14px;color:var(--fg)}
  .help-card p{margin:6px 0;color:var(--muted)}
  .help-card .lead{color:var(--fg)}
  .help-card ul{margin:6px 0;padding-left:18px;color:var(--muted)}
  .help-card li{margin:4px 0}
  .help-card .swatch{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d8a000;vertical-align:middle;margin-right:4px}
  .help-card .foot{font-size:12px;color:var(--faint);margin-top:10px}
  .icon-btn.active{background:var(--accent-soft);color:var(--fg);border-color:var(--accent)}
  .todo{background:var(--accent-soft);border:1px solid var(--border);border-left:3px solid var(--accent);
        border-radius:6px;padding:9px 12px;margin:10px 0 14px;font-size:13px;color:var(--fg);line-height:1.5}
</style></head>
<body>
<div id="conn" class="conn">Connection lost - retrying...</div>
<div class="wrap" id="wrap">
  <div class="list">
    <div class="topbar">
      <h1>casey <span class="counts" id="counts"></span>
        <button class="icon-btn" id="help" title="What does this screen mean?" style="margin-left:auto">?</button>
        <button class="icon-btn" id="refresh" title="Refresh now">&#x21bb;</button>
        <button class="icon-btn" id="theme" title="Toggle light/dark">&#x263d;</button>
        <button class="icon-btn" id="simple" title="Plain-language mode: show friendly stage names">Aa</button>
      </h1>
      <div class="filters">
        <input id="q" placeholder="Search ref, subject, contact... ( / )" autocomplete="off">
        <select id="statusf"><option value="">all stages</option></select>
      </div>
    </div>
    <div class="caselist" id="cases"><div class="empty">Loading cases...</div></div>
  </div>
  <div class="detail" id="detail"><p class="empty">Select a case to observe, edit, reply, or override its workflow stage.</p></div>
</div>
<div class="help-ovl" id="help-ovl">
  <div class="help-card">
    <h2>Welcome to casey</h2>
    <p class="lead">casey watches your messages on WhatsApp and Discord and helps you answer them. Here is what this screen shows you, in plain words.</p>
    <h3>What is each row?</h3>
    <p>Each row on the left is one person who messaged you, and the whole story of what they need. Click a row to open it.</p>
    <h3>What is the yellow dot?</h3>
    <p><span class="swatch"></span> A yellow dot means this one is waiting for a person. casey will not answer it on its own. Open it, read it, and reply.</p>
    <h3>The buttons when you open one</h3>
    <ul>
      <li><b>How urgent</b> - mark how important it is, so you know what to do first.</li>
      <li><b>Who answers</b> - choose who replies to the person: casey on its own, casey writes a draft for you to send, or only you (casey just listens).</li>
      <li><b>Reply to contact</b> - type a message and send it to the person yourself.</li>
      <li><b>Change the stage</b> - move it along by hand, like marking it Done. The person is not told.</li>
    </ul>
    <h3>How do I answer someone?</h3>
    <p>Open the row. Scroll to <b>Reply to contact</b>, type your message, and press <b>Send reply</b>. The person gets it on WhatsApp or Discord.</p>
    <p class="hint">Tip: the <b>Aa</b> button at the top turns on plain-language labels everywhere.</p>
    <button id="help-close">Got it</button>
    <p class="foot">You can open this help again any time with the <b>?</b> button at the top.</p>
  </div>
</div>
<div id="toasts"></div>
<script type="module">
const $ = (s,r=document)=>r.querySelector(s)
// Escape contact-supplied content before it enters innerHTML. Every value that
// originates from a message (subject/summary/tags/external_id/event text) is
// attacker-controlled, so it is escaped here, not trusted. Every render path
// below -- list, search results, timeline, deep-link restore -- goes through esc.
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// --- plain-language / simple mode ---
// Maps the workflow's technical stage names to friendly labels for low-literacy
// operators. simple mode is a view-only relabel: the real status value still
// flows through the API unchanged, so transitions/filters keep working. Reuse
// esc() on every label before it hits innerHTML, same as raw stage names.
let simple = false
const STAGE_LABEL = { new:'New', triaging:'Looking into it', in_progress:'Working on it',
  waiting:'Waiting', resolved:'Done', closed:'Closed' }
// stageLabel(s): friendly label in simple mode, raw stage name otherwise.
function stageLabel(s){ return simple ? (STAGE_LABEL[s] || s) : s }
// Carry the ?token= through every API call so the auth gate passes. Kept out of
// the visible URL hash so deep-links can be shared without leaking the secret.
const TOKEN = new URLSearchParams(location.search).get('token')
const api = (url,opts={})=>{
  const sep = url.includes('?')?'&':'?'
  const u = TOKEN ? url+sep+'token='+encodeURIComponent(TOKEN) : url
  return fetch(u,opts)
}
// --- toasts (replace alert): ok auto-dismisses, err persists until clicked ---
function toast(msg,kind='ok'){
  const el=document.createElement('div'); el.className='toast '+kind; el.textContent=msg
  el.onclick=()=>el.remove(); $('#toasts').appendChild(el)
  if(kind!=='err') setTimeout(()=>el.remove(),3500)
  return el
}
async function failMsg(r,fallback){ try{return (await r.json()).error||fallback}catch{return fallback} }
// --- relative time, absolute on hover ---
function toDate(v){ if(v==null||v==='')return null
  const d=(typeof v==='number'||/^\\d+$/.test(String(v)))?new Date(Number(v)*1000):new Date(v); return isNaN(d)?null:d }
function rel(v){ const d=toDate(v); if(!d)return ''
  const s=Math.round((Date.now()-d.getTime())/1000)
  if(s<45)return 'just now'; if(s<90)return '1m ago'
  const m=Math.round(s/60); if(m<45)return m+'m ago'
  const h=Math.round(m/60); if(h<36)return h+'h ago'
  return Math.round(h/24)+'d ago' }
function fmtTime(v){ const d=toDate(v); return d?d.toLocaleString():'' }

let activeId = null, lastCasesJson = '', allCases = [], known = new Set()
let editing = false                         // pause polling while operator types
let connDown = false, firstLoad = true
const filt = { q:'', status:'' }

function attn(c){ return c.autonomy==='observe' || c.autonomy==='assisted' }
function matches(c){
  if(filt.status && c.status!==filt.status) return false
  if(!filt.q) return true
  const hay=(c.ref+' '+(c.subject||'')+' '+(c.summary||'')+' '+(c.external_id||'')+' '+c.channel).toLowerCase()
  return hay.includes(filt.q.toLowerCase())
}
function renderCounts(){
  const by={}; for(const c of allCases) by[c.status]=(by[c.status]||0)+1
  const a=allCases.filter(attn).length
  $('#counts').textContent = allCases.length+' total'+(a?' - '+a+' need attention':'')
}
function renderList(){
  const shown = allCases.filter(matches)
  if(!allCases.length){ $('#cases').innerHTML='<div class="empty">No cases yet.<br>Run <code>casey sim</code> or connect a channel to create one.</div>'; return }
  if(!shown.length){ $('#cases').innerHTML='<div class="empty">No cases match your filter.</div>'; return }
  $('#cases').innerHTML = shown.map(c=>\`
    <div class="case \${c.id===activeId?'active':''}" data-id="\${esc(c.id)}">
      <div class="top">\${attn(c)?'<span class="dot attn" title="needs attention (autonomy: '+esc(c.autonomy)+')"></span>':''}
        <span class="ref">\${esc(c.ref)}</span><span class="badge \${esc(c.priority)}">\${esc(c.priority)}</span>
        <span class="when" style="margin-left:auto" title="\${esc(fmtTime(c.updated_at||c.created_at))}">\${esc(rel(c.updated_at||c.created_at))}</span></div>
      <div class="sub">\${esc(c.channel)} - \${esc(stageLabel(c.status))} - \${esc(c.subject||'(no subject)')}</div>
    </div>\`).join('')
  document.querySelectorAll('.case').forEach(el=>el.onclick=()=>openCase(el.dataset.id))
}
function fillStatusFilter(){
  const cur=$('#statusf').value
  const stages=[...new Set(allCases.map(c=>c.status))].sort()
  const allLabel = simple ? 'all stages (everything)' : 'all stages'
  $('#statusf').innerHTML='<option value="">'+esc(allLabel)+'</option>'+stages.map(s=>\`<option value="\${esc(s)}"\${s===cur?' selected':''}>\${esc(stageLabel(s))}</option>\`).join('')
}
function setConn(down){
  if(down===connDown) return; connDown=down; $('#conn').classList.toggle('show',down)
}
async function loadCases(){
  if(editing) return                        // never clobber an in-progress edit
  let resp
  try{ resp = await api('/api/cases?limit=200').then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ setConn(true); return }
  setConn(false)
  const cases = resp.cases || []
  const json = JSON.stringify(cases.map(c=>[c.id,c.ref,c.priority,c.channel,c.status,c.subject,c.autonomy,c.updated_at]))
  // notice genuinely-new cases (after first load) so an idle operator sees work
  if(!firstLoad){ const fresh=cases.filter(c=>!known.has(c.id)); if(fresh.length) toast(fresh.length+' new case'+(fresh.length>1?'s':'')) }
  for(const c of cases) known.add(c.id)
  firstLoad=false
  if(json===lastCasesJson){ // counts/rel-time may still drift; cheap refresh of relative labels
    document.querySelectorAll('.case .when').forEach(()=>{}); return }
  lastCasesJson = json; allCases = cases
  fillStatusFilter(); renderCounts(); renderList()
}
function opt(val,cur){ return \`<option\${val===cur?' selected':''}>\${esc(val)}</option>\` }
const AUTONOMY_HELP = 'auto = agent replies on its own - assisted = agent drafts, human sends - observe = agent only logs, never replies'
// Plain-words "what to do now" line, picked from the case state. The first
// matching rule wins so the most action-needed state shows. Derives purely from
// enum-safe c.status / c.autonomy.
function todoHint(c){
  if(c.status==='closed') return 'This one is finished. Nothing to do.'
  if(c.status==='resolved') return 'This one is marked done. Close it if you are finished.'
  if(c.autonomy==='observe') return 'This one is waiting for you. Read it and reply, or set Who answers to auto so casey can answer.'
  if(c.autonomy==='assisted') return 'casey prepared a reply but waits for a person. Check it, then send.'
  if(c.status==='waiting') return 'Waiting on the person to reply. Nothing to do until they answer.'
  if(c.status==='new'||c.status==='triaging') return 'A new message came in. casey is sorting it out.'
  return 'casey is handling this one on its own. Step in only if you need to.'
}
async function openCase(id){
  activeId = id
  // deep-link the open case in the hash only; the ?token= stays in the real
  // query string (location.search is preserved by replaceState's relative URL),
  // so the hash is shareable without leaking the secret.
  const wantHash='#case='+encodeURIComponent(id)
  if(location.hash!==wantHash) history.replaceState(null,'',location.pathname+location.search+wantHash)
  if($('#wrap')) $('#wrap').classList.add('detail-open')
  let data
  try{ data = await api('/api/cases/'+encodeURIComponent(id)).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ $('#detail').innerHTML='<p class="empty">Could not load this case.</p>'; return }
  const {case:c, events, transitions, events_total} = data
  const more = events_total!=null && events.length<events_total
  $('#detail').innerHTML = \`
    <button class="icon-btn back" id="back">&larr; cases</button>
    <h2 style="margin:6px 0 4px">\${esc(c.ref)} <span class="badge" title="\${esc(c.status)}">\${esc(stageLabel(c.status))}</span>
      <button class="copy" data-copy="\${esc(c.ref)}" title="copy ref">&#x2398;</button></h2>
    <div class="todo" id="todo-hint">\${esc(todoHint(c))}</div>
    <div style="color:var(--muted);margin-bottom:12px">\${esc(c.channel)}/\${esc(c.external_id)}
      <button class="copy" data-copy="\${esc(c.external_id)}" title="copy contact">&#x2398;</button></div>
    <div class="row">
      <div><label>Priority</label><select id="f-priority">\${['low','normal','high','urgent'].map(p=>opt(p,c.priority)).join('')}</select>\${simple?'<p class="hint">How urgent this is.</p>':''}</div>
      <div><label>Autonomy</label><select id="f-autonomy" title="\${esc(AUTONOMY_HELP)}">\${['auto','assisted','observe'].map(p=>opt(p,c.autonomy)).join('')}</select>\${simple?'<p class="hint">Who answers the contact: the robot, a draft for you, or nobody.</p>':''}</div>
      <div><label>Assignee</label><input id="f-assignee" value="\${esc(c.assignee||'')}"></div>
    </div>
    <p class="hint">\${esc(AUTONOMY_HELP)}</p>
    <label>Subject</label><input id="f-subject" value="\${esc(c.subject||'')}">
    <label>Tags</label><input id="f-tags" value="\${esc(c.tags||'')}">
    <label>Summary</label><textarea id="f-summary" rows="3">\${esc(c.summary||'')}</textarea>
    <button id="save">Save edits</button>
    <div style="margin-top:14px"><label>\${simple?'Change the stage':'Override workflow stage'}</label>
      \${simple?'<p class="hint">Move this case to a new stage. The contact is not told.</p>':''}
      \${transitions.map(t=>\`<button class="trans" data-to="\${esc(t)}" title="\${esc(t)}" style="background:#2a3340">-&gt; \${esc(stageLabel(t))}</button>\`).join(' ')||'<span class="hint">no transitions available</span>'}
    </div>
    <div style="margin-top:14px"><label>Reply to contact on \${esc(c.channel)}</label>
      <textarea id="f-reply" rows="2" placeholder="Send a message as a human operator... (Ctrl+Enter to send)"></textarea>
      <button id="send-reply">Send reply</button>
    </div>
    <h3 style="margin:18px 0 6px">Timeline\${events_total!=null?\` (\${events.length}/\${events_total})\`:''}</h3>
    <div id="timeline">\${renderEvents(events)}</div>
    \${more?'<button id="more-events" style="background:#2a3340">Load older events</button>':''}
  \`
  // pause polling while any field is focused so a refresh can't wipe the edit;
  // resume on blur. A blur fallback guarantees we never get stuck paused.
  $('#detail').querySelectorAll('input,select,textarea').forEach(el=>{
    el.addEventListener('focus',()=>{editing=true})
    el.addEventListener('blur',()=>{editing=false})
  })
  const back=$('#back'); if(back) back.onclick=()=>{ $('#wrap').classList.remove('detail-open') }
  $('#detail').querySelectorAll('.copy').forEach(b=>b.onclick=()=>{
    try{ navigator.clipboard.writeText(b.dataset.copy); toast('copied') }catch{ toast('copy failed','err') } })
  $('#save').onclick = async ()=>{
    const btn=$('#save'); btn.disabled=true
    const body = {subject:$('#f-subject').value, summary:$('#f-summary').value, priority:$('#f-priority').value, tags:$('#f-tags').value, assignee:$('#f-assignee').value, autonomy:$('#f-autonomy').value}
    const r = await api('/api/cases/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    btn.disabled=false; editing=false
    if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); return }
    toast('saved','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const send = async ()=>{
    const ta=$('#f-reply'), text=ta.value.trim(); if(!text) return
    const btn=$('#send-reply'); btn.disabled=true
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    btn.disabled=false; editing=false
    if(!r.ok){ toast(await failMsg(r,'send failed'),'err'); return }
    const j=await r.json().catch(()=>({})); ta.value=''
    toast(j.sent?'reply sent':'reply logged (channel not connected)','ok'); await openCase(id)
  }
  $('#send-reply').onclick = send
  $('#f-reply').addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); send() } })
  const moreBtn = $('#more-events')
  if(moreBtn) moreBtn.onclick = async ()=>{
    const off = events.length
    const older = await api('/api/cases/'+encodeURIComponent(id)+'/events?offset='+off).then(r=>r.json())
    $('#timeline').insertAdjacentHTML('beforeend', renderEvents(older.events||[]))
    if(!older.events||!older.events.length||off+older.events.length>=events_total) moreBtn.remove()
  }
  document.querySelectorAll('.trans').forEach(b=>b.onclick=async()=>{
    const toLabel = stageLabel(b.dataset.to)
    const reason = prompt('Reason for moving to "'+toLabel+'"? (optional)')
    if(reason===null) return                // operator cancelled
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/transition',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:b.dataset.to,reason:reason||undefined})})
    if(!r.ok){ toast(await failMsg(r,'transition failed'),'err'); return }
    toast('moved to '+toLabel,'ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  })
  renderList()                              // reflect the new active row
}
function renderEvents(events){
  return events.map(e=>\`<div class="ev \${esc(e.kind)}"><span class="k">\${esc(e.kind)}/\${esc(e.actor)}</span> \${esc(e.text||'')} <span class="when" title="\${esc(fmtTime(e.created_at))}">\${esc(rel(e.created_at))}</span></div>\`).join('')
}
// --- theme ---
function applyTheme(t){ document.documentElement.dataset.theme=t; try{localStorage.casey_theme=t}catch{}
  $('#theme').innerHTML = t==='light'?'&#x263c;':'&#x263d;' }
applyTheme((()=>{ try{return localStorage.casey_theme}catch{} })() || (matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'))
$('#theme').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light')
// --- plain-language / simple mode toggle (persisted like the theme) ---
function applySimple(on){ simple=!!on; try{localStorage.casey_simple=on?'1':''}catch{}
  $('#simple').classList.toggle('active',simple)
  $('#simple').title = simple ? 'Plain-language mode ON - click for technical stage names' : 'Plain-language mode: show friendly stage names'
  fillStatusFilter(); renderList(); if(activeId) openCase(activeId) }
applySimple((()=>{ try{return localStorage.casey_simple}catch{} })()==='1')
$('#simple').onclick=()=>applySimple(!simple)
// --- first-run help overlay (remembered in localStorage; re-openable via ? ) ---
let helpOpen = false
function helpSeen(){ try{ return localStorage.casey_help_seen==='1' }catch{ return false } }
function showHelp(){ helpOpen=true; $('#help-ovl').classList.add('show') }
function hideHelp(){ helpOpen=false; $('#help-ovl').classList.remove('show'); try{ localStorage.casey_help_seen='1' }catch{} }
$('#help').onclick = showHelp
$('#help-close').onclick = hideHelp
$('#help-ovl').addEventListener('click', e=>{ if(e.target===$('#help-ovl')) hideHelp() })
if(!helpSeen()) showHelp()
// --- filters ---
let qTimer
$('#q').addEventListener('input',e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ filt.q=e.target.value; renderList() },120) })
$('#statusf').addEventListener('change',e=>{ filt.status=e.target.value; renderList() })
$('#refresh').onclick=()=>{ lastCasesJson=''; loadCases() }
// --- keyboard nav: / focus search, j/k move, enter open, esc clear/back ---
document.addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
  if(e.key==='/' && !typing){ e.preventDefault(); $('#q').focus(); return }
  if(e.key==='Escape'){ if(helpOpen){hideHelp()} else if(typing){document.activeElement.blur()} else if($('#q').value){filt.q='';$('#q').value='';renderList()} return }
  if(typing) return
  if(e.key==='j'||e.key==='k'||e.key==='ArrowDown'||e.key==='ArrowUp'){
    const shown=allCases.filter(matches); if(!shown.length)return
    let i=shown.findIndex(c=>c.id===activeId)
    i = (e.key==='j'||e.key==='ArrowDown') ? Math.min(shown.length-1,i+1) : Math.max(0,i<0?0:i-1)
    openCase(shown[i].id)
    const el=document.querySelector('.case.active'); if(el)el.scrollIntoView({block:'nearest'})
  }
})
// --- deep-link restore + poll ---
function restoreFromHash(){ const m=/#case=([^&]+)/.exec(location.hash); if(m) return decodeURIComponent(m[1]) }
async function boot(){ await loadCases(); const id=restoreFromHash(); if(id) openCase(id) }
boot(); setInterval(loadCases, 5000)
window.__casey = { esc, rel, toast, loadCases, openCase, applyTheme,
  applySimple, stageLabel, STAGE_LABEL,
  get activeId(){return activeId}, get allCases(){return allCases}, get filt(){return filt},
  get editing(){return editing}, get simple(){return simple}, setFilter(q){filt.q=q;renderList()},
  // help overlay + per-case hint, exposed for browser-witness
  showHelp, hideHelp, helpSeen, todoHint, get helpOpen(){return helpOpen} }   // exposed for browser-witness
</script>
</body></html>`
