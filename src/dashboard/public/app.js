const $ = (s,r=document)=>r.querySelector(s)
// Escape contact-supplied content before it enters innerHTML. Every value that
// originates from a message (subject/summary/tags/external_id/event text) is
// attacker-controlled, so it is escaped here, not trusted. Every render path
// below -- list, search results, timeline, deep-link restore -- goes through esc.
// Self-contained (no import mechanism in a plain static script): the server
// side aliases the shared anentrypoint-design/html-escape.js escapeHtml, but
// this file runs in the browser with no bundler, so it keeps its own
// byte-identical escaper.
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
// --- handoff notification: a contact asked for a human (needs-human tag) ---
// Fires ONCE per case (tracked in handoffSeen, persisted to localStorage so a
// reload does not re-nag). Pure client-side off the existing 5s poll: the tag is
// set server-side in gateway-hooks (intent==='human').
const hasHandoff = (c)=>String(c.tags||'').split(',').map(s=>s.trim()).includes('needs-human')
let handoffSeen = (()=>{ try{ return new Set(JSON.parse(localStorage.casey_handoff_seen||'[]')) }catch{ return new Set() } })()
function rememberHandoff(id){ handoffSeen.add(id); try{ localStorage.casey_handoff_seen=JSON.stringify([...handoffSeen].slice(-500)) }catch{} }
let handoffQueue = []                         // cases needing a human, freshest last
const baseTitle = document.title              // one source of truth
let titleFlip = false, titleTimer = null
// Steady-state title carries the inbox count so an operator sees it in the tab
// even when no handoff flash is running. flashTitle falls back to this (not the
// bare baseTitle) so the count and the flash do not race-erase each other.
let inboxCount = 0
function countTitle(){ return inboxCount>0 ? '('+inboxCount+') '+baseTitle : baseTitle }
function setInboxBadge(n){
  inboxCount = n||0
  if(!titleTimer) document.title = countTitle()   // flash owns the title while active
  try{ if(navigator.setAppBadge){ inboxCount>0 ? navigator.setAppBadge(inboxCount) : navigator.clearAppBadge() } }catch{}
}
function flashTitle(on){
  if(on){ if(titleTimer) return
    titleTimer=setInterval(()=>{ titleFlip=!titleFlip
      document.title = titleFlip ? (handoffQueue.length+' waiting for you') : countTitle() }, 1100) }
  else { clearInterval(titleTimer); titleTimer=null; document.title=countTitle() }
}
// Two-tone chime via WebAudio so there is no asset/dependency. try/catch because
// browsers block audio until the operator interacts; that silent failure must
// never break the visual alert.
function handoffSound(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx) return
    const ac=new Ctx(); const t=ac.currentTime
    ;[ [880,t,t+0.16], [1320,t+0.18,t+0.42] ].forEach(([f,s,e])=>{
      const o=ac.createOscillator(), g=ac.createGain()
      o.type='sine'; o.frequency.value=f
      g.gain.setValueAtTime(0.0001,s); g.gain.exponentialRampToValueAtTime(0.2,s+0.02)
      g.gain.exponentialRampToValueAtTime(0.0001,e)
      o.connect(g); g.connect(ac.destination); o.start(s); o.stop(e+0.02)
    })
    setTimeout(()=>{ try{ac.close()}catch{} }, 700)
  }catch{}
}
function renderHandoff(){
  const el=$('#handoff'); if(!el) return
  if(!handoffQueue.length){ el.classList.remove('show'); flashTitle(false); return }
  const c=handoffQueue[handoffQueue.length-1]
  const extra=handoffQueue.length>1 ? (' (and '+(handoffQueue.length-1)+' more)') : ''
  $('#handoff-msg').innerHTML='<b>Someone needs a person.</b> '+esc(c.ref)
    +' - '+esc(c.subject||c.external_id||c.channel)+esc(extra)+'. Click to open it.'
  el.classList.add('show'); flashTitle(true)
}
// Called from loadCases with the freshly polled cases.
function checkHandoffs(cases){
  for(const c of cases){
    if(!hasHandoff(c)) continue
    if(handoffSeen.has(c.id)) continue        // already alerted this case once
    rememberHandoff(c.id)
    if(handoffQueue.some(q=>q.id===c.id)) continue
    handoffQueue.push(c)
    if(!firstLoad){ handoffSound() }          // no chime for the backlog on first paint
  }
  // refresh subject text and drop resolved/closed handoffs
  handoffQueue = handoffQueue
    .map(q=>cases.find(c=>c.id===q.id)||q)
    .filter(q=>q.status!=='resolved' && q.status!=='closed')
  renderHandoff()
}
function clearHandoff(id){ handoffQueue=handoffQueue.filter(q=>q.id!==id); renderHandoff() }
// --- plain-language / simple mode ---
// Maps the workflow's technical stage names to friendly labels for low-literacy
// operators. simple mode is a view-only relabel: the real status value still
// flows through the API unchanged, so transitions/filters keep working. Reuse
// esc() on every label before it hits innerHTML, same as raw stage names.
let simple = false
const STAGE_LABEL = { new:'New', triaging:'Looking into it', in_progress:'Working on it',
  waiting:'Waiting', resolved:'Done', closed:'Closed' }
// stageLabel(s): friendly label in simple mode, raw stage name otherwise. A
// stage with no entry in STAGE_LABEL (e.g. a deployment-added workflow stage
// not in the shipped default set) degrades to its raw config name -- never
// hidden, just unlabeled.
function stageLabel(s){ return simple ? (STAGE_LABEL[s] || s) : s }
// Live workflow config, fetched once at boot from /api/config (see
// dashboard/server.js). Falls back to the shipped 6-stage default if the
// fetch fails (offline-first render) so the UI is never blank while waiting.
// This is what makes the bulk-move stage list and the "contact was notified"
// set track a deployment's actual thatcher.config.yml stages instead of a
// hardcoded literal that silently excludes an added/renamed stage.
let CASEY_STAGES = ['new','triaging','in_progress','waiting','resolved','closed']
let CASEY_NOTIFIED_STAGES = ['in_progress','waiting','resolved']
// case_type/priority enums are config-declared (thatcher.config.yml). The editor
// selects render from these live values (loaded from /api/config below), never a
// hardcoded literal -- so a deployment that adds a case_type/priority value gets
// it in the dropdown with no client change, matching the server-side accept set.
// The literals here are only the pre-load / no-config fallback.
let CASEY_CASE_TYPES = ['unset','outbreak','follow_up','lab_sample','import_alert']
let CASEY_PRIORITIES = ['low','normal','high','urgent']
// Locale defaults (South Africa) -- overridden from /api/config when the
// deployment sets CASEY_TZ/CASEY_TZ_LABEL/CASEY_COUNTRY_CODE server-side, so
// the SPA's own fmtTime/fmtPhone below track the same knobs as format.js
// instead of a second hardcoded 'Africa/Johannesburg'/'27'.
let CASEY_TZ = 'Africa/Johannesburg'
let CASEY_TZ_LABEL = 'SAST'
let CASEY_COUNTRY_CODE = '27'
async function loadCaseyConfig(){
  try{
    const r = await api('/api/config')
    if(!r.ok) return
    const j = await r.json()
    if(Array.isArray(j.stages) && j.stages.length) CASEY_STAGES = j.stages
    if(Array.isArray(j.case_type) && j.case_type.length) CASEY_CASE_TYPES = j.case_type
    if(Array.isArray(j.priority) && j.priority.length) CASEY_PRIORITIES = j.priority
    // Notified-on-move stays a UI convention (which moves are "worth telling the
    // contact about"), not itself config-declared -- keep the current default
    // set but intersected with the live stages so a removed/renamed stage name
    // can never linger in it.
    CASEY_NOTIFIED_STAGES = CASEY_NOTIFIED_STAGES.filter(s => CASEY_STAGES.includes(s))
    if(j.tz) CASEY_TZ = j.tz
    CASEY_TZ_LABEL = j.tz_label || ''
    if(j.country_code) CASEY_COUNTRY_CODE = j.country_code
  }catch{}
}
loadCaseyConfig()
// Auth is a session cookie now (HttpOnly, set by POST /api/login -- see
// dashboard/auth.js), not a bearer token in the URL/header. credentials:
// 'include' makes every fetch send it explicitly regardless of browser
// same-origin cookie defaults. currentUser is populated by checkSession()
// below and read by the login-gate at the bottom of this script.
let currentUser = null
const api = (url,opts={})=> fetch(url, Object.assign({ credentials: 'include' }, opts))
async function checkSession(){
  try{
    const r = await api('/api/whoami')
    const j = await r.json()
    currentUser = j.authed ? j : null
  }catch{ currentUser = null }
  return currentUser
}
async function doLogin(username, password){
  const r = await api('/api/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ username, password }) })
  if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error || 'login failed') }
  return checkSession()
}
async function doLogout(){
  try{ await api('/api/logout', { method:'POST' }) }catch{}
  currentUser = null
  location.reload()
}
// session-auth-hardening-revocation: self-service "log out everywhere" --
// revokes every OTHER outstanding session for the caller's own account (a
// lost/stolen device, a leaked cookie) via a session_epoch bump server-side,
// then reloads since the server already re-issued this tab's own cookie at
// the new epoch (see POST /api/logout-everywhere).
async function doLogoutEverywhere(){
  try{
    const r = await api('/api/logout-everywhere', { method:'POST' })
    if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error||'failed') }
  }catch(e){ toast('Could not log out other sessions: '+e.message, 'err'); return }
  toast('Logged out everywhere else. This device stays signed in.')
}
// Back-compat shim: every "who am I" check below (claim/mine/skills-key/owner-
// chip highlighting) was written against a self-picked selectedOperator
// variable from the old cooperative-attribution picker. It is now simply
// derived from the real logged-in session -- same read shape everywhere else
// in this script, zero call sites needed to change.
Object.defineProperty(window, 'selectedOperator', { get: () => currentUser ? currentUser.username : '' })
// --- toasts (replace alert): ok auto-dismisses, err persists until clicked ---
function toast(msg,kind='ok'){
  const el=document.createElement('div'); el.className='toast '+kind; el.textContent=msg
  el.onclick=()=>el.remove(); $('#toasts').appendChild(el)
  if(kind!=='err') setTimeout(()=>el.remove(),3500)
  return el
}
async function failMsg(r,fallback){ try{return (await r.json()).error||fallback}catch{return fallback} }
// ~15s actionable Undo toast after a reversible operator action (transition /
// claim / snooze). The server picks the most-recent undoable action itself, so the
// client only needs to POST /undo within the window; we do NOT track which action.
// A sent reply is NOT reversible -- replyUndoToast handles that separately.
function undoToast(id,label){
  const el=document.createElement('div'); el.className='toast ok undo-toast'
  const span=document.createElement('span'); span.textContent=label||'Done.'
  const btn=document.createElement('button'); btn.className='undo-btn'; btn.textContent='Undo'
  el.appendChild(span); el.appendChild(btn)
  $('#toasts').appendChild(el)
  let done=false
  const dismiss=()=>{ if(!el.parentNode) return; el.remove() }
  btn.onclick=async()=>{
    if(done) return; done=true; btn.disabled=true
    try{
      const r=await api('/api/cases/'+encodeURIComponent(id)+'/undo',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
      if(r.ok){ const j=await r.json().catch(()=>({})); toast(j.summary?('Undone -- '+j.summary):'Undone','ok'); lastCasesJson=''; await loadCases(); if(activeId===id) await openCase(id); refreshAttention() }
      else toast(await failMsg(r,'Nothing to undo (the window may have passed)'),'err')
    }catch(e){ toast('Undo error: '+e.message,'err') }
    dismiss()
  }
  setTimeout(dismiss,15000)
  return el
}
// A sent reply cannot be unsent (the contact already saw it). 'Undo' degrades to
// queuing a 'disregard my last message' correction and re-flagging needs-human so a
// person revisits it -- never a silent rewrite of what the contact received.
function replyUndoToast(id,channel){
  const el=document.createElement('div'); el.className='toast ok undo-toast'
  const span=document.createElement('span'); span.textContent='Reply sent.'
  const btn=document.createElement('button'); btn.className='undo-btn'; btn.textContent='Take it back'
  el.appendChild(span); el.appendChild(btn)
  $('#toasts').appendChild(el)
  let done=false
  btn.onclick=async()=>{
    if(done) return; done=true; btn.disabled=true
    const correction='Sorry, please disregard my last message.'
    try{
      const r=await api('/api/cases/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:correction})})
      if(r.ok){ await api('/api/cases/bulk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[id],action:'tag',tag:'needs-human'})}).catch(()=>{}); toast('Sent a correction and flagged this for a person -- a reply cannot be unsent.','ok'); lastCasesJson=''; await loadCases(); if(activeId===id) await openCase(id) }
      else toast(await failMsg(r,'Could not send the correction'),'err')
    }catch(e){ toast('Correction error: '+e.message,'err') }
    el.remove()
  }
  setTimeout(()=>el.remove(),15000)
  return el
}
// --- relative time, absolute on hover ---
function toDate(v){ if(v==null||v==='')return null
  const d=(typeof v==='number'||/^\d+$/.test(String(v)))?new Date(Number(v)*1000):new Date(v); return isNaN(d)?null:d }
// Assisted-mode held draft surfacing. A case is holding a draft only while it
// carries the draft-pending tag; the text is the latest kind:'draft' event.
function caseHasDraft(c){ return String(c&&c.tags||'').split(',').map(t=>t.trim()).includes('draft-pending') }
function latestDraft(events){ const d=(events||[]).filter(e=>e.kind==='draft'); return d.length?d[d.length-1]:null }
function draftText(c,events){ if(!caseHasDraft(c))return ''; const d=latestDraft(events); return d&&d.text||'' }
function draftBanner(c,events){
  if(!caseHasDraft(c)) return ''
  return '<div class="draft-banner" id="draft-banner">'
    +'<div class="draft-lab">AI drafted a reply -- review before it sends.</div>'
    +'<div class="draft-acts"><button id="draft-approve" class="draft-ok">Approve &amp; send</button>'
    +'<button id="draft-discard" class="draft-no">Discard</button></div></div>'
}
function rel(v){ const d=toDate(v); if(!d)return ''
  const s=Math.round((Date.now()-d.getTime())/1000)
  if(s<45)return 'just now'; if(s<90)return '1m ago'
  const m=Math.round(s/60); if(m<45)return m+'m ago'
  const h=Math.round(m/60); if(h<36)return h+'h ago'
  return Math.round(h/24)+'d ago' }
// Elapsed duration from a since_ms span -> 'Xh Ym' / 'Xm' / 'Xd Yh', for the
// inbox waiting timer. Distinct from rel() (which is "time ago" off a timestamp).
function waitFmt(ms){ const s=Math.max(0,Math.round(ms/1000)); const m=Math.floor(s/60)
  if(m<60) return m+'m'
  const h=Math.floor(m/60), rm=m%60; if(h<24) return rm? h+'h '+rm+'m' : h+'h'
  const d=Math.floor(h/24), rh=h%24; return rh? d+'d '+rh+'h' : d+'d' }
// Absolute time is shown in the deployment's configured timezone (South
// African Standard Time, UTC+2, no DST, by default) so an operator anywhere
// reads the same local time the field team works in, regardless of the
// browser's own timezone. CASEY_TZ/CASEY_TZ_LABEL (loaded from /api/config,
// see loadCaseyConfig above) override the zone/suffix for a non-SA deployment.
function fmtTime(v){ const d=toDate(v); if(!d)return ''
  const suffix = CASEY_TZ_LABEL ? ' '+CASEY_TZ_LABEL : ''
  try{ return d.toLocaleString('en-ZA',{timeZone:CASEY_TZ})+suffix }
  catch{ return d.toLocaleString()+suffix } }

// Show a phone number the way an operator expects: a WhatsApp MSISDN like
// 27821234567 becomes +27 82 123 4567; a local 0821234567 stays 082 123 4567.
// Non-phone external_ids (discord/sim ids) pass through unchanged. Display only --
// the raw external_id stays the key. CASEY_COUNTRY_CODE (default '27', South
// Africa) overrides the country prefix matched/shown for a non-SA deployment.
function fmtPhone(v){ const s=String(v||''); const digits=s.replace(/[^0-9]/g,'')
  const cc=CASEY_COUNTRY_CODE
  if(new RegExp('^'+cc+'[0-9]{9}$').test(digits)){ const n=digits.slice(cc.length); return '+'+cc+' '+n.slice(0,2)+' '+n.slice(2,5)+' '+n.slice(5) }
  if(/^0[0-9]{9}$/.test(digits)){ return digits.slice(0,3)+' '+digits.slice(3,6)+' '+digits.slice(6) }
  return s }

// Plain-language labels for the structured report fields, in the order an
// organiser most wants to read them. Missing fields are shown as "not given yet"
// so the operator sees the WHOLE picture (what is known and what is still
// outstanding), never a silently blank gap.
const REPORT_FIELDS=[
  ['species','Animals'],['symptoms','Signs'],['affected_count','How many affected'],
  ['dead_count','How many died'],['onset','When it started'],['suspected_disease','Suspected disease'],
  ['recent_movement','Recent movement'],['location','Where'],['how_to_find','How to find the place'],
  ['access_notes','Access / travel'],['farmer_available','Farmer available?'],
  ['contact_fallback','Other contact'],['identifying_traits','Identifying the animals'],
  ['photos','Photos'],['audio','Voice notes'],['notes','Other notes'],
  ['present_person','Who is with the animals'],['present_person_relation','Their link to the owner'],
  ['owner_name','Owner name'],['owner_contact','Owner contact'],
  ['language_detected','Language detected'],['sites','Other sites in this visit'],
]
// Fields a field visit genuinely needs that CANNOT be recovered once the worker
// leaves the site -- this is the one-shot reality. The readiness line tells the
// operator at a glance whether they can act on the report or should try to reach
// the farmer NOW (while perhaps still reachable) for the missing on-site facts.
const VISIT_CRITICAL=[
  ['species','what animals'],['symptoms','the signs'],['location','where'],
  ['how_to_find','how to find the place'],['farmer_available','if the farmer will be there'],
  ['contact_fallback','another contact'],
]
const has=(r,k)=>r[k]!=null&&String(r[k]).trim()!==''
// Derive per-field source labels from the action event log.
// Events with actor=agent and text containing 'recorded report fields' carry
// the field names that came from the AI conversation. Events with actor=operator
// carry fields set via the manual intake form. Returns a map of key -> 'ai'|'manual'|'both'.
function fieldSources(events){
  const src={}
  for(const e of (events||[])){
    if(e.kind!=='action') continue
    const isAgent=e.actor==='agent'
    const isOp=e.actor==='operator'
    if(!isAgent&&!isOp) continue
    // The action event text lists fields like "recorded report fields: species, symptoms"
    // or "updated report fields: location"
    const m=(e.text||'').match(/(?:recorded|updated) report fields?(?:[^:]*)?:[ ]*(.+)/i)
    if(!m) continue
    const keys=m[1].split(',').map(s=>s.trim()).filter(Boolean)
    for(const k of keys){
      if(isAgent) src[k]=src[k]==='manual'?'both':'ai'
      else src[k]=src[k]==='ai'?'both':'manual'
    }
  }
  return src
}
function sourceTag(s){
  if(!s) return ''
  if(s==='ai') return ' <span class="src-tag src-ai">[AI]</span>'
  if(s==='manual') return ' <span class="src-tag src-manual">[Manual]</span>'
  if(s==='both') return ' <span class="src-tag src-both">[Both]</span>'
  return ''
}
function fillPill(rfr){
  if(!rfr) return ''
  const cls = rfr.filled===rfr.total_fields?'ok':(rfr.visit_critical_filled<rfr.visit_critical_total?'low':'')
  return `<span class="fill-pill ${cls}" title="Essential fields: ${rfr.visit_critical_filled} of ${rfr.visit_critical_total}">${rfr.filled}/${rfr.total_fields} fields${rfr.visit_critical_filled<rfr.visit_critical_total?' ('+rfr.visit_critical_filled+'/'+rfr.visit_critical_total+' essential)':''}</span>`
}
// Build map of field -> [{text, created_at}] from note events with a field key
function fieldNotes(events){
  const notes={}
  for(const e of (events||[])){
    if(e.kind!=='note'||!e.data?.field) continue
    if(!notes[e.data.field]) notes[e.data.field]=[]
    notes[e.data.field].push({text:e.text,created_at:e.created_at})
  }
  return notes
}
function reportPanel(reportRaw, events){
  let r={}; try{ r=reportRaw?JSON.parse(reportRaw):{} }catch{ r={} }
  const src=fieldSources(events)
  const fnotes=fieldNotes(events)
  // If nothing has been gathered yet, a calm empty state -- not an empty box.
  const any=REPORT_FIELDS.some(([k])=>has(r,k))
  const missingVC=VISIT_CRITICAL.filter(([k])=>!has(r,k))
  const missing=missingVC.map(([,label])=>label)
  // Plain readiness line: green when a visit has what it needs, amber listing the
  // unrecoverable gaps. Clicking the amber banner opens the intake form.
  let ready=''
  if(any){
    ready = missing.length
      ? '<div class="rep-ready amber" id="vc-banner" title="Click to fill in the missing fields" style="cursor:pointer">Still missing for a visit: '+esc(missing.join(', '))+' - click to fill in</div>'
      : '<div class="rep-ready ok">Has what a field visit needs.</div>'
  }
  const rows=REPORT_FIELDS.map(([k,label])=>{
    const val=has(r,k)?esc(String(r[k]))+sourceTag(src[k]):'<span class="rep-missing">not given yet</span>'
    const noteList=(fnotes[k]||[]).map(n=>'<div class="rep-field-note">'+esc(n.text)+'</div>').join('')
    return '<div class="rep-row" data-field="'+esc(k)+'"><span class="rep-label">'+esc(label)+'</span><span class="rep-val"><span class="rep-editable" data-key="'+esc(k)+'" title="Click to edit">'+val+'</span><button class="rep-note-btn" data-key="'+esc(k)+'" title="Add a note to this field">note</button>'+noteList+'</span></div>'
  }).join('')
  // Source legend: only shown when at least one field has a src annotation
  const srcVals=Object.values(src)
  let srcLegend=''
  if(srcVals.length){
    const hasAI=srcVals.some(v=>v==='ai'||v==='both')
    const hasManual=srcVals.some(v=>v==='manual'||v==='both')
    const parts=[]
    if(hasAI) parts.push('<span class="src-tag src-ai">[AI]</span> collected by agent')
    if(hasManual) parts.push('<span class="src-tag src-manual">[Manual]</span> entered by operator')
    srcLegend='<div class="rep-src-legend">Fields from: '+parts.join('  ')+'</div>'
  }
  // Voice note banner: when report.audio is set, prompt operator to transcribe
  const audioVal=has(r,'audio')?String(r.audio).trim():''
  const audioBanner=audioVal&&audioVal.toLowerCase()!=='no'
    ?'<div class="rep-ready amber rep-audio-banner">Voice note on record: &ldquo;'+esc(audioVal)+'&rdquo; -- listen and update the fields below from what you hear.</div>'
    :''
  return '<div class="report"><div class="rep-head">Report from the field'
    +(any?'':' <span class="rep-missing">(nothing recorded yet)</span>')+'</div>'+srcLegend+ready+audioBanner+rows+'</div>'
}

let activeId = null, lastCasesJson = '', allCases = [], known = new Set()
let editing = false                         // pause polling while operator types
let connDown = false, firstLoad = true
const filt = { q:'', status:'' }

function attn(c){ return c.autonomy==='observe' || c.autonomy==='assisted'
  || String(c.tags||'').split(',').map(s=>s.trim()).includes('needs-human') }
// --- triage: which cases need a HUMAN now, and why, in plain words ---
// Scoring + reason live server-side in src/attn.js and reach the client ranked
// via GET /api/attention (over ALL open cases, not just the page window). The SPA
// no longer recomputes them -- renderTriage renders the server-ranked list, so the
// two surfaces cannot drift.
function tagList(c){ return String(c.tags||'').split(',').map(t=>t.trim()).filter(Boolean) }
// Light heuristic: does the contact's most recent inbound look like it is NOT
// plain English? We only flag the operator to mirror the contact's language --
// the agent already replies in-language; this is a nudge for HUMAN replies, where
// a low-literacy operator might default to English. Non-latin script or a few
// common non-English words trip it. False negatives are fine; this never blocks.
const NON_EN_WORDS = /\b(dankie|asseblief|hallo|goeie|siek|beeste|ngiyabonga|siyabonga|sawubona|izinkomo|usizo|enkosi|molo|nceda|iinkomo|dumela|kea leboha|dikgomo)\b/i
function contactMaybeNonEnglish(events){
  const lastIn = (events||[]).filter(e=>e.kind==='inbound').slice(-1)[0]
  const txt = lastIn && lastIn.text
  if(!txt) return false
  // Non-ASCII character (accented/non-latin script) or a common non-English word.
  for(let i=0;i<txt.length;i++){ if(txt.charCodeAt(i)>127) return true }
  return NON_EN_WORDS.test(txt)
}
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

// The inbox is the server-ranked /api/attention list (scored over ALL open cases
// in src/attn.js), NOT a client recompute over the page window -- so a high-urgency
// case beyond the 200-row loadCases cap still shows. Each entry carries its own
// ref/channel/subject/updated_at/reason/breaches; renderTriage never reaches into
// allCases for triage, so the two surfaces cannot drift.
let attentionInbox = []
// Focus / inbox mode: render ONLY the ranked attention list, skip the full
// ~200-row case poll, and quiet the background polls. Driven by the #inbox hash
// so the mode survives a reload and is deep-linkable.
let inboxMode = /(^|&)inbox(&|$)/.test((location.hash||'').replace(/^#/,''))
function renderTriage(){
  const el=$('#triage'); if(!el) return
  // In focus mode the attention list is the whole screen, so show every ranked
  // case; otherwise keep the compact 12-row peek above the full list.
  const ranked = mineOnly ? attentionInbox.filter(isMine) : attentionInbox
  const inbox = inboxMode ? ranked : ranked.slice(0,12)
  setInboxBadge(ranked.length)
  if(!inbox.length){
    el.innerHTML='<h2>Needs you now</h2>'+
      '<div class="calm">All caught up. Nothing needs a person right now. '+
      'A new one will show up here the moment someone needs you.</div>'
    return
  }
  el.innerHTML='<h2>Needs you now <span class="n">'+attentionInbox.length+'</span></h2>'+
    inbox.map(e=>{
      const breaches = e.breaches||[]
      const breachDetail = breaches.length ? ' -- '+breaches.map(b=>b.detail||b.breach).join('; ') : ''
      const heat = e.score>=8 ? 'heat-3' : e.score>=4 ? 'heat-2' : e.score>0 ? 'heat-1' : ''
      const ho = breaches.find(b=>b.breach==='unanswered_handoff'||b.breach==='unanswered_handoff_escalated')
      const waiting = ho && ho.since_ms ? '<span class="waiting">waiting '+waitFmt(ho.since_ms)+'</span>' : ''
      const owner = e.assignee && e.assignee!=='agent' ? e.assignee : ''
      const mine = owner && owner===selectedOperator
      const ownerChip = owner ? '<span class="owner-chip'+(mine?' mine':'')+'">'+(mine?'you':esc(owner))+'</span>' : ''
      const otherClaim = owner && !mine ? ' claimed-other' : ''
      return `
      <div class="tcase ${heat}${otherClaim} ${e.id===activeId?'active':''}" data-id="${esc(e.id)}" role="listitem" tabindex="0">
        <div class="why">${esc(e.reason||'This one is worth a look.')}${waiting}${ownerChip}${breachDetail?'<span class="breach-detail"> '+esc(breachDetail)+'</span>':''}</div>
        <div class="meta">${esc(e.ref)} - ${esc(e.channel)} - ${esc(e.subject||'(no subject)')} - ${esc(rel(e.updated_at))}</div>
      </div>`
    }).join('')
  el.querySelectorAll('.tcase').forEach(d=>d.onclick=()=>openCase(d.dataset.id))
}
async function refreshAttention(){
  try{
    const j = await api('/api/attention').then(r=>r.ok?r.json():null)
    if(!j) return
    attentionInbox = j.cases||[]
    renderTriage()
  }catch{ /* best-effort; a stale inbox is better than a blank one */ }
}
function fillStatusFilter(){
  const cur=$('#statusf').value
  const stages=[...new Set(allCases.map(c=>c.status))].sort()
  const allLabel = simple ? 'all stages (everything)' : 'all stages'
  $('#statusf').innerHTML='<option value="">'+esc(allLabel)+'</option>'+stages.map(s=>`<option value="${esc(s)}"${s===cur?' selected':''}>${esc(stageLabel(s))}</option>`).join('')
}
function setConn(down){
  if(down===connDown) return; connDown=down; $('#conn').classList.toggle('show',down)
}
async function loadCases(){
  if(editing) return                        // never clobber an in-progress edit
  let resp
  try{
    const params=new URLSearchParams({limit:'200'})
    if(filt.status) params.set('status',filt.status)
    if(filt.channel) params.set('channel',filt.channel)
    if(filt.q) params.set('q',filt.q)
    resp = await api('/api/cases?'+params.toString()).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() })
  }
  catch(e){ setConn(true); return }
  setConn(false)
  const cases = resp.cases || []
  const capEl=document.getElementById('cap-warn')
  if(resp.total>cases.length){
    if(!capEl){ const w=document.createElement('div'); w.id='cap-warn'
      w.style.cssText='background:rgba(200,140,0,.18);color:#9a6a00;font-size:12px;padding:5px 14px;text-align:center;border-bottom:1px solid rgba(200,140,0,.3)'
      w.textContent='Showing '+cases.length+' of '+resp.total+' cases. Use filters to find older ones.'
      document.getElementById('cases').before(w) }
  } else if(capEl){ capEl.remove() }
  const json = JSON.stringify(cases.map(c=>[c.id,c.ref,c.priority,c.channel,c.status,c.subject,c.autonomy,c.updated_at,c.fill_rate?.filled]))
  // notice genuinely-new cases (after first load) so an idle operator sees work
  if(!firstLoad){ const fresh=cases.filter(c=>!known.has(c.id)); if(fresh.length) toast(fresh.length+' new case'+(fresh.length>1?'s':'')) }
  checkHandoffs(cases)                         // detect needs-human, alert once per case
  for(const c of cases) known.add(c.id)
  firstLoad=false
  if(json===lastCasesJson){ // counts/rel-time may still drift; cheap refresh of relative labels
    document.querySelectorAll('.case .when').forEach(()=>{}); return }
  lastCasesJson = json; allCases = cases
  fillStatusFilter(); fillChannelFilter(); renderCounts(); renderListFull(); renderTriage()
}
function opt(val,cur){ return `<option${val===cur?' selected':''}>${esc(val)}</option>` }
const AUTONOMY_HELP = 'auto = agent replies on its own - assisted = agent drafts, human sends - observe = agent only logs, never replies'
// Plain-words "what to do now" line, picked from the case state. The first
// matching rule wins so the most action-needed state shows. Derives purely from
// enum-safe c.status / c.autonomy.
// Mirrors src/attn.js caseHints().todo policy -- same priority ladder and wording
// so the detail to-do line never diverges from the server. The client cannot
// import attn.js, so the ladder is inlined. ageHoursOf is a thin local helper.
function ageHoursOf(c){ const d=toDate(c.updated_at||c.created_at); return d?(Date.now()-d.getTime())/3600000:0 }
function todoHint(c){
  const tags=tagList(c)
  if(tags.includes('opted-out')) return 'This person asked to stop. Do not message them. Leave this one alone.'
  if(c.status==='closed') return 'This one is finished. Nothing to do.'
  if(tags.includes('needs-human')) return 'This person asked for a real person. Reply to them below.'
  if(tags.includes('draft-pending')) return 'casey drafted a reply -- review it before it sends. Approve or discard it below.'
  if(tags.includes('health:unanswered_handoff_escalated')) return 'A person was asked for a long time ago and still no one has replied. Step in below.'
  if(tags.includes('health:unanswered_handoff')) return 'A person was asked for and no one has replied. Reply below to take this one on.'
  if(tags.includes('health:incomplete_critical')) return 'The visit-critical facts are still missing and the case is active. Try to reach the farmer now -- once they leave the site some facts cannot be recovered.'
  if(tags.includes('health:abandoned_intake')) return 'On-site facts are still missing and the farmer may be gone. Check if they are still reachable and ask for the most important detail (location or how to find the place).'
  if(c.status==='waiting' && ageHoursOf(c)>=24) return 'No answer for over a day. A check-in may help -- reply below.'
  if(tags.includes('health:stuck')) return 'This case has been in the same stage for a while. Check if it needs a push or can be closed.'
  if(tags.includes('health:stale')) return 'No activity for a while. Check if anything needs following up.'
  if(c.autonomy==='observe') return 'This one is waiting for you. Read it and reply, or set Who answers to auto so casey can answer.'
  if(c.autonomy==='assisted') return 'casey can draft, but you send. Open it and check the draft.'
  if(c.status==='resolved') return 'This one is marked done. Close it if you are finished.'
  if(c.status==='waiting') return 'Waiting on the person to reply. Nothing to do until they answer.'
  if(c.status==='new'||c.status==='triaging') return 'A new message came in. casey is sorting it out.'
  return 'casey is handling this one on its own. Step in only if you need to.'
}
// 2-4 canned replies for this case. Plain, warm, short. Clicking fills (never sends).
// Returns [] for opted-out contacts so the UI never nudges the operator to message them.
function cannedReplies(c){
  if(tagList(c).includes('opted-out')) return []
  const tags=tagList(c)
  if(tags.includes('needs-human'))
    return ['Hi, this is a real person now. How can I help you?',
            'I am here to help. Can you tell me a bit more?',
            'Thank you for waiting. I am looking into this for you now.']
  if(c.status==='waiting')
    return ['Just checking in - are you still there? Reply when you can.',
            'No rush. I am still here whenever you are ready.']
  return ['Thanks for your message. I am looking into this now.',
          'Got it - I will get back to you shortly.',
          'Can you tell me a little more so I can help?']
}
async function openCase(id){
  activeId = id
  clearHandoff(id)                             // dismiss banner locally; DB tag clears only on reply
  // deep-link the open case in the hash only (auth is the login session cookie,
  // so there is no secret in the URL to leak); location.search is preserved by
  // replaceState's relative URL, keeping any benign filter params intact.
  const wantHash='#case='+encodeURIComponent(id)
  if(location.hash!==wantHash) history.replaceState(null,'',location.pathname+location.search+wantHash)
  if($('#wrap')) $('#wrap').classList.add('detail-open')
  let data
  try{ data = await api('/api/cases/'+encodeURIComponent(id)).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ $('#detail').innerHTML='<p class="empty">Could not load this case.</p>'; return }
  const {case:c, events, transitions, events_total, report_fill_rate:rfr, suggested_assignee:sugg} = data
  const more = events_total!=null && events.length<events_total
  $('#detail').innerHTML = `
    <button class="icon-btn back" id="back">&lt;- cases</button>
    <h2 style="margin:6px 0 4px">${esc(c.ref)} <span class="badge" title="${esc(c.status)}">${esc(stageLabel(c.status))}</span>
      ${fillPill(rfr)}
      <button class="copy" data-copy="${esc(c.ref)}" title="copy ref">copy</button>
      <button class="copy" data-copy="${esc(location.origin+location.pathname+'#case='+encodeURIComponent(c.id))}" title="copy direct link to this case (no token in link)" style="margin-left:4px">link</button>
      <a href="/api/cases/${encodeURIComponent(c.id)}/report.html" target="_blank" class="icon-btn" style="margin-left:4px;text-decoration:none;display:inline-block">Print</a>
      <button id="share-form-btn" class="icon-btn" style="margin-left:4px" title="Get a link to share with the contact so they can fill in their own details">Share form</button>
      ${(c.assignee&&c.assignee!=='agent')
        ? '<span class="owner-chip'+(c.assignee===selectedOperator?' mine':'')+'" style="margin-left:4px" title="Who is handling this">'+(c.assignee===selectedOperator?'yours':esc(c.assignee))+'</span>'
        : '<button id="claim-btn" class="icon-btn" style="margin-left:4px" title="Take this case as yours (recorded against you)">Claim</button>'}
      ${snoozedUntilTag(c.tags)
        ? '<button id="snooze-btn" class="icon-btn" style="margin-left:4px" data-clear="1" title="Snoozed until '+esc(fmtTime(snoozedUntilTag(c.tags)))+' -- click to clear">Snoozed</button>'
        : '<button id="snooze-btn" class="icon-btn" style="margin-left:4px" title="Hide from the inbox for a while without losing it -- a needs-human case is never hidden">Snooze</button>'}
      ${(sugg && (!c.assignee||c.assignee==='agent')) ? '<span class="hint" style="margin-left:6px" title="Based on '+esc(sugg.name)+'\'s past work near '+esc(sugg.matched_area)+' -- a suggestion only, never automatic">suggested: '+esc(sugg.name)+'</span>' : ''}</h2>
    <div class="todo" id="todo-hint">${esc(todoHint(c))}</div>
    ${healthBadges(c.tags)}${intakeModeBadge(c.tags)}
    <div style="color:var(--muted);margin-bottom:12px">${esc(c.channel)}/${esc(fmtPhone(c.external_id))}
      <button class="copy" data-copy="${esc(c.external_id)}" title="copy contact">copy</button></div>
    ${reportPanel(c.report, events)}
    <button id="edit-report-btn" class="icon-btn" style="margin-bottom:14px">Edit report fields</button>
    <div class="row">
      <div><label>Priority</label><select id="f-priority">${CASEY_PRIORITIES.map(p=>opt(p,c.priority)).join('')}</select>${simple?'<p class="hint">How urgent this is.</p>':''}</div>
      <div><label>Autonomy</label><select id="f-autonomy" title="${esc(AUTONOMY_HELP)}">${['auto','assisted','observe'].map(p=>opt(p,c.autonomy)).join('')}</select>${simple?'<p class="hint">Who answers the contact: the robot, a draft for you, or nobody.</p>':''}</div>
      <div><label>Assignee</label><input id="f-assignee" value="${esc(c.assignee||'')}"></div>
      <div><label>Case type</label><select id="f-case-type" title="Management lens: segments every report aggregate. Changing it records a case_type a -> b audit event.">${CASEY_CASE_TYPES.map(p=>opt(p,c.case_type||'unset')).join('')}</select>${simple?'<p class="hint">What kind of case this is, for the team\'s reports.</p>':''}</div>
    </div>
    <p class="hint">${esc(AUTONOMY_HELP)}</p>
    <label>Subject</label><input id="f-subject" value="${esc(c.subject||'')}">
    <label>Tags</label><input id="f-tags" value="${esc(c.tags||'')}">
    <label>Summary</label><textarea id="f-summary" rows="3">${esc(c.summary||'')}</textarea>
    <button id="save">Save edits</button>
    <div style="margin-top:14px"><label>${simple?'Change the stage':'Override workflow stage'}</label>
      ${simple?'<p class="hint">Move this case to a new stage. For some stages the contact gets a short automatic note; for internal stages they are not told.</p>':''}
      ${transitions.map(t=>`<button class="trans" data-to="${esc(t)}" title="${esc(t)}" style="background:#2a3340">-&gt; ${esc(stageLabel(t))}</button>`).join(' ')||'<span class="hint">no transitions available</span>'}
    </div>
    ${draftBanner(c,events)}
    <div style="margin-top:14px"><label>Reply to contact on ${esc(c.channel)}</label>
      <textarea id="f-reply" rows="2" placeholder="Send a message as a human operator... (Ctrl+Enter to send)" maxlength="4096">${esc(draftText(c,events))}</textarea>
      <div class="reply-counter" id="reply-counter">0 / 4096</div>
      ${contactMaybeNonEnglish(events)?'<p class="canned-lab" style="color:var(--danger)">This person may not be writing in English. Please reply in their language.</p>':''}
      ${cannedReplies(c).length ? `<p class="canned-lab">Or tap a ready-made reply to start with:</p>
      <div class="canned" id="canned">${cannedReplies(c).map((t,i)=>
        `<button type="button" data-i="${i}">${esc(t)}</button>`).join('')}</div>` : ''}
      <button id="send-reply">Send reply</button>
    </div>
    <div id="dup-panel"></div>
    <div id="site-history-panel"></div>
    <h3 style="margin:18px 0 6px">Timeline${events_total!=null?` (${events.length}/${events_total})`:''}
      <button id="add-case-note" class="icon-btn" style="float:right;margin-top:-2px">+ Note</button>
      <button id="split-case-btn" class="icon-btn" style="float:right;margin-top:-2px;margin-right:4px">Split</button></h3>
    <input id="timeline-search" type="search" placeholder="Search timeline..." style="width:100%;margin-bottom:8px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--fg);font-size:13px">
    <div id="timeline">${renderEvents(events)}</div>
    ${more?'<button id="more-events" style="background:#2a3340">Load older events</button>':''}
  `
  // Possibly-the-same-case panel: load casey's grouping suggestions and offer a
  // one-click merge. Best-effort and isolated -- a suggestions failure must never
  // break the case view, so it is loaded after the main render and swallows errors.
  loadDuplicateSuggestions(id)
  // Site visit history: who else has reported at this same place (any reporter,
  // any time -- a field worker does not own a case, a different person may
  // follow up from whoever first reported it). Same best-effort/isolated
  // loading discipline as loadDuplicateSuggestions above.
  loadSiteHistory(id)
  // pause polling while any field is focused so a refresh can't wipe the edit;
  // resume on blur. A blur fallback guarantees we never get stuck paused.
  $('#detail').querySelectorAll('input,select,textarea').forEach(el=>{
    el.addEventListener('focus',()=>{editing=true})
    el.addEventListener('blur',()=>{editing=false})
  })
  const back=$('#back'); if(back) back.onclick=()=>{ $('#wrap').classList.remove('detail-open') }
  const claimBtn=$('#claim-btn')
  if(claimBtn) claimBtn.onclick=async()=>{
    if(!selectedOperator){ toast('Pick who you are first (top-right) so the claim is recorded against you.','warn'); return }
    claimBtn.disabled=true
    try{
      const r=await api('/api/cases/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],action:'claim'})})
      if(r.ok){ undoToast(id,'Claimed -- this one is yours now'); openCase(id); refreshAttention() }
      else{ claimBtn.disabled=false; toast('Could not claim this case','warn') }
    }catch(e){ claimBtn.disabled=false; toast('Claim error: '+e.message,'warn') }
  }
  const snoozeBtn=$('#snooze-btn')
  if(snoozeBtn) snoozeBtn.onclick=async()=>{
    if(snoozeBtn.dataset.clear){
      snoozeBtn.disabled=true
      try{
        const r=await api('/api/cases/'+encodeURIComponent(id)+'/snooze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minutes:0})})
        if(r.ok){ toast('Snooze cleared'); openCase(id); refreshAttention() }
        else{ snoozeBtn.disabled=false; toast('Could not clear snooze','warn') }
      }catch(e){ snoozeBtn.disabled=false; toast('Snooze error: '+e.message,'warn') }
      return
    }
    const dlg=await showDialog({title:'Snooze this case',message:'Hide it from the inbox for a while without losing it. A case where someone asked for a person is never hidden, even snoozed.',inputLabel:'Minutes from now (e.g. 60 for 1 hour, 1440 for a day)',inputPlaceholder:'240',confirmLabel:'Snooze'})
    if(!dlg||!dlg.value) return
    const minutes=parseInt(dlg.value,10)
    if(!Number.isFinite(minutes)||minutes<=0){ toast('Enter a positive number of minutes','warn'); return }
    snoozeBtn.disabled=true
    try{
      const r=await api('/api/cases/'+encodeURIComponent(id)+'/snooze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minutes})})
      if(r.ok){ toast('Snoozed'); openCase(id); refreshAttention() }
      else{ snoozeBtn.disabled=false; toast('Could not snooze this case','warn') }
    }catch(e){ snoozeBtn.disabled=false; toast('Snooze error: '+e.message,'warn') }
  }
  const shareFormBtn=$('#share-form-btn')
  if(shareFormBtn) shareFormBtn.onclick=()=>{
    const url=location.origin+'/report?ref='+encodeURIComponent(c.ref)
    showDialog({title:'Share form with contact',message:'Send this link to the contact so they can fill in the details directly: '+url,confirmLabel:'Copy link',cancelLabel:'Close'}).then(dlg=>{
      if(dlg){ try{ navigator.clipboard.writeText(url); toast('Link copied') }catch{ prompt('Copy this link:',url) } }
    })
  }
  const tlSearch=$('#timeline-search')
  if(tlSearch) tlSearch.addEventListener('input',()=>{
    const q=tlSearch.value.toLowerCase().trim()
    $('#timeline').querySelectorAll('.ev').forEach(el=>{
      el.style.display=(!q||el.textContent.toLowerCase().includes(q))?'':'none'
    })
  })
  const editRptBtn=$('#edit-report-btn')
  if(editRptBtn) editRptBtn.onclick=()=>openIntakeForm(c)
  const vcBanner=$('#vc-banner')
  if(vcBanner) vcBanner.onclick=()=>openIntakeForm(c)
  // Inline per-field editing: click a field value -> edit in place -> Enter/blur saves.
  $('#detail').querySelectorAll('.rep-editable').forEach(span=>{
    span.onclick=async()=>{
      if(span.querySelector('input')) return   // already editing
      const k=span.dataset.key
      const cur=(c.report?JSON.parse(c.report):{})[k]||''
      span.classList.add('rep-saving')
      const inp=document.createElement('input')
      inp.className='rep-field-input'; inp.value=cur
      span.innerHTML=''; span.appendChild(inp)
      inp.focus(); span.classList.remove('rep-saving')
      const save=async()=>{
        const val=inp.value
        if(val===cur){span.textContent=cur||''; return}   // no change
        if(!val.trim()&&cur){ toast('To remove a field value, use the full Edit form','ok'); span.textContent=cur||''; return }
        span.classList.add('rep-saving')
        const r=await api('/api/cases/'+encodeURIComponent(c.id)+'/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({[k]:val})})
        if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); span.textContent=cur||''; return }
        toast('saved','ok'); span.classList.remove('rep-saving')
        lastCasesJson=''; await loadCases(); await openCase(c.id)
      }
      inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();save()} if(e.key==='Escape'){span.textContent=cur||''} })
      inp.addEventListener('blur',save)
    }
  })
  // Per-field note buttons: prompt for a note text, save as kind=note event with field key.
  $('#detail').querySelectorAll('.rep-note-btn').forEach(btn=>{
    btn.onclick=async()=>{
      const k=btn.dataset.key
      const fieldLabel=(REPORT_FIELDS.find(([f])=>f===k)||[k,k])[1]
      const dlg=await showDialog({title:'Add a note',inputLabel:'Note for: '+fieldLabel,inputPlaceholder:'Type your note here...',confirmLabel:'Save note'})
      const text=(dlg&&dlg.value||'').trim()
      if(!text) return
      const r=await api('/api/cases/'+encodeURIComponent(c.id)+'/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,field:k})})
      if(!r.ok){ toast(await failMsg(r,'note failed'),'err'); return }
      toast('note saved','ok'); lastCasesJson=''; await loadCases(); await openCase(c.id)
    }
  })
  $('#detail').querySelectorAll('.copy').forEach(b=>b.onclick=()=>{
    try{ navigator.clipboard.writeText(b.dataset.copy); toast('copied') }catch{ toast('copy failed','err') } })
  $('#save').onclick = async ()=>{
    const btn=$('#save'); btn.disabled=true
    const body = {subject:$('#f-subject').value, summary:$('#f-summary').value, priority:$('#f-priority').value, tags:$('#f-tags').value, assignee:$('#f-assignee').value, autonomy:$('#f-autonomy').value}
    const ctSel=$('#f-case-type'); if(ctSel && ctSel.value!==(c.case_type||'unset')) body.case_type=ctSel.value
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
    if(j.delivered) replyUndoToast(id,c.channel)
    else toast(j.sent?'reply sent but it did not reach the contact - check the timeline':'reply logged (channel not connected)','ok')
    await openCase(id)
  }
  $('#send-reply').onclick = send
  $('#f-reply').addEventListener('keydown',e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); send() } })
  const draftOk=$('#draft-approve')
  if(draftOk) draftOk.onclick=async()=>{
    const text=$('#f-reply').value.trim(); draftOk.disabled=true
    const r=await api('/api/cases/'+encodeURIComponent(id)+'/draft/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    draftOk.disabled=false
    if(!r.ok){ toast(await failMsg(r,'approve failed'),'err'); return }
    const j=await r.json().catch(()=>({}))
    toast(j.delivered?'draft sent':'draft logged (channel not connected)','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const draftNo=$('#draft-discard')
  if(draftNo) draftNo.onclick=async()=>{
    const dlg=await showDialog({title:'Discard this draft?',message:'The drafted reply will not be sent. The case stays flagged for a human.',confirmLabel:'Discard'})
    if(!dlg) return
    const r=await api('/api/cases/'+encodeURIComponent(id)+'/draft/discard',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})})
    if(!r.ok){ toast(await failMsg(r,'discard failed'),'err'); return }
    toast('draft discarded','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const replyCounter=$('#reply-counter')
  if(replyCounter){
    const updateCounter=()=>{ const n=$('#f-reply').value.length; replyCounter.textContent=n+' / 4096'
      replyCounter.className='reply-counter'+(n>3800?' warn':'')+(n>=4096?' over':'') }
    $('#f-reply').addEventListener('input',updateCounter)
  }
  const canEl = $('#canned')
  if(canEl){
    const cans = cannedReplies(c)
    canEl.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      const ta=$('#f-reply'); ta.value=cans[+b.dataset.i]; ta.focus()
      ta.setSelectionRange(ta.value.length,ta.value.length)
    })
  }
  const addNoteBtn = $('#add-case-note')
  if(addNoteBtn) addNoteBtn.onclick = async ()=>{
    const dlg=await showDialog({title:'Add a note to this case',inputLabel:'Note',inputPlaceholder:'Type your observation or note here...',confirmLabel:'Save note'})
    const text=(dlg&&dlg.value||'').trim(); if(!text) return
    const r=await api('/api/cases/'+encodeURIComponent(id)+'/note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})
    if(!r.ok){ toast(await failMsg(r,'note failed'),'err'); return }
    toast('note saved','ok'); lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const splitBtn = $('#split-case-btn')
  if(splitBtn) splitBtn.onclick = async ()=>{
    const allEvts = await api('/api/cases/'+encodeURIComponent(id)+'/events?limit=200').then(r=>r.json()).catch(()=>({events:[]}))
    const evList = (allEvts.events||[]).filter(e=>['inbound','outbound','note','observation'].includes(e.kind))
    if(!evList.length){ toast('no events to split off','err'); return }
    const result = await showSplitDialog(evList, c.ref)
    if(!result) return
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/split',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event_ids:result.event_ids,subject:result.subject,reason:result.reason})})
    if(!r.ok){ toast(await failMsg(r,'split failed'),'err'); return }
    const sj = await r.json().catch(()=>({}))
    toast('split: new case '+sj.new_case_ref+' ('+sj.moved_events+' events moved)','ok')
    lastCasesJson=''; await loadCases(); await openCase(id)
  }
  const moreBtn = $('#more-events')
  if(moreBtn) moreBtn.onclick = async ()=>{
    const off = events.length
    const older = await api('/api/cases/'+encodeURIComponent(id)+'/events?offset='+off).then(r=>r.json())
    $('#timeline').insertAdjacentHTML('beforeend', renderEvents(older.events||[]))
    if(!older.events||!older.events.length||off+older.events.length>=events_total) moreBtn.remove()
  }
  document.querySelectorAll('.trans').forEach(b=>b.onclick=async()=>{
    const toLabel = stageLabel(b.dataset.to)
    const dlg=await showDialog({title:'Move to: '+toLabel,inputLabel:'Reason (optional)',inputPlaceholder:'e.g. operator contacted farmer directly',confirmLabel:'Move case'})
    if(dlg===null) return                   // operator cancelled
    const reason=dlg.value||''
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/transition',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:b.dataset.to,reason:reason||undefined})})
    if(!r.ok){ toast(await failMsg(r,'transition failed'),'err'); return }
    const updated = await r.json().catch(()=>({}))
    undoToast(id,CASEY_NOTIFIED_STAGES.includes(updated.status)?'Moved to '+toLabel+'. A short note was queued to the contact.':'Moved to '+toLabel+'. The contact was not told.')
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
  renderListFull(); renderTriage()              // reflect the new active row in both lists
  // Move focus to the detail pane now that its content is rendered, so a
  // keyboard/screen-reader user selecting a case (click or Enter on a list
  // row) lands directly on what they just opened instead of focus staying
  // stranded on the list. #detail carries tabindex="-1" (index.html) so it
  // is programmatically focusable without joining the natural tab order.
  $('#detail').focus()
}
// Load and render the "possibly the same case" suggestions for the open case.
// Isolated and best-effort: any failure leaves the panel empty rather than
// breaking the detail view. Each suggestion shows the plain-language reasons and
// a merge button that folds the OTHER case into the one being viewed.
async function loadDuplicateSuggestions(id){
  const panel=$('#dup-panel'); if(!panel) return
  let j
  try{ j = await api('/api/cases/'+encodeURIComponent(id)+'/suggestions').then(r=>r.ok?r.json():null) }catch{ return }
  if(!j||!j.suggestions||!j.suggestions.length){ panel.innerHTML=''; return }
  panel.innerHTML='<div class="dup"><h3 style="margin:14px 0 6px">Possibly the same case</h3>'
    + '<p class="hint">casey thinks these reports may be the same outbreak. Merge folds the other case into this one (you can review before confirming).</p>'
    + j.suggestions.map(s=>`<div class="dup-row"><b>${esc(s.ref)}</b> ${esc(s.subject||'')}
        <span class="when">${esc(s.reasons.join(', '))}</span>
        <button class="merge-btn" data-into="${esc(s.id)}" data-ref="${esc(s.ref)}" style="background:#3a2a40">Merge ${esc(s.ref)} into this</button></div>`).join('')
    + '</div>'
  panel.querySelectorAll('.merge-btn').forEach(b=>b.onclick=async()=>{
    const dlg=await showDialog({title:'Merge '+b.dataset.ref+' into this case?',message:'The other case becomes a redirect. This is lossless and can be reviewed on the timeline.',inputLabel:'Why are these the same outbreak? (optional)',inputPlaceholder:'e.g. same farm, same symptoms reported separately',confirmLabel:'Merge cases',danger:true})
    if(dlg===null) return
    const reason=dlg.value||''
    b.disabled=true
    const r = await api('/api/cases/'+encodeURIComponent(id)+'/merge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({into:b.dataset.into,reason:reason||undefined})})
    b.disabled=false
    if(!r.ok){ toast(await failMsg(r,'merge failed'),'err'); return }
    const res=await r.json().catch(()=>({}))
    toast(res.alreadyMerged?'already merged':'merged '+b.dataset.ref+' in ('+(res.movedEvents||0)+' events)','ok')
    lastCasesJson=''; await loadCases(); await openCase(id)
  })
}
// Load and render the "who has visited this site" history: every OTHER case
// (open or closed) casey thinks describes the same real place, reused from
// the same correlate.js scoring that powers the merge-suggestion panel above,
// but at a lower threshold and including closed cases -- a visit history is
// about the PLACE's past, not just currently-open threads. PII-free by
// construction (server only returns ref/channel/status/timestamps, never
// external_id) -- clicking a row opens that case for full detail the same
// way the case list already does. Isolated/best-effort like
// loadDuplicateSuggestions: a failure here must never break the case view.
async function loadSiteHistory(id){
  const panel=$('#site-history-panel'); if(!panel) return
  let j
  try{ j = await api('/api/cases/'+encodeURIComponent(id)+'/site-history').then(r=>r.ok?r.json():null) }catch{ return }
  if(!j||!j.visits||!j.visits.length){ panel.innerHTML=''; return }
  panel.innerHTML='<div class="dup"><h3 style="margin:14px 0 6px">Visit history for this site</h3>'
    + '<p class="hint">Other reports casey thinks are the same place, most recent first -- any reporter may have visited, not only whoever opened this case.</p>'
    + j.visits.map(v=>`<div class="dup-row" data-open="${esc(v.id)}" style="cursor:pointer">
        <b>${esc(v.ref)}</b> <span class="when">${esc(v.channel||'')} - ${esc(v.status||'')} - reported ${esc(rel(v.reported_at))}</span>
        <span class="hint" style="display:block">${esc(v.reasons.join(', '))}</span></div>`).join('')
    + '</div>'
  panel.querySelectorAll('[data-open]').forEach(row=>row.onclick=()=>openCase(row.dataset.open))
}
function renderEvents(events){
  return events.map(e=>`<div class="ev ${esc(e.kind)}"><span class="k">${esc(e.kind)}/${esc(e.actor)}</span> ${esc(e.text||'')} <span class="when" title="${esc(fmtTime(e.created_at))}">${esc(rel(e.created_at))}</span></div>`).join('')
}
// Parse a 'snoozed-until:<epoch-ms>' tag (see POST /api/cases/:id/snooze,
// attn.js's own reader) into the epoch, or null if not snoozed / expired. A
// PAST snooze target reads as not-snoozed here (matches attnScore's own
// now-vs-snooze comparison) so the button correctly offers "Snooze" again
// rather than a stale "Snoozed" once the window has simply elapsed.
function snoozedUntilTag(tags){
  for(const t of String(tags||'').split(',').map(s=>s.trim())){
    if(t.startsWith('snoozed-until:')){
      const v=parseInt(t.slice('snoozed-until:'.length),10)
      if(Number.isFinite(v)&&v>Date.now()) return v
    }
  }
  return null
}
// Plain-language warning chips for the time-guardrail health:* tags the sweep
// maintains, so an operator sees at a glance that a case is going wrong over time.
const HEALTH_LABEL={'health:stale':'Going cold (no recent activity)','health:stuck':'Stuck in this stage too long','health:unanswered_handoff':'A person was asked for and not yet answered','health:abandoned_intake':'Intake left with on-site facts missing','health:incomplete_critical':'Working but visit-critical facts still missing','health:never_closed':'Resolved but never closed','health:timestamp_corrupt':'Case time data looks wrong'}
function healthBadges(tags){
  const list=String(tags||'').split(',').map(s=>s.trim()).filter(t=>t.indexOf('health:')===0)
  if(!list.length) return ''
  return '<div class="health">'+list.map(t=>`<span class="health-chip" title="${esc(t)}">${esc(HEALTH_LABEL[t]||t)}</span>`).join('')+'</div>'
}
function intakeModeBadge(tags){
  const t=String(tags||'').split(',').map(s=>s.trim())
  const hasChannel=t.includes('intake_mode:channel')
  const hasManual=t.includes('intake_mode:manual')
  const hasPublic=t.includes('intake_mode:public_form')
  if(!hasChannel&&!hasManual&&!hasPublic) return ''
  const parts=[]
  if(hasChannel) parts.push('<span class="src-tag src-ai" style="font-size:11px;padding:2px 8px">AI channel</span>')
  if(hasManual) parts.push('<span class="src-tag src-manual" style="font-size:11px;padding:2px 8px">Operator entry</span>')
  if(hasPublic) parts.push('<span class="src-tag src-both" style="font-size:11px;padding:2px 8px">Public form</span>')
  return '<span class="intake-mode-badge" title="How this case was created" style="background:transparent;padding:0">' + parts.join(' ') + '</span>'
}
// --- theme ---
function applyTheme(t){ document.documentElement.dataset.theme=t; try{localStorage.casey_theme=t}catch{}
  $('#theme').textContent = t==='light'?'dark':'light' }
applyTheme((()=>{ try{return localStorage.casey_theme}catch{} })() || (matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'))
$('#theme').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light')
// --- plain-language / simple mode toggle (persisted like the theme) ---
function applySimple(on){ simple=!!on; try{localStorage.casey_simple=on?'1':''}catch{}
  $('#simple').classList.toggle('active',simple)
  $('#simple').title = simple ? 'Plain-language mode ON - click for technical stage names' : 'Plain-language mode: show friendly stage names'
  fillStatusFilter(); renderListFull(); if(activeId) openCase(activeId) }
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
// First-run onboarding: a focused 3-step card shown once per browser. The flag is
// set the moment it is dismissed, so it never nags a returning operator.
function onboarded(){ try{ return localStorage.casey_onboarded==='1' }catch{ return false } }
function showOnboard(){ $('#onboard-ovl').classList.add('show') }
function hideOnboard(){ $('#onboard-ovl').classList.remove('show'); try{ localStorage.casey_onboarded='1' }catch{} }
$('#onboard-close').onclick = hideOnboard
$('#onboard-ovl').addEventListener('click', e=>{ if(e.target===$('#onboard-ovl')) hideOnboard() })
// "Show me again" from inside the help card: close help, reopen the quick start.
const _onboardAgain=$('#onboard-again'); if(_onboardAgain) _onboardAgain.onclick=()=>{ hideHelp(); showOnboard() }
// --- per-operator skills checklist -------------------------------------------
// Distinct from the one-per-browser quick start: this tracks, PER OPERATOR, whether
// they have learned the three shift-speed moves. State is a localStorage map keyed
// by operator id (or a "default" bucket before anyone is picked) so a shared
// machine does not leak one person's progress onto the next. Dismissed or fully
// ticked, it does not reappear. ASCII only; client-only; no server state.
const SKILLS = [
  { id:'keys', label:'Keyboard triage: j and k move through the list, Enter opens, c claims, e jumps to the reply box.' },
  { id:'mine', label:'The Mine filter shows only the cases you have claimed -- pick who you are top-right, then press Mine.' },
  { id:'draft', label:'In assisted mode a reply waits as a draft until you approve it -- open the case and use Send draft or Discard.' },
]
function skillsKey(){ return 'casey_skills_'+(selectedOperator||'default') }
function loadSkills(){ try{ const o=JSON.parse(localStorage.getItem(skillsKey())||'{}'); return (o&&typeof o==='object')?o:{} }catch{ return {} } }
function saveSkills(o){ try{ localStorage.setItem(skillsKey(), JSON.stringify(o)) }catch{} }
function skillsDone(o){ return SKILLS.every(s=>o[s.id]) }
function skillsDismissed(){ return loadSkills().__dismissed===true }
function renderSkills(){
  const o=loadSkills(); const ul=$('#skills-list'); if(!ul) return
  ul.innerHTML=SKILLS.map(s=>'<li data-id="'+esc(s.id)+'"'+(o[s.id]?' class="done"':'')+'><span class="box">'+(o[s.id]?'x':'')+'</span><span class="lbl">'+esc(s.label)+'</span></li>').join('')
  ul.querySelectorAll('li').forEach(li=>li.onclick=()=>{
    const m=loadSkills(); const id=li.dataset.id; m[id]=!m[id]; saveSkills(m); renderSkills()
    if(skillsDone(loadSkills())) toast('Nice -- you have got the three core moves.','ok')
  })
}
function showSkills(){ renderSkills(); $('#skills-ovl').classList.add('show') }
function hideSkills(){ $('#skills-ovl').classList.remove('show'); const m=loadSkills(); m.__dismissed=true; saveSkills(m) }
const _skClose=$('#skills-close'); if(_skClose) _skClose.onclick=hideSkills
const _skOvl=$('#skills-ovl'); if(_skOvl) _skOvl.addEventListener('click', e=>{ if(e.target===_skOvl) hideSkills() })
// Surface for the witness harness.
window.__caseySkills = { SKILLS, skillsKey, loadSkills, saveSkills, skillsDone, skillsDismissed, renderSkills, showSkills, hideSkills }

// On a brand-new browser show the quick start; otherwise leave help to the ? button.
// Once the quick start is done, a fresh operator who has not finished or dismissed
// the skills checklist sees it next (never both at once).
if(!onboarded()){ showOnboard() }
else if(!skillsDismissed() && !skillsDone(loadSkills())){ showSkills() }
else if(!helpSeen()){ showHelp() }
// --- filters ---
let qTimer
$('#q').addEventListener('input',e=>{ clearTimeout(qTimer); qTimer=setTimeout(()=>{ filt.q=e.target.value; lastCasesJson=''; loadCases() },300) })
$('#statusf').addEventListener('change',e=>{ filt.status=e.target.value; lastCasesJson=''; loadCases() })
$('#refresh').onclick=()=>{ lastCasesJson=''; loadCases() }
// --- keyboard nav: / focus search, j/k move, enter open, esc clear/back ---
document.addEventListener('keydown',e=>{
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
  if(e.key==='n' && !typing){ e.preventDefault(); openIntakeForm(null); return }
  if(e.key==='/' && !typing){ e.preventDefault(); $('#q').focus(); return }
  if(e.key==='Escape'){ const bk=$('#back'); if($('#onboard-ovl').classList.contains('show')){hideOnboard()} else if($('#skills-ovl').classList.contains('show')){hideSkills()} else if(helpOpen){hideHelp()} else if(typing){document.activeElement.blur()} else if(bk&&$('#wrap').classList.contains('detail-open')){bk.click()} else if($('#q').value){filt.q='';$('#q').value='';renderListFull()} return }
  if(e.key==='?' && !typing){ e.preventDefault(); helpOpen?hideHelp():showHelp(); return }
  if(typing) return
  if(e.key==='j'||e.key==='k'||e.key==='ArrowDown'||e.key==='ArrowUp'){
    const shown=allCases.filter(matchesFull); if(!shown.length)return
    let i=shown.findIndex(c=>c.id===activeId)
    i = (e.key==='j'||e.key==='ArrowDown') ? Math.min(shown.length-1,i+1) : Math.max(0,i<0?0:i-1)
    openCase(shown[i].id)
    const el=document.querySelector('.case.active'); if(el)el.scrollIntoView({block:'nearest'})
    return
  }
  // o / Enter open the highlighted case; if none is open yet, open the first shown.
  if(e.key==='o'||e.key==='Enter'){
    if(!activeId){ const shown=allCases.filter(matchesFull); if(shown.length){ e.preventDefault(); openCase(shown[0].id) } }
    return
  }
  // c claims the open case (same path as the Claim button); e jumps to the reply box.
  if(e.key==='c'){ const b=$('#claim-btn'); if(b){ e.preventDefault(); b.click() } return }
  if(e.key==='e'){ const ta=$('#f-reply'); if(ta){ e.preventDefault(); ta.focus() } return }
  // Space toggles bulk-select on a focused case row (each .case/.tcase carries
  // tabindex="0" so Tab/Shift+Tab reaches it like any other control) -- the
  // keyboard equivalent of the checkbox's mouse-only onclick handler, matching
  // this same j/k/o/Enter/c/e/Escape shortcut pattern.
  if(e.key===' '){
    const row=document.activeElement && document.activeElement.closest && document.activeElement.closest('.case[data-id]')
    if(row){ e.preventDefault(); const id=row.dataset.id; const nowOn=!selectedIds.has(id); toggleSelect(id, nowOn); const cb=row.querySelector('.case-cb'); if(cb) cb.checked=nowOn }
    return
  }
})
// --- deep-link restore + poll ---
function restoreFromHash(){ const m=/#case=([^&]+)/.exec(location.hash); if(m) return decodeURIComponent(m[1]) }
async function restoreRefFromHash(){
  const m=/#ref=([^&]+)/.exec(location.hash); if(!m) return
  const ref=decodeURIComponent(m[1])
  // pre-populate search and fetch the matching case
  filt.q=ref; $('#q').value=ref; lastCasesJson=''
  await loadCases()
  const found=allCases.find(c=>c.ref===ref); if(found) openCase(found.id)
}
// Handoff banner click handlers (attached here so openCase is defined).
$('#handoff').onclick=(e)=>{ if(e.target.id==='handoff-dismiss') return
  const c=handoffQueue[handoffQueue.length-1]; if(c) openCase(c.id) }
$('#handoff-dismiss').onclick=(e)=>{ e.stopPropagation(); handoffQueue=[]; renderHandoff() }
// Plain-words AI-helper health pill. Green when online, amber otherwise; the
// title carries the full plain sentence so an operator sees WHY auto-replies may
// be paused. Failure to fetch is itself "unknown" (amber) -- never a silent green.
let lastHealth=null
async function refreshHealth(){
  const el=$('#aihealth'); if(!el) return
  let h
  try{ h=await api('/api/health').then(r=>{ if(!r.ok) throw new Error(r.status); return r.json() }) }
  catch(e){ h={ ok:false, label:'AI helper: unknown', detail:'Cannot reach the server to check the AI helper.' } }
  lastHealth=h
  // A deaf receive channel (gateway not connected) is more urgent than the AI
  // helper's state: contacts may be messaging into silence. When the server
  // reports the gateway down, the pill shows THAT in red and overrides the
  // AI-helper line, so "online" can never hide "answering nobody".
  const gw=h.gateway
  if(gw && gw.ok===false){
    el.textContent=gw.label||'Messages: not connected'
    el.title=gw.detail||'A message channel is not receiving.'
    el.style.background='rgba(200,40,40,.20)'
    el.style.color='#b22222'
    return
  }
  el.textContent=h.label
  // Queue-alert-visibility: append LLM-down queue depth and alert-webhook
  // delivery status into the SAME pill's title (no new UI element needed --
  // an operator already hovers this pill to see why auto-replies may be
  // paused, so the backlog/webhook detail belongs right there). Silent when
  // there is nothing worth surfacing (no queue backlog, webhook never
  // attempted or unconfigured) so a healthy deployment's tooltip stays terse.
  let extra=''
  if(h.queue && (h.queue.pending>0 || h.queue.dead_lettered>0)){
    extra+=' - Queued messages waiting to retry: '+h.queue.pending
    if(h.queue.dead_lettered>0) extra+=' ('+h.queue.dead_lettered+' gave up after repeated failures)'
  }
  if(h.alert_webhook && h.alert_webhook.configured && h.alert_webhook.ok===false){
    extra+=' - Alert webhook is failing to send.'
  }
  el.title=h.detail+(h.model?(' ('+h.model+')'):'')+(gw&&gw.label?(' - '+gw.label):'')+extra
  el.style.background=h.ok?'rgba(34,160,80,.18)':'rgba(200,140,0,.20)'
  el.style.color=h.ok?'#1c8c44':'#9a6a00'
  refreshRuntimePill(); refreshGuardrailsPill()
}
// Tints a pill green/amber/red. ok=true->green, warn=true->amber, else red.
function pillTint(el, ok, warn){
  if(ok){ el.style.background='rgba(34,160,80,.18)'; el.style.color='#1c8c44' }
  else if(warn){ el.style.background='rgba(200,140,0,.20)'; el.style.color='#9a6a00' }
  else { el.style.background='rgba(200,40,40,.20)'; el.style.color='#b22222' }
}
// Runtime pill: only shown when the process is supervised (standalone hides it,
// since there is no supervisor state to report). Red on 'degraded'.
async function refreshRuntimePill(){
  const el=$('#runtime-pill'); if(!el) return
  let r; try{ r=await api('/api/runtime').then(x=>x.ok?x.json():null) }catch{ r=null }
  if(!r || r.supervised===false){ el.style.display='none'; return }
  el.style.display=''
  el.textContent=r.label||('Runtime: '+(r.state||'unknown'))
  el.title='Restarts since boot: '+(r.restarts||0)+(r.lastCrashReason?(' - last: '+r.lastCrashReason):'')
  pillTint(el, r.state==='healthy', r.state==='restarting'||r.state==='booting')
}
// Inline-SVG sparkline (no chart lib): scaled polyline over numeric series.
function sparkline(vals, w, h2){
  if(!vals||!vals.length) return ''
  const max=Math.max(1,...vals)
  const step=vals.length>1 ? w/(vals.length-1) : 0
  const pts=vals.map((v,i)=>i*step+','+(h2-(v/max)*h2)).join(' ')
  return '<svg width="'+w+'" height="'+h2+'" style="vertical-align:middle;margin-left:5px"><polyline points="'+esc(pts)+'" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
}
// Guardrails pill: green clean / amber flagged>0 / red degraded, with a sparkline
// of recent flagged counts. Hidden until at least one sweep has run.
async function refreshGuardrailsPill(){
  const el=$('#guardrails-pill'); if(!el) return
  let fh; try{ fh=await api('/api/fleet-health').then(x=>x.ok?x.json():null) }catch{ fh=null }
  if(!fh || !fh.latest){ el.style.display='none'; return }
  el.style.display=''
  const flagged=fh.latest.flagged||0
  const spark=sparkline((fh.history||[]).map(p=>(p.flagged!=null?p.flagged:(p.data&&p.data.flagged)||0)), 36, 12)
  el.innerHTML='Guardrails: '+(fh.degraded?'degraded':(flagged>0?(flagged+' flagged'):'clean'))+spark
  el.title='Last sweep scanned '+(fh.latest.scanned||0)+', flagged '+flagged
  pillTint(el, !fh.degraded && flagged===0, !fh.degraded && flagged>0)
}
// --- channel filter ---
function fillChannelFilter(){
  const cur=$('#channelf').value
  const channels=[...new Set(allCases.map(c=>c.channel).filter(Boolean))].sort()
  $('#channelf').innerHTML='<option value="">all channels</option>'+channels.map(ch=>`<option value="${esc(ch)}"${ch===cur?' selected':''}>${esc(ch)}</option>`).join('')
  if(cur) $('#channelf').value=cur
}
$('#channelf').addEventListener('change',e=>{ filt.channel=e.target.value; lastCasesJson=''; loadCases() })
$('#sourcef').addEventListener('change',e=>{ filt.source=e.target.value; renderListFull(); renderTriage() })

// --- saved views: a named bundle of the current filter set ---------------------
// A "view" is just the operator's filters captured as plain data: search text,
// stage, channel, source, the Mine toggle, and Focus mode. We keep it client-only
// (no server state) and encode it two ways: a base64url 'view=' segment of the URL
// hash so a view is shareable by link (building on the existing #inbox/#case hash
// pattern; auth is the login session cookie, so a shared link carries no secret),
// and a small named-view map in localStorage so an operator's own views
// survive a reload. No external_id is ever part of a view -- only filter knobs.
function currentView(){ return { q: filt.q||'', status: filt.status||'', channel: filt.channel||'', source: filt.source||'', mine: !!mineOnly, focus: !!inboxMode } }
function encodeView(v){ try{ return btoa(unescape(encodeURIComponent(JSON.stringify(v)))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_') }catch{ return '' } }
function decodeView(s){ try{ const b=s.replace(/-/g,'+').replace(/_/g,'/'); const o=JSON.parse(decodeURIComponent(escape(atob(b)))); return (o&&typeof o==='object')?o:null }catch{ return null } }
// Apply a view object to the live filter state + controls, then reload the list.
function applyView(v){
  if(!v||typeof v!=='object') return
  filt.q=String(v.q||''); const qel=$('#q'); if(qel) qel.value=filt.q
  filt.status=String(v.status||''); const sel=$('#statusf'); if(sel) sel.value=filt.status
  filt.channel=String(v.channel||''); const cel=$('#channelf'); if(cel) cel.value=filt.channel
  filt.source=String(v.source||''); const oel=$('#sourcef'); if(oel) oel.value=filt.source
  setMineOnly(!!v.mine)
  setInboxMode(!!v.focus)
  lastCasesJson=''; loadCases()
}
// Write the active view into the hash (preserving any #case= deep-link segment).
function viewToHash(v){
  const enc=encodeView(v); if(!enc) return
  const parts=(location.hash||'').replace(/^#/,'').split('&').filter(p=>p&&!p.startsWith('view='))
  parts.unshift('view='+enc)
  const want='#'+parts.join('&')
  if(location.hash!==want) history.replaceState(null,'',location.pathname+location.search+want)
}
function viewFromHash(){ const m=/(?:^|[#&])view=([^&]+)/.exec(location.hash||''); return m?decodeView(m[1]):null }
// Named views persisted per browser. Map of name -> view object.
function loadNamedViews(){ try{ const o=JSON.parse(localStorage.casey_views||'{}'); return (o&&typeof o==='object')?o:{} }catch{ return {} } }
function saveNamedViews(m){ try{ localStorage.casey_views=JSON.stringify(m) }catch{} }
function refreshViewsDropdown(){
  const sel=$('#viewsf'); if(!sel) return
  const m=loadNamedViews(); const names=Object.keys(m).sort()
  sel.innerHTML='<option value="">saved views</option>'+names.map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('')+(names.length?'<option value="__del__">-- delete a view...</option>':'')
}
function saveCurrentView(){
  const name=(prompt('Name this view (e.g. "my urgent", "Musina handoffs"):')||'').trim()
  if(!name) return
  if(name.length>60){ toast('That name is too long.','err'); return }
  const m=loadNamedViews(); m[name]=currentView(); saveNamedViews(m); refreshViewsDropdown()
  const sel=$('#viewsf'); if(sel) sel.value=name
  viewToHash(currentView())
  toast('Saved view "'+name+'"','ok')
}
{
  const sel=$('#viewsf'); const btn=$('#view-save')
  if(btn) btn.onclick=saveCurrentView
  if(sel) sel.onchange=()=>{
    const v=sel.value
    if(v==='__del__'){
      const m=loadNamedViews(); const names=Object.keys(m).sort()
      const name=(prompt('Delete which view? '+names.join(', '))||'').trim()
      if(name&&m[name]){ delete m[name]; saveNamedViews(m); toast('Deleted view "'+name+'"','ok') }
      refreshViewsDropdown(); return
    }
    if(!v){ return }
    const m=loadNamedViews(); if(m[v]){ applyView(m[v]); viewToHash(m[v]) }
  }
  refreshViewsDropdown()
}
// Expose for the browser-witness harness: it asserts a hash-encoded view restores
// the full filter set after a reload.
window.__caseyViews = { currentView, encodeView, decodeView, applyView, viewToHash, viewFromHash }

let mineOnly = false
// True when the case is owned by the operator currently signed in (top-right
// picker). The agent/unclaimed pseudo-owner is never "mine".
function isMine(c){ return !!selectedOperator && c && c.assignee===selectedOperator }
function matchesFull(c){
  if(mineOnly && !isMine(c)) return false
  if(filt.channel && c.channel!==filt.channel) return false
  if(filt.source){
    const tags=tagList(c)
    if(filt.source==='manual' && !tags.includes('intake_mode:manual')) return false
    if(filt.source==='channel' && !tags.includes('intake_mode:channel')) return false
    if(filt.source==='public_form' && !tags.includes('intake_mode:public_form')) return false
  }
  return matches(c)
}
function renderListFull(){
  const shown = allCases.filter(matchesFull)
  if(!allCases.length){ $('#cases').innerHTML='<div class="empty">No cases yet.<br>Run <code>casey sim</code> or connect a channel to create one.</div>'; return }
  if(!shown.length){ $('#cases').innerHTML='<div class="empty">No cases match your filter.</div>'; return }
  $('#cases').innerHTML = shown.map(c=>`
    <div class="case ${c.id===activeId?'active':''}${selectedIds.has(c.id)?' selected':''}" data-id="${esc(c.id)}" role="listitem" tabindex="0" aria-selected="${selectedIds.has(c.id)?'true':'false'}">
      <input type="checkbox" class="case-cb" data-id="${esc(c.id)}" title="Select for a bulk action" aria-label="Select case ${esc(c.ref)} for a bulk action"${selectedIds.has(c.id)?' checked':''}>
      <div class="case-body">
      <div class="top">${attn(c)?'<span class="dot attn" title="needs attention (autonomy: '+esc(c.autonomy)+')"></span>':''}
        <span class="ref">${esc(c.ref)}</span><span class="badge ${esc(c.priority)}">${esc(c.priority)}</span>
        ${c.assignee&&c.assignee!=='agent'?'<span class="owner-chip'+(c.assignee===selectedOperator?' mine':'')+'">'+(c.assignee===selectedOperator?'you':esc(c.assignee))+'</span>':''}
        <span class="when" style="margin-left:auto" title="${esc(fmtTime(c.updated_at||c.created_at))}">${esc(rel(c.updated_at||c.created_at))}</span></div>
      <div class="sub">${(()=>{ const tg=tagList(c); if(tg.includes('intake_mode:manual')) return '<span class="src-tag src-manual" style="font-size:10px;padding:1px 6px">Manual</span> '; if(tg.includes('intake_mode:public_form')) return '<span class="src-tag src-both" style="font-size:10px;padding:1px 6px">Form</span> '; if(tg.includes('intake_mode:channel')) return '<span class="src-tag src-ai" style="font-size:10px;padding:1px 6px">AI</span> '; return '' })()}${esc(c.channel)} - ${esc(stageLabel(c.status))} - ${esc(c.subject||'(no subject)')}${c.fill_rate?fillPill(c.fill_rate):''}</div>
      </div>
    </div>`).join('')
  document.querySelectorAll('.case .case-body').forEach(el=>el.onclick=()=>openCase(el.parentNode.dataset.id))
  document.querySelectorAll('.case-cb').forEach(cb=>cb.onclick=e=>{ e.stopPropagation(); toggleSelect(cb.dataset.id,cb.checked) })
  syncBulkBar()
}
// --- bulk selection state + toolbar ---
const selectedIds=new Set()
function toggleSelect(id,on){ if(on) selectedIds.add(id); else selectedIds.delete(id); const row=document.querySelector('.case[data-id="'+(window.CSS&&CSS.escape?CSS.escape(id):id)+'"]'); if(row){ row.classList.toggle('selected',on); row.setAttribute('aria-selected',on?'true':'false') } syncBulkBar() }
function clearSelection(){ selectedIds.clear(); document.querySelectorAll('.case-cb').forEach(cb=>cb.checked=false); document.querySelectorAll('.case.selected').forEach(r=>r.classList.remove('selected')); syncBulkBar() }
function syncBulkBar(){
  const bar=$('#bulk-bar'); if(!bar) return
  const n=selectedIds.size
  bar.style.display = n>0 ? 'flex' : 'none'
  const cnt=$('#bulk-count'); if(cnt) cnt.textContent = n+' selected'
  const all=$('#bulk-all'); if(all){ const shownIds=allCases.filter(matchesFull).map(c=>c.id); all.checked = shownIds.length>0 && shownIds.every(id=>selectedIds.has(id)) }
}
async function bulkAction(action,extra){
  const ids=[...selectedIds]; if(!ids.length) return
  if(action==='claim' && !selectedOperator){ toast('Pick who you are first (top-right) so claims are recorded against you.','warn'); return }
  try{
    const r=await api('/api/cases/bulk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({ids,action},extra||{}))})
    if(!r.ok){ toast(await failMsg(r,'bulk action failed'),'err'); return }
    const j=await r.json().catch(()=>({}))
    const verb={claim:'claimed',transition:'moved',tag:'tagged',untag:'untagged',note:'noted',draft_approve:'sent',draft_discard:'discarded'}[action]||action
    toast(verb+' '+(j.ok||0)+(j.failed?(', '+j.failed+' could not be '+verb):''), j.failed?'warn':'ok')
    clearSelection(); lastCasesJson=''; await loadCases(); refreshAttention()
  }catch(e){ toast('Bulk error: '+e.message,'err') }
}
filt.channel = ''
filt.source = ''

// --- intake form (New Case / Edit Report) ---
// Fields a field visit cannot recover once the worker leaves -- visit-critical
// fields come first and are marked required. textarea:true for long free-text.
const INTAKE_FIELDS=[
  // -- visit-critical (needed for a field visit) --
  ['species','Which animals?','e.g. cattle, sheep, goats, pigs',{required:true},'The type of animal matters for disease identification. Be specific: "cattle" is better than "livestock".'],
  ['symptoms','What signs are you seeing?','e.g. drooling, limping, not eating, sudden death',{required:true,textarea:true},'Describe what you can see or hear. Multiple symptoms? List them all. "Drooling and limping on front legs" is much more useful than just "sick".'],
  ['location','Where are the animals?','Farm name, nearest town, or GPS coordinates',{required:true},'The single most important field. Without WHERE, a field team cannot visit. Farm name + nearest town is the minimum. GPS coordinates from your phone are perfect.'],
  ['how_to_find','How do we find the place?','Road name, landmark, or directions from the nearest town',{required:true,textarea:true},'What would you tell a stranger driving from the nearest town? Include landmarks, turn directions, and any tricky spots. "Past the big baobab, second gate on the left."'],
  ['farmer_available','Will the farmer be there?','e.g. yes, or phone first on 082...',{required:true},'A field team needs someone on-site to show them the animals. If the farmer will not be there, who can meet them?'],
  ['contact_fallback','Any other contact person?','Name and phone number if different from this one',{required:true},'A second number to call if this contact is unreachable. Even a neighbour or family member is better than nothing.'],
  // -- additional details --
  ['affected_count','How many are affected?','e.g. 5','Total number showing symptoms. Even an estimate helps plan resources.'],
  ['dead_count','How many have died?','e.g. 2 (write 0 if none)','If animals have died, note how many and roughly when (today, yesterday, over the past week).'],
  ['onset','When did it start?','e.g. yesterday morning, 3 days ago','When did you first notice the problem? This helps identify the disease timeline.'],
  ['suspected_disease','Do you know what disease it might be?','e.g. FMD, lumpy skin - leave blank if unsure','Leave blank if unsure. Only fill if the farmer or vet has already suggested a name.'],
  ['recent_movement','Have the animals moved recently?','e.g. yes, bought from market last week','Movement in the past 2-4 weeks can spread disease. Note if animals were bought, sold, or moved between farms.'],
  ['access_notes','Any access or travel notes?','e.g. gravel road, locked gate - call first',{textarea:true},'Anything that could slow down or block a field visit: road conditions, security, locked gates, flooding, etc.'],
  ['identifying_traits','How do we identify the animals?','e.g. red tag in ear, black-and-white Friesians','Ear tag numbers, coat colour, breed, or any other way to identify the sick animals in a herd.'],
  ['photos','Are there photos?','yes / no, or a description of what they show','If photos were sent on WhatsApp/Discord, write "yes - sent via channel". Otherwise describe what the photo shows.'],
  ['audio','Are there voice notes?','yes / no'],
  ['notes','Anything else to note?','Any extra information',{textarea:true}],
]
const VC_KEYS = new Set(['species','symptoms','location','how_to_find','farmer_available','contact_fallback'])
let intakeCaseId = null    // set when editing existing case; null = new case
let intakeStep = 1         // 1, 2, or 3; only used for new-case wizard
// Build separate HTML strings for step2 (VC fields) and step3 (additional)
function buildFieldsHtml(existingReport){
  let step2='', step3=''
  for(const [k,label,hint,opts={},coaching=''] of INTAKE_FIELDS){
    const val=esc(existingReport[k]||'')
    const req=opts.required?' <span class="intake-req" title="Needed for a field visit">*</span>':''
    const hintId='hint-'+k
    const hintBtn=coaching?`<button type="button" class="intake-hint-btn" aria-expanded="false" aria-label="What to write here: ${esc(label)}" data-hint="${hintId}" title="What to write here">(?)</button>`:'';
    let fld=`<label for="int-${k}">${esc(label)}${req}${hintBtn}</label>`
    if(coaching) fld+=`<div class="intake-hint-box" id="${hintId}">${esc(coaching)}</div>`
    const ariaReq=opts.required?' aria-required="true"':''
    if(opts.textarea){ fld+=`<textarea id="int-${k}" name="${k}" placeholder="${esc(hint)}" rows="2" autocomplete="off"${ariaReq}>${val}</textarea>` }
    else { fld+=`<input id="int-${k}" name="${k}" placeholder="${esc(hint)}" value="${val}" autocomplete="off"${ariaReq}>` }
    if(VC_KEYS.has(k)) step2+=fld; else step3+=fld
  }
  return {step2, step3}
}
function getVcFillCount(valuesObj){
  return [...VC_KEYS].filter(k=>(valuesObj[k]||'').trim()!=='').length
}
function updateVcFillBar(){
  const barEl=document.getElementById('intake-vc-fill-bar')
  if(!barEl) return
  const vals={}
  for(const k of VC_KEYS){ const el=document.getElementById('int-'+k); if(el) vals[k]=el.value||'' }
  // also factor in saved step values from other step if in step3
  for(const [k,v] of Object.entries(window._intakeStep2Values||{})){ if(!vals[k]) vals[k]=v }
  const filled=getVcFillCount(vals)
  const total=[...VC_KEYS].length
  const pct=Math.round(filled/total*100)
  const fillEl=document.getElementById('intake-vc-fill-pct')
  const labelEl=document.getElementById('intake-vc-fill-label')
  if(fillEl){ fillEl.style.width=pct+'%'; fillEl.style.background=filled===total?'var(--accent)':'var(--danger,#c00)' }
  if(labelEl) labelEl.textContent=filled+'/'+total+' visit-critical fields filled'
}
function showIntakeStep(step){
  intakeStep=step
  const isNew=!intakeCaseId
  const {step2,step3}=buildFieldsHtml(window._intakeExistingReport||{})
  if(isNew){
    // step-bar and wizard only for new case
    $('#intake-step-bar').style.display='flex'
    document.getElementById('step-dot-1').className='step-dot'+(step===1?' active':' done')
    document.getElementById('step-dot-2').className='step-dot'+(step===2?' active':(step===3?' done':''))
    document.getElementById('step-dot-3').className='step-dot'+(step===3?' active':'')
    document.getElementById('step-line-1').className='step-line'+(step>1?' done':'')
    document.getElementById('step-line-2').className='step-line'+(step>2?' done':'')
    const labels=['','Contact details','Visit-critical fields','Additional details']
    $('#intake-step-label').textContent='Step '+step+' of 3: '+labels[step]
    if(step===1){
      $('#intake-contact-fields').style.display=''
      $('#intake-report-fields').innerHTML=''
      $('#intake-next').style.display=''; $('#intake-back').style.display='none'; $('#intake-submit').style.display='none'
    } else if(step===2){
      $('#intake-contact-fields').style.display='none'
      $('#intake-report-fields').innerHTML=
        '<div class="intake-vc-fill" id="intake-vc-fill-bar"><span id="intake-vc-fill-label">0/6 visit-critical fields filled</span><div class="bar"><div class="fill" id="intake-vc-fill-pct" style="width:0%"></div></div></div>'+
        '<div class="intake-section-head">Visit-critical fields <span class="intake-vc-note">(needed before a vet can visit)</span></div>'+step2
      $('#intake-next').style.display=''; $('#intake-back').style.display=''; $('#intake-submit').style.display='none'
      updateVcFillBar()
      // wire hint toggles
      document.querySelectorAll('.intake-hint-btn').forEach(btn=>{ btn.onclick=()=>{
        const box=document.getElementById(btn.dataset.hint); if(!box) return
        const open=box.classList.toggle('open'); btn.setAttribute('aria-expanded',open?'true':'false')
      }})
      // live fill bar update
      const rfEl=$('#intake-report-fields')
      if(rfEl._vcH) rfEl.removeEventListener('input',rfEl._vcH)
      rfEl._vcH=()=>updateVcFillBar(); rfEl.addEventListener('input',rfEl._vcH)
    } else {
      $('#intake-contact-fields').style.display='none'
      $('#intake-report-fields').innerHTML='<div class="intake-section-head">Additional details</div>'+step3
      $('#intake-next').style.display='none'; $('#intake-back').style.display=''; $('#intake-submit').style.display=''
      $('#intake-submit').textContent='Save'
    }
  } else {
    // Edit mode: single page with all fields
    $('#intake-step-bar').style.display='none'
    $('#intake-contact-fields').style.display='none'
    $('#intake-report-fields').innerHTML=
      '<div class="intake-vc-fill" id="intake-vc-fill-bar"><span id="intake-vc-fill-label">0/6 visit-critical fields filled</span><div class="bar"><div class="fill" id="intake-vc-fill-pct" style="width:0%"></div></div></div>'+
      '<div class="intake-section-head">Visit-critical fields <span class="intake-vc-note">(needed before a vet can visit)</span></div>'+step2+
      '<div class="intake-section-head" style="margin-top:14px">Additional details</div>'+step3
    $('#intake-next').style.display='none'; $('#intake-back').style.display='none'; $('#intake-submit').style.display=''; $('#intake-submit').textContent='Save'
    updateVcFillBar()
    document.querySelectorAll('.intake-hint-btn').forEach(btn=>{ btn.onclick=()=>{
      const box=document.getElementById(btn.dataset.hint); if(!box) return
      const open=box.classList.toggle('open'); btn.setAttribute('aria-expanded',open?'true':'false')
    }})
    const rfEl=$('#intake-report-fields')
    if(rfEl._vcH) rfEl.removeEventListener('input',rfEl._vcH)
    rfEl._vcH=()=>updateVcFillBar(); rfEl.addEventListener('input',rfEl._vcH)
  }
  $('#intake-error').style.display='none'
}
function openIntakeForm(caseRow){
  intakeCaseId = caseRow ? caseRow.id : null
  const isEdit = !!caseRow
  $('#intake-title').textContent = isEdit ? 'Edit report fields' : 'New case'
  let existingReport = {}
  if(caseRow && caseRow.report){ try{ existingReport=JSON.parse(caseRow.report) }catch{} }
  window._intakeExistingReport = existingReport
  // fill bar is rendered inline in step2/edit-mode via showIntakeStep; hide the old bar element
  const fillBar = $('#intake-fill-bar')
  if(fillBar) fillBar.style.display='none'
  showIntakeStep(1)
  if(!isEdit){
    const draft=restoreDraft()
    if(draft){
      const n=$('#int-name'); if(n&&draft.name) n.value=draft.name
      const p=$('#int-phone'); if(p&&draft.phone) p.value=draft.phone
      const s=$('#int-subject'); if(s&&draft.subject) s.value=draft.subject
      for(const [k] of INTAKE_FIELDS){ const el=document.getElementById('int-'+k); if(el&&draft[k]) el.value=draft[k] }
      setTimeout(()=>toast('Draft restored - fill in the rest and save','ok'),200)
    }
    // auto-save draft on any input change; remove any prior listener first
    const ovl=$('#intake-ovl')
    if(ovl._draftH) ovl.removeEventListener('input',ovl._draftH)
    const saveH=()=>saveDraft()
    ovl._draftH=saveH
    ovl.addEventListener('input',saveH)
  }
  $('#intake-ovl').classList.add('show')
  setTimeout(()=>{ if(isEdit) document.getElementById('int-species')?.focus()
    else document.getElementById('int-name')?.focus() }, 80)
}
function saveDraft(){
  if(intakeCaseId) return // only save drafts for new-case mode
  const d={}
  const n=$('#int-name'); if(n) d.name=n.value
  const p=$('#int-phone'); if(p) d.phone=p.value
  const s=$('#int-subject'); if(s) d.subject=s.value
  for(const [k] of INTAKE_FIELDS){ const el=document.getElementById('int-'+k); if(el) d[k]=el.value }
  // Fill gaps from saved step values (DOM wins; saved values fill fields not currently rendered)
  for(const [k,v] of Object.entries(window._intakeStep2Values||{})){ if(d[k]==null) d[k]=v }
  for(const [k,v] of Object.entries(window._intakeStep3Values||{})){ if(d[k]==null) d[k]=v }
  try{localStorage.casey_draft_case=JSON.stringify(d)}catch{}
}
function clearDraft(){ try{localStorage.removeItem('casey_draft_case')}catch{} }
function restoreDraft(){
  try{
    const raw=localStorage.casey_draft_case; if(!raw) return null
    return JSON.parse(raw)
  }catch{ return null }
}
function closeIntakeOvl(){ $('#intake-ovl').classList.remove('show'); intakeCaseId=null; window._intakeExistingReport={}; window._intakeStep2Values={}; window._intakeStep3Values={} }
$('#intake-next').onclick=()=>{
  const errEl=$('#intake-error')
  if(intakeStep===1){
    // step 1 -> step 2: no required fields, just advance
    errEl.style.display='none'
    showIntakeStep(2)
    // restore any draft VC values
    const draft2=restoreDraft()
    if(draft2){ for(const [k] of INTAKE_FIELDS.filter(([k])=>VC_KEYS.has(k))){ const el=document.getElementById('int-'+k); if(el&&draft2[k]&&!el.value) el.value=draft2[k] } }
    updateVcFillBar()
    document.getElementById('int-species')?.focus()
  } else if(intakeStep===2){
    // step 2 -> step 3: at least species required
    const species=(document.getElementById('int-species')||{}).value||''
    if(!species.trim()){ errEl.textContent='Please fill in at least the animal type (which animals?)'; errEl.style.display=''; return }
    errEl.style.display='none'
    // preserve step2 VC values
    window._intakeStep2Values={}
    for(const [k] of INTAKE_FIELDS.filter(([k])=>VC_KEYS.has(k))){
      window._intakeStep2Values[k]=(document.getElementById('int-'+k)||{}).value||''
    }
    showIntakeStep(3)
    // restore step3 draft values
    const draft3=restoreDraft()
    if(draft3){ for(const [k] of INTAKE_FIELDS.filter(([k])=>!VC_KEYS.has(k))){ const el=document.getElementById('int-'+k); if(el&&draft3[k]&&!el.value) el.value=draft3[k] } }
    document.getElementById('int-affected_count')?.focus()
  }
}
$('#intake-back').onclick=()=>{
  const errEl=$('#intake-error')
  errEl.style.display='none'
  if(intakeStep===2){
    showIntakeStep(1)
    document.getElementById('int-name')?.focus()
  } else if(intakeStep===3){
    // preserve step3 values before going back
    window._intakeStep3Values={}
    for(const [k] of INTAKE_FIELDS.filter(([k])=>!VC_KEYS.has(k))){
      window._intakeStep3Values[k]=(document.getElementById('int-'+k)||{}).value||''
    }
    showIntakeStep(2)
    // restore step2 VC values
    if(window._intakeStep2Values){ for(const [k,v] of Object.entries(window._intakeStep2Values)){ const el=document.getElementById('int-'+k); if(el) el.value=v } }
    updateVcFillBar()
    document.getElementById('int-species')?.focus()
  }
}
$('#intake-cancel').onclick=()=>{ clearDraft(); closeIntakeOvl() }
$('#intake-ovl').addEventListener('click',e=>{ if(e.target===$('#intake-ovl')) closeIntakeOvl() })
// Normalize SA phone number on blur: 0XXXXXXXXX -> +27XXXXXXXXX
const intPhoneEl=$('#int-phone')
if(intPhoneEl) intPhoneEl.addEventListener('blur',()=>{
  const v=intPhoneEl.value.trim()
  if(!v) return
  const d=v.replace(/[^0-9+]/g,'')
  if(/^0[0-9]{9}$/.test(d)){intPhoneEl.value='+27'+d.slice(1);intPhoneEl.style.borderColor='';return}
  if(/^27[0-9]{9}$/.test(d)){intPhoneEl.value='+'+d;intPhoneEl.style.borderColor='';return}
  if(/^[+]27[0-9]{9}$/.test(d)){intPhoneEl.style.borderColor='';return}
  intPhoneEl.style.borderColor='var(--danger,#c00)'
})
// Escape closes the overlay; Enter on input fields advances (Next) or submits (Save); Tab order is natural DOM order
document.addEventListener('keydown',e=>{
  if(!$('#intake-ovl').classList.contains('show')) return
  if(e.key==='Escape'){ e.preventDefault(); closeIntakeOvl(); return }
  if(e.key==='Enter'&&e.target.tagName==='INPUT'&&!e.defaultPrevented){
    e.preventDefault()
    const next=$('#intake-next'); const sub=$('#intake-submit')
    if(next&&next.style.display!=='none') next.click()
    else if(sub&&sub.style.display!=='none') sub.click()
  }
})
$('#intake-submit').onclick=async()=>{
  const btn=$('#intake-submit'); btn.disabled=true
  const errEl=$('#intake-error'); errEl.style.display='none'
  try{
    let caseId=intakeCaseId
    if(!caseId){
      const rawPhone=$('#int-phone').value.trim()
      if(rawPhone){
        const digits=rawPhone.replace(/[^0-9+]/g,'')
        if(!/^0[0-9]{9}$/.test(digits)&&!/^[+]27[0-9]{9}$/.test(digits)){
          errEl.textContent='Phone must be a South African number: 0821234567 or +27821234567'
          errEl.style.display=''; btn.disabled=false; return
        }
      }
      // create new case
      const body={
        name:$('#int-name').value.trim(),
        phone:rawPhone,
        subject:$('#int-subject').value.trim()||'Field report'
      }
      const r=await api('/api/cases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      if(r.status===409){
        const e=await r.json().catch(()=>({}))
        btn.disabled=false
        const dlg=await showDialog({title:'Case already exists',message:(e.error||'A case already exists for this contact')+' ('+esc(e.existing_ref||'')+').',confirmLabel:'Open existing case',cancelLabel:'Cancel'})
        if(dlg){ $('#intake-ovl').classList.remove('show'); intakeCaseId=null; await openCase(e.existing_id) }
        return
      }
      if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||'Failed to create case') }
      const j=await r.json(); caseId=j.id
    }
    // gather report fields (skip blanks)
    // For new cases: VC fields in _intakeStep2Values, additional in DOM (step3); edit mode all in DOM.
    const report={}
    const step2Saved=window._intakeStep2Values||{}
    for(const [k] of INTAKE_FIELDS){
      const domEl=document.getElementById('int-'+k)
      const v=domEl ? domEl.value : (step2Saved[k]||'')
      if(v.trim()) report[k]=v.trim()
    }
    if(Object.keys(report).length){
      const r2=await api('/api/cases/'+encodeURIComponent(caseId)+'/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})
      if(!r2.ok){ const e=await r2.json().catch(()=>({})); throw new Error(e.error||'Failed to save report - your data is preserved, please try again') }
    }
    const wasEdit=!!intakeCaseId
    if(!wasEdit) clearDraft()
    $('#intake-ovl').classList.remove('show'); intakeCaseId=null
    toast(wasEdit?'Report updated':'Case created','ok')
    lastCasesJson=''; await loadCases(); await openCase(caseId)
  } catch(e){
    errEl.textContent=e.message
    errEl.style.display=''
    // ensure draft is saved so data is not lost on error
    saveDraft()
  }
  btn.disabled=false
}
$('#new-case-btn').onclick=()=>openIntakeForm(null)
// --- export CSV (fetch via api() so the login session cookie rides along, then save as blob) ---
// Note: the server CSV already has an intake_source column; if a source filter is
// active the filename suffix reminds the operator that the export is unfiltered.
$('#export-btn').onclick=async()=>{
  const params=new URLSearchParams()
  if(filt.status) params.set('status',filt.status)
  if(filt.channel) params.set('channel',filt.channel)
  if(filt.source) toast('Note: CSV export includes all sources; intake_source column lets you filter in your spreadsheet','ok')
  const url='/api/cases/export.csv'+(params.toString()?'?'+params.toString():'')
  try{
    const r=await api(url)
    if(!r.ok){ toast('Export failed: '+r.status,'err'); return }
    const blob=await r.blob()
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='casey-cases.csv'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(()=>URL.revokeObjectURL(a.href),5000)
  }catch(e){ toast('Export failed: '+e.message,'err') }
}
const sweepBtn=$('#sweep-btn')
if(sweepBtn) sweepBtn.onclick=async()=>{
  sweepBtn.disabled=true
  const r=await api('/api/sweep',{method:'POST'})
  sweepBtn.disabled=false
  if(r.status===501){ toast('Sweep not available in dashboard-only mode','err'); return }
  if(!r.ok){ toast(await failMsg(r,'sweep failed'),'err'); return }
  const j=await r.json().catch(()=>({}))
  toast('Sweep done'+(j.scanned!=null?' -- '+j.scanned+' checked, '+j.flagged+' flagged, '+j.cleared+' cleared':''),'ok')
  lastCasesJson=''; await loadCases(); refreshAttention()
}
// --- intake stats panel ---
let statsOpen=false
const statsBtn=$('#stats-btn')
const statsPanel=$('#stats-panel')
async function loadStats(){
  const grid=$('#stats-grid'); if(!grid) return
  grid.innerHTML='<div class="empty" style="grid-column:1/-1;padding:8px 0">Loading...</div>'
  try{
    const j=await api('/api/stats').then(r=>r.ok?r.json():null)
    if(!j){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">Could not load stats.</div>'; return }
    const MODE_LABEL={channel:'AI (channel)',manual:'Operator entry',public_form:'Public form',unknown:'Untagged'}
    if(!Object.keys(j.by_mode).length){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">No data yet.</div>'; return }
    grid.innerHTML=Object.entries(j.by_mode).map(([mode,s])=>{
      const vcPct=s.vc_total?Math.round(s.vc_complete/s.count*100):0
      return `<div class="stats-card">
        <div class="sc-mode">${esc(MODE_LABEL[mode]||mode)}</div>
        <div class="sc-count">${s.count}</div>
        <div class="sc-detail">avg ${s.avg_filled??'-'}/${s.total_fields} fields filled</div>
        <div class="sc-vc">${s.vc_complete}/${s.count} visit-ready (${vcPct}%)</div>
        <div class="sc-detail">avg ${s.avg_vc_filled??'-'}/${s.vc_total} essential</div>
      </div>`
    }).join('')
  }catch(e){ grid.innerHTML='<div class="empty" style="grid-column:1/-1">Stats error: '+esc(e.message)+'</div>' }
}
if(statsBtn) statsBtn.onclick=async()=>{
  statsOpen=!statsOpen
  statsPanel.classList.toggle('show',statsOpen)
  statsBtn.classList.toggle('active',statsOpen)
  if(statsOpen) await loadStats()
}
// --- tunable health thresholds (plain-language settings) ---
// Each scalar threshold is stored in ms; operators tune it in hours. The label
// and help text are plain words so a non-technical team can retune the windows.
const THRESH_META={
  handoffMs:['Wait after a contact asks for a person','How long to wait before flagging that nobody has stepped in yet.'],
  escalateHandoffMs:['Escalate an unanswered handoff','After this long with no human reply, the case is raised more urgently.'],
  staleMs:['No activity at all','How long a case can go quiet before it is flagged as going stale.'],
  abandonMs:['Half-finished intake left sitting','A case that started but never finished gathering details is flagged after this.'],
  incompleteCriticalMs:['Missing essential visit details','How long an actionable case may lack must-have fields before flagging.'],
  neverClosedMs:['Open far too long','A case still open past this is surfaced as overdue.'],
  unsentDraftMs:['Unsent AI draft waiting','How long an assisted draft can wait for an operator before it is flagged.'],
}
let settingsOpen=false
const settingsBtn=$('#settings-btn')
const settingsPanel=$('#settings-panel')
function hoursOf(ms){ return Math.round((ms/3600000)*10)/10 }
async function loadThresholds(){
  const body=$('#settings-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{
    const j=await api('/api/thresholds').then(r=>r.ok?r.json():null)
    if(!j){ body.innerHTML='<div class="empty">Could not load settings.</div>'; return }
    const t=j.thresholds||{}
    const rows=Object.keys(THRESH_META).filter(k=>t[k]!=null).map(k=>{
      const [lab,help]=THRESH_META[k]
      return '<div class="set-row"><label>'+esc(lab)+'</label>'
        +'<div class="set-in"><input type="number" min="0" step="0.5" data-key="'+esc(k)+'" value="'+hoursOf(t[k])+'"> <span>hours</span></div>'
        +'<p class="hint">'+esc(help)+'</p></div>'
    }).join('')
    body.innerHTML=rows+'<button id="settings-save">Save</button>'
      +'<span class="set-state">'+(j.customized?'Using your tuned values':'Using the shipped defaults')+'</span>'
    const save=$('#settings-save')
    if(save) save.onclick=async()=>{
      save.disabled=true
      const patch={}
      body.querySelectorAll('input[data-key]').forEach(inp=>{
        const v=parseFloat(inp.value); if(Number.isFinite(v)) patch[inp.dataset.key]=Math.round(v*3600000)
      })
      const r=await api('/api/thresholds',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(patch)})
      save.disabled=false
      if(!r.ok){ toast(await failMsg(r,'save failed'),'err'); return }
      toast('settings saved','ok'); await loadThresholds()
    }
  }catch(e){ body.innerHTML='<div class="empty">Settings error: '+esc(e.message)+'</div>' }
}
if(settingsBtn) settingsBtn.onclick=async()=>{
  settingsOpen=!settingsOpen
  settingsPanel.classList.toggle('show',settingsOpen)
  settingsBtn.classList.toggle('active',settingsOpen)
  if(settingsOpen) await loadThresholds()
}
// --- Metrics / Outbreaks / Hotspots panels ---
function fmtDur(ms){ if(ms==null) return '--'; const s=Math.round(ms/1000); const m=Math.round(s/60); if(m<60) return m+'m'; const h=Math.round(m/60); if(h<48) return h+'h'; return Math.round(h/24)+'d' }
const STAGE_LABELS_M={new:'New',triaging:'Triage',in_progress:'In progress',waiting:'Waiting',resolved:'Resolved',closed:'Closed'}
function loadMetricsHtml(j){
  const fr=j.first_response_ms||{}
  const dwell=j.dwell_ms_median||{}, backlog=j.backlog_by_stage||{}
  const card=(lab,val,sub)=>'<div class="stats-card"><div class="sc-mode">'+esc(lab)+'</div><div class="sc-count">'+esc(val)+'</div>'+(sub?'<div class="sc-detail">'+esc(sub)+'</div>':'')+'</div>'
  const dwellRows=Object.keys(dwell).map(s=>card(STAGE_LABELS_M[s]||s,fmtDur(dwell[s]),'median dwell')).join('')
  const backlogRows=Object.keys(backlog).map(s=>card(STAGE_LABELS_M[s]||s,backlog[s],'open now')).join('')
  // opened-vs-closed sparklines over the per-day buckets
  const days=Object.keys(Object.assign({},j.opened_by_day,j.closed_by_day)).sort()
  const opened=days.map(d=>j.opened_by_day[d]||0), closed=days.map(d=>j.closed_by_day[d]||0)
  const trend=days.length
    ? '<div class="metric-trend"><div>Opened per day '+sparkline(opened,160,28)+' <b>'+opened.reduce((a,b)=>a+b,0)+'</b></div>'
      +'<div>Closed per day '+sparkline(closed,160,28)+' <b>'+closed.reduce((a,b)=>a+b,0)+'</b></div></div>'
    : ''
  return '<div class="stats-grid">'
    +card('Median first reply',fmtDur(fr.median),'p90 '+fmtDur(fr.p90)+' ('+(fr.n||0)+' answered)')
    +card('Open',j.cases?j.cases.open:0,'cases')
    +card('Closed',j.cases?j.cases.closed:0,'cases')
    +dwellRows+backlogRows+'</div>'+trend
}
const CASE_TYPE_LABEL={unset:'Unclassified',outbreak:'Outbreak',follow_up:'Follow-up',lab_sample:'Lab sample',import_alert:'Import alert'}
function ctLabel(t){ return CASE_TYPE_LABEL[t]||t }
function slaMetPct(s){ return s&&s.considered?Math.round((s.met_count||0)/s.considered*100)+'%':'--' }
function slaRow(label,s,m,cls){
  const late=(s&&s.breached_by_reason&&s.breached_by_reason.answered_late)
  const never=(s&&s.breached_by_reason&&s.breached_by_reason.never_answered)
  return '<tr'+(cls?' class="'+cls+'"':'')+'><td>'+label+'</td><td>'+esc(s&&s.considered!=null?s.considered:'--')+'</td><td>'+esc(slaMetPct(s))
    +'</td><td>'+esc(late!=null?late:'--')+'</td><td>'+esc(never!=null?never:'--')
    +'</td><td>'+fmtDur(m?m.first_response_ms_median:null)+'</td><td>'+esc(m&&m.closed_pct!=null?m.closed_pct+'%':'--')+'</td></tr>'
}
function byTypeHtml(rep){
  const sbt=(rep&&rep.sla_by_type&&rep.sla_by_type.by_type)||{}
  const ov=(rep&&rep.sla_by_type&&rep.sla_by_type.overall)||null
  const met=(rep&&rep.by_case_type)||{}
  const types=Array.from(new Set([...Object.keys(sbt),...Object.keys(met)]))
  if(!types.length) return ''
  const rows=types.map(t=>slaRow(esc(ctLabel(t)),sbt[t],met[t])).join('')
  const ovRow=ov?slaRow('<b>Overall</b>',ov,null,'bt-overall'):''
  return '<div class="bt-sec"><div class="ho-h">By case type</div>'
    +'<table class="bt-table"><thead><tr><th>Type</th><th>Cases</th><th>SLA met</th><th>Late</th><th>Never</th><th>1st reply</th><th>Closed</th></tr></thead>'
    +'<tbody>'+rows+ovRow+'</tbody></table></div>'
}
function atRiskByTypeHtml(j){
  // /api/sla-at-risk/by-type returns by_type[t] as a plain count (atRiskCount).
  const bt=(j&&j.by_type)||{}
  const types=Object.keys(bt).filter(t=>(bt[t]||0)>0)
  if(!types.length) return ''
  const tgt=j.sla_target_ms!=null?fmtDur(j.sla_target_ms):''
  const chips=types.sort((a,b)=>(bt[b]||0)-(bt[a]||0)).map(t=>
    '<span class="risk-chip" title="open cases of this type within reach of the '+esc(tgt)+' reply target">'+esc(ctLabel(t))+' <b>'+esc(bt[t])+'</b></span>').join(' ')
  return '<div class="bt-sec"><div class="ho-h">At risk now (reply target '+esc(tgt)+')</div><div class="risk-strip">'+chips+'</div></div>'
}
async function loadMetrics(){
  const body=$('#metrics-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/overview?days=14').then(r=>r.ok?r.json():null)
    const rep=await api('/api/report.json?days=14').then(r=>r.ok?r.json():null).catch(()=>null)
    const risk=await api('/api/sla-at-risk/by-type').then(r=>r.ok?r.json():null).catch(()=>null)
    body.innerHTML=(j?loadMetricsHtml(j):'<div class="empty">Could not load metrics.</div>')
      +(risk?atRiskByTypeHtml(risk):'')+(rep?byTypeHtml(rep):'')
  }catch(e){ body.innerHTML='<div class="empty">Metrics error: '+esc(e.message)+'</div>' }
}
function clustersHtml(j){
  const cl=j.clusters||[]
  if(!cl.length) return '<div class="empty" style="padding:8px 0">No related-looking groups right now.</div>'
  return cl.map(c=>{
    const loc=(c.location||[]).join(', '), sp=(c.species||[]).join(', '), sym=(c.symptoms||[]).join(', ')
    const reported=(c.reported_disease_names||[]).join(', ')
    const chips=(c.members||[]).map(m=>'<button class="ref-chip" data-id="'+esc(m.id)+'" title="'+esc((m.case_type&&m.case_type!=='unset'?m.case_type+': ':'')+(m.subject||''))+'">'+esc(m.ref)+'</button>').join(' ')
    // symptoms is what was actually seen/reported -- shown plainly. reported_disease_names
    // is only ever the farmer/worker's own unverified guess, so it is always qualified
    // "as reported" and never rendered as if it were a determined diagnosis. No severity
    // score -- the raw member count and shared fields are the whole signal; the team
    // reads the pattern and judges for themselves.
    return '<div class="cl-row"><div class="cl-head"><b>'+c.count+' cases</b>'
      +(loc?' near '+esc(loc):'')+(sp?' -- '+esc(sp):'')+'</div>'
      +(sym?'<div class="cl-sub">symptoms: '+esc(sym)+'</div>':'')
      +(reported?'<div class="cl-sub" title="Named by the worker/farmer, not a lab result">as reported: '+esc(reported)+'</div>':'')
      +'<div class="cl-chips">'+chips+'</div></div>'
  }).join('')
}
async function loadClusters(){
  const body=$('#clusters-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/clusters').then(r=>r.ok?r.json():null)
    body.innerHTML=j?clustersHtml(j):'<div class="empty">Could not load related-case groups.</div>'
    body.querySelectorAll('.ref-chip').forEach(b=>b.onclick=()=>openCase(b.dataset.id))
  }catch(e){ body.innerHTML='<div class="empty">Related-reports error: '+esc(e.message)+'</div>' }
}
function distributionHtml(j){
  const species=j.species||[], symptoms=j.symptoms||[]
  if(!species.length && !symptoms.length) return '<div class="empty" style="padding:8px 0">No species or symptom data recorded yet.</div>'
  const bar=(rows,max)=>rows.map(r=>{
    const pct=max?Math.round(100*r.count/max):0
    return '<div class="dist-row"><span class="dist-token">'+esc(r.token)+'</span>'
      +'<span class="dist-bar-track"><span class="dist-bar-fill" style="width:'+pct+'%"></span></span>'
      +'<span class="dist-count">'+r.count+'</span></div>'
  }).join('')
  const maxSp=species.length?species[0].count:0, maxSym=symptoms.length?symptoms[0].count:0
  return '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">'
    +j.total_cases+' open case(s), '+j.cases_with_species_or_symptom+' with species or symptoms recorded</div>'
    +(species.length?'<div class="dist-group"><div class="dist-title">Species</div>'+bar(species,maxSp)+'</div>':'')
    +(symptoms.length?'<div class="dist-group"><div class="dist-title">Symptoms</div>'+bar(symptoms,maxSym)+'</div>':'')
}
async function loadDistribution(){
  const body=$('#distribution-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/distribution').then(r=>r.ok?r.json():null)
    body.innerHTML=j?distributionHtml(j):'<div class="empty">Could not load distribution.</div>'
  }catch(e){ body.innerHTML='<div class="empty">Distribution error: '+esc(e.message)+'</div>' }
}
function geoHtml(j){
  const places=j.places||[]
  if(!places.length) return '<div class="empty" style="padding:8px 0">No location data yet.</div>'
  return '<div class="geo-list">'+places.map(p=>{
    const mix=Object.entries(p.species||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([s,n])=>esc(s)+' x'+n).join(', ')
    return '<div class="geo-row"><span class="geo-place">'+esc(p.place)+'</span>'
      +'<span class="geo-count">'+p.count+'</span>'
      +'<span class="geo-mix">'+(mix||'--')+'</span>'
      +'<span class="geo-when">'+esc(p.latest?fmtTime(p.latest):'')+'</span></div>'
  }).join('')+'</div>'
}
async function loadGeo(){
  const body=$('#geo-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/geo').then(r=>r.ok?r.json():null)
    body.innerHTML=j?geoHtml(j):'<div class="empty">Could not load hotspots.</div>'
  }catch(e){ body.innerHTML='<div class="empty">Hotspots error: '+esc(e.message)+'</div>' }
}
function panelToggle(btnId,panelId,loader){
  const btn=$(btnId), panel=$(panelId); let open=false
  if(btn) btn.onclick=async()=>{ open=!open; panel.classList.toggle('show',open); btn.classList.toggle('active',open); if(open) await loader() }
}
panelToggle('#metrics-btn','#metrics-panel',loadMetrics)
panelToggle('#distribution-btn','#distribution-panel',loadDistribution)
panelToggle('#clusters-btn','#clusters-panel',loadClusters)
panelToggle('#geo-btn','#geo-panel',loadGeo)
panelToggle('#map-btn','#map-panel',loadMap)

// --- Case map (Leaflet + OSM tiles, no API key) ---
const STATUS_COLOR={new:'#3b6ea5',triaging:'#a5843b',in_progress:'#3ba55d',waiting:'#9a6bd1',resolved:'#6b7685',closed:'#3d4148'}
let mapState=null   // { map, markerLayer, clusterLines, coverageLayer, pins, clusters, showCoverage, showClusters }
function mapMarkerIcon(color){
  return window.L.divIcon({className:'',html:'<div style="width:14px;height:14px;border-radius:50%;background:'+color+';border:2px solid rgba(255,255,255,.8);box-shadow:0 0 2px rgba(0,0,0,.5)"></div>',iconSize:[14,14]})
}
function mapPopupHtml(p){
  const counts=[p.affected_count!=null?p.affected_count+' affected':'',p.dead_count!=null?p.dead_count+' dead':''].filter(Boolean).join(', ')
  return '<div><b>'+esc(p.ref)+'</b> <span style="color:var(--muted)">'+esc(p.status)+'</span><br>'
    +(p.species?esc(p.species)+'<br>':'')
    +(p.case_type&&p.case_type!=='unset'?esc(p.case_type)+'<br>':'')
    +(p.location?esc(p.location)+'<br>':'')
    +(p.symptoms?'<span title="As reported/observed">symptoms: '+esc(p.symptoms)+'</span><br>':'')
    +(counts?esc(counts)+'<br>':'')
    +(p.onset?'onset: '+esc(p.onset)+'<br>':'')
    +(p.assignee&&p.assignee!=='agent'?'assigned: '+esc(p.assignee)+'<br>':'')
    +'<a href="#" data-open-ref="'+esc(p.id)+'">Open case</a>'
    +' | <a href="#" data-dispatch-ref="'+esc(p.id)+'" title="Suggest a field worker for this case -- never messages them directly, they hear about it on their own next reply-in">Dispatch a worker</a></div>'
}
// dispatch-from-map: opens a small worker picker (nearest-first, from the
// currently-loaded worker overlay -- toggling the workers layer on first
// populates mapState.workers) and posts the operator's choice. Never sends
// anything to the worker directly -- see the /api/cases/:id/dispatch route
// comment for the full cost-policy rationale (queued suggestion only, the
// worker hears about it on their own next reply-in).
function haversineKm(lat1,lon1,lat2,lon2){
  const R=6371, toRad=d=>d*Math.PI/180
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1)
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
  return R*2*Math.asin(Math.sqrt(a))
}
// Small bespoke picker (showDialog above has no select-list support and is
// used in many places -- a dedicated overlay here avoids risking a regression
// there). Resolves {workerId, note} or null on cancel.
function showWorkerPicker(title, message, workers){
  return new Promise(function(resolve){
    function mk(tag, css, txt){ const el=document.createElement(tag); if(css) el.style.cssText=css; if(txt!=null) el.textContent=txt; return el }
    const overlay=mk('div','position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true')
    const card=mk('div','background:var(--panel);border:1px solid var(--border);border-radius:10px;max-width:420px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px')
    card.appendChild(mk('h3','margin:0 0 8px;font-size:16px',title))
    card.appendChild(mk('p','margin:0 0 10px;color:var(--muted);line-height:1.5',message))
    const sel=document.createElement('select')
    sel.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;margin-bottom:10px'
    for(const w of workers){
      const o=document.createElement('option'); o.value=w.id
      o.textContent=(w.display_name||'field worker')+(w.km!=null?' ('+w.km.toFixed(1)+'km'+(w.stale?', stale':'')+')':w.stale?' (stale)':'')
      sel.appendChild(o)
    }
    card.appendChild(sel)
    const noteLab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)','Optional note for the team')
    card.appendChild(noteLab)
    const noteInp=document.createElement('textarea'); noteInp.rows=2
    noteInp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;resize:vertical'
    card.appendChild(noteInp)
    const row=mk('div','display:flex;gap:8px;margin-top:14px;justify-content:flex-end')
    const cancelBtn=mk('button','background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0','Cancel')
    const okBtn=mk('button','background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0','Suggest dispatch')
    row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    const close=function(confirmed){ overlay.remove(); resolve(confirmed?{workerId:sel.value,note:noteInp.value||''}:null) }
    okBtn.onclick=function(){ close(true) }
    cancelBtn.onclick=function(){ close(false) }
    overlay.addEventListener('keydown',function(e){ if(e.key==='Escape') close(false) })
    setTimeout(function(){ sel.focus() },60)
  })
}
async function openDispatchPicker(caseId, caseLat, caseLon){
  const workers=(mapState&&mapState.workers)||[]
  if(!workers.length){
    toast('No field-worker locations loaded yet -- turn on the worker overlay first ("Workers" map button) so there is someone to pick from.','warn')
    return
  }
  const withDist=workers.map(w=>({...w,km:(caseLat!=null&&caseLon!=null&&Number.isFinite(w.lat)&&Number.isFinite(w.lon))?haversineKm(caseLat,caseLon,w.lat,w.lon):null}))
    .sort((a,b)=>(a.km??Infinity)-(b.km??Infinity))
  const picked=await showWorkerPicker(
    'Dispatch a worker to this case',
    'This only records a suggestion -- casey never messages a worker unprompted (cost-policy invariant). They will hear about it the next time they message in.',
    withDist,
  )
  if(!picked) return
  const worker=withDist.find(w=>w.id===picked.workerId)
  try{
    const r=await api('/api/cases/'+encodeURIComponent(caseId)+'/dispatch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worker_id:picked.workerId,note:picked.note})})
    if(!r.ok){ toast(await failMsg(r,'Could not record the dispatch suggestion'),'err'); return }
    toast('Dispatch suggested -- '+((worker&&worker.display_name)||'the worker')+' will hear about it on their own next reply-in','ok')
  }catch(e){ toast('Dispatch error: '+e.message,'err') }
}
function applyMapFilters(pins){
  const sp=$('#map-species')?.value||'', ty=$('#map-type')?.value||'', st=$('#map-status')?.value||''
  return pins.filter(p=>
    (!sp||String(p.species||'').toLowerCase().includes(sp.toLowerCase()))
    && (!ty||p.case_type===ty)
    && (!st||p.status===st))
}
function renderMapMarkers(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.markerLayer) map.removeLayer(mapState.markerLayer)
  if(mapState.clusterLines) map.removeLayer(mapState.clusterLines)
  const filtered=applyMapFilters(mapState.pins)
  const layer=window.L.markerClusterGroup({maxClusterRadius:40})
  for(const p of filtered){
    const m=window.L.marker([p.lat,p.lon],{icon:mapMarkerIcon(STATUS_COLOR[p.status]||'#6b7685')})
    m.bindPopup(mapPopupHtml(p))
    m.on('popupopen',()=>{
      const el=document.querySelector('[data-open-ref="'+p.id+'"]')
      if(el) el.onclick=(e)=>{e.preventDefault(); openCase(p.id)}
      const dEl=document.querySelector('[data-dispatch-ref="'+p.id+'"]')
      if(dEl) dEl.onclick=(e)=>{e.preventDefault(); openDispatchPicker(p.id,p.lat,p.lon)}
    })
    layer.addLayer(m)
  }
  map.addLayer(layer)
  mapState.markerLayer=layer
  if(mapState.showClusters){
    const lines=window.L.layerGroup()
    const byIdx=new Map()
    for(const p of filtered){ if(p.cluster==null) continue; if(!byIdx.has(p.cluster)) byIdx.set(p.cluster,[]); byIdx.get(p.cluster).push(p) }
    for(const [,members] of byIdx){
      if(members.length<2) continue
      for(let i=1;i<members.length;i++){
        window.L.polyline([[members[0].lat,members[0].lon],[members[i].lat,members[i].lon]],{color:'#c0392b',weight:1,opacity:.5,dashArray:'4,4'}).addTo(lines)
      }
    }
    lines.addTo(map)
    mapState.clusterLines=lines
  }
}
async function loadMap(){
  const canvas=$('#map-canvas'); if(!canvas) return
  try{
    const days=$('#map-days')?.value||'0'
    const j=await api('/api/map/cases?days='+encodeURIComponent(days)).then(r=>r.ok?r.json():null)
    if(!j){ canvas.innerHTML='<div class="empty">Could not load the map.</div>'; return }
    if(!mapState){
      canvas.innerHTML=''
      const map=window.L.map(canvas,{center:[-28.5,25],zoom:5})
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'(c) OpenStreetMap contributors'}).addTo(map)
      mapState={map,markerLayer:null,clusterLines:null,coverageLayer:null,workersLayer:null,lastReportsLayer:null,pins:[],clusters:[],showCoverage:false,showClusters:false,showWorkers:false,showLastReports:false}
      $('#map-species').onchange=renderMapMarkers
      $('#map-type').onchange=renderMapMarkers
      $('#map-status').onchange=renderMapMarkers
      $('#map-days').onchange=loadMap
      $('#map-clusters-btn').onclick=()=>{ mapState.showClusters=!mapState.showClusters; $('#map-clusters-btn').classList.toggle('active',mapState.showClusters); renderMapMarkers() }
      $('#map-coverage-btn').onclick=async()=>{ mapState.showCoverage=!mapState.showCoverage; $('#map-coverage-btn').classList.toggle('active',mapState.showCoverage); await renderMapCoverage() }
      const workersBtn=$('#map-workers-btn')
      if(workersBtn) workersBtn.onclick=async()=>{ mapState.showWorkers=!mapState.showWorkers; workersBtn.classList.toggle('active',mapState.showWorkers); await renderMapWorkers() }
      const lastReportsBtn=$('#map-last-reports-btn')
      if(lastReportsBtn) lastReportsBtn.onclick=async()=>{ mapState.showLastReports=!mapState.showLastReports; lastReportsBtn.classList.toggle('active',mapState.showLastReports); await renderMapLastReports() }
    }
    mapState.pins=j.pins||[]
    mapState.clusters=j.clusters||[]
    // Populate species/type/status filter options from the actual data, once.
    const spSel=$('#map-species'), tySel=$('#map-type'), stSel=$('#map-status')
    if(spSel && spSel.options.length<=1){
      const species=[...new Set(mapState.pins.map(p=>p.species).filter(Boolean))].sort()
      for(const s of species){ const o=document.createElement('option'); o.value=s; o.textContent=s; spSel.appendChild(o) }
    }
    if(tySel && tySel.options.length<=1){
      const types=[...new Set(mapState.pins.map(p=>p.case_type).filter(t=>t&&t!=='unset'))].sort()
      for(const t of types){ const o=document.createElement('option'); o.value=t; o.textContent=t; tySel.appendChild(o) }
    }
    if(stSel && stSel.options.length<=1){
      const statuses=[...new Set(mapState.pins.map(p=>p.status))].sort()
      for(const s of statuses){ const o=document.createElement('option'); o.value=s; o.textContent=s; stSel.appendChild(o) }
    }
    $('#map-legend').innerHTML=Object.entries(STATUS_COLOR).map(([k,c])=>
      '<span><span class="sw" style="background:'+c+'"></span>'+esc(k)+'</span>').join('')
    renderMapMarkers()
    const u=j.unresolved_count||0
    $('#map-unresolved').textContent = u
      ? u+' case(s) have no placeable location yet (no GPS, and location text did not match a known area) -- not shown on the map.'
      + (j.truncated ? ' Showing the most recent '+j.cap+' of '+j.total_considered+' considered.' : '')
      : (j.truncated ? 'Showing the most recent '+j.cap+' of '+j.total_considered+' considered.' : '')
    // The unresolved rows carry real report content (species/symptoms/location text)
    // even without a coordinate -- surface them as a list, not just a count, so an
    // operator can see WHAT each un-mapped report says rather than only how many exist.
    const listEl=$('#map-unresolved-list')
    if(listEl){
      listEl.innerHTML = (j.unresolved||[]).map(p=>
        '<div style="padding:3px 0;border-bottom:1px solid var(--border)">'
        +'<a href="#" data-open-ref="'+esc(p.id)+'"><b>'+esc(p.ref)+'</b></a> '
        +'<span style="color:var(--muted)">'+esc(p.status)+'</span>'
        +(p.species?' -- '+esc(p.species):'')
        +(p.location?' ('+esc(p.location)+')':'')
        +(p.symptoms?' -- '+esc(p.symptoms):'')
        +'</div>'
      ).join('')
      listEl.querySelectorAll('[data-open-ref]').forEach(a=>a.onclick=(e)=>{e.preventDefault(); openCase(a.dataset.openRef)})
    }
  }catch(e){ canvas.innerHTML='<div class="empty">Map error: '+esc(e.message)+'</div>' }
}
async function renderMapCoverage(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.coverageLayer){ map.removeLayer(mapState.coverageLayer); mapState.coverageLayer=null }
  if(!mapState.showCoverage) return
  try{
    const j=await api('/api/operators/identities').then(r=>r.ok?r.json():null)
    if(!j) return
    const layer=window.L.layerGroup()
    // Approximate an operator's coverage centroid from the town-level tokens they
    // have acted on (matched back against the current map pins by location text) --
    // a soft circle per operator, radius scaled by how many distinct areas they cover.
    for(const idOp of (j.identities||[])){
      if(!idOp.areas || !idOp.areas.length) continue
      const matched=mapState.pins.filter(p=>p.location && idOp.areas.some(a=>String(p.location).toLowerCase().includes(a.token)))
      if(!matched.length) continue
      const lat=matched.reduce((s,p)=>s+p.lat,0)/matched.length
      const lon=matched.reduce((s,p)=>s+p.lon,0)/matched.length
      window.L.circle([lat,lon],{radius:25000,color:'#3b6ea5',weight:1,fillOpacity:.06})
        .bindTooltip(esc(idOp.name)+' -- '+idOp.case_count+' case action(s)')
        .addTo(layer)
    }
    layer.addTo(map)
    mapState.coverageLayer=layer
  }catch(e){ /* coverage overlay is a soft add-on -- a failure here must not break the map */ }
}
// Field-worker live-location layer (case_checkin self-reports, GET /api/map/workers).
// A fresh check-in renders solid; a stale one (past the tunable
// workerLocationStaleMs window) renders faded, so an operator can tell "here now"
// from "was here a while ago" at a glance rather than dispatching someone who has
// long since moved on.
async function renderMapWorkers(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.workersLayer){ map.removeLayer(mapState.workersLayer); mapState.workersLayer=null }
  if(!mapState.showWorkers) return
  try{
    const j=await api('/api/map/workers').then(r=>r.ok?r.json():null)
    if(!j) return
    mapState.workers=j.workers||[]
    const layer=window.L.layerGroup()
    for(const w of (j.workers||[])){
      const label=esc(w.display_name||'field worker')+(w.stale?' (last seen '+esc(fmtTime(w.last_location_at))+')':' (here now)')
      window.L.circleMarker([w.lat,w.lon],{
        radius:8, color:'#e0a83b', weight:2, fillColor:'#e0a83b', fillOpacity:w.stale?0.15:0.7,
      }).bindTooltip(label).addTo(layer)
    }
    layer.addTo(map)
    mapState.workersLayer=layer
  }catch(e){ /* worker-location overlay is a soft add-on -- a failure here must not break the map */ }
}
// Last-reported-location layer (GET /api/map/last-reports): each contact's
// most recent ANIMAL-REPORT location, distinct from the case-pin layer (one
// dot per CASE, including old/closed ones) and from the field-worker layer
// (a worker's own casual position, not a report). Every pin drills down to
// the exact case that produced it via openCase(case_id) -- never a bare
// aggregate dot with no path back to the underlying report.
async function renderMapLastReports(){
  if(!mapState) return
  const {map}=mapState
  if(mapState.lastReportsLayer){ map.removeLayer(mapState.lastReportsLayer); mapState.lastReportsLayer=null }
  if(!mapState.showLastReports) return
  try{
    const j=await api('/api/map/last-reports').then(r=>r.ok?r.json():null)
    if(!j) return
    mapState.lastReports=j.reports||[]
    const layer=window.L.layerGroup()
    for(const rpt of (j.reports||[])){
      const marker=window.L.circleMarker([rpt.lat,rpt.lon],{
        radius:7, color:'#3ba05c', weight:2, fillColor:'#3ba05c', fillOpacity:0.55,
      })
      const when=rpt.last_report_at?fmtTime(rpt.last_report_at):'unknown time'
      const name=esc(rpt.display_name||'a reporter')
      const openLink=rpt.case_id?'<div style="margin-top:4px"><a href="#" data-open-last-report="'+esc(rpt.case_id)+'">Open case</a></div>':''
      const html='<div style="font-size:12px"><b>'+name+'</b><br>Last reported: '+esc(when)+openLink+'</div>'
      marker.bindPopup(html)
      marker.on('popupopen',()=>{
        const el=document.querySelector('[data-open-last-report="'+rpt.case_id+'"]')
        if(el) el.onclick=(e)=>{e.preventDefault(); openCase(rpt.case_id)}
      })
      layer.addLayer(marker)
    }
    layer.addTo(map)
    mapState.lastReportsLayer=layer
  }catch(e){ /* last-reported-location overlay is a soft add-on -- a failure here must not break the map */ }
}
// --- Activity / audit stream ---
const ACT_KIND_LABEL={inbound:'Inbound',outbound:'Reply',transition:'Stage change',note:'Note',observation:'Note',action:'Action',autonomy_change:'Autonomy'}
const ACT_ACTOR_LABEL={agent:'casey',operator:'Operator',contact:'Contact',system:'System'}
function activityHtml(j){
  const ev=j.events||[]
  if(!ev.length) return '<div class="empty" style="padding:8px 0">Nothing matches.</div>'
  return '<div class="act-list">'+ev.map(e=>
    '<div class="act-row" data-id="'+esc(e.case_id)+'">'
    +'<span class="act-when">'+esc(fmtTime(e.created_at))+'</span>'
    +'<span class="act-kind">'+esc(ACT_KIND_LABEL[e.kind]||e.kind)+'</span>'
    +'<span class="act-who">'+esc(ACT_ACTOR_LABEL[e.actor]||e.actor||'')+'</span>'
    +'<span class="act-text">'+esc((e.text||'').slice(0,160))+'</span></div>'
  ).join('')+'</div>'
}
async function loadActivity(){
  const body=$('#activity-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  const k=$('#act-kind')?$('#act-kind').value:'', a=$('#act-actor')?$('#act-actor').value:''
  const qs=new URLSearchParams(); if(k)qs.set('kind',k); if(a)qs.set('actor',a); qs.set('limit','100')
  try{ const j=await api('/api/activity?'+qs.toString()).then(r=>r.ok?r.json():null)
    body.innerHTML=j?activityHtml(j):'<div class="empty">Could not load activity.</div>'
    body.querySelectorAll('.act-row').forEach(r=>r.onclick=()=>{ if(r.dataset.id) openCase(r.dataset.id) })
  }catch(e){ body.innerHTML='<div class="empty">Activity error: '+esc(e.message)+'</div>' }
}
panelToggle('#activity-btn','#activity-panel',loadActivity)
if($('#act-kind')) $('#act-kind').onchange=loadActivity
if($('#act-actor')) $('#act-actor').onchange=loadActivity
// --- shift handover digest ---
function hoSection(title,rows,render){
  if(!rows||!rows.length) return '<div class="ho-sec"><div class="ho-h">'+esc(title)+'</div><div class="empty" style="padding:4px 0">None.</div></div>'
  return '<div class="ho-sec"><div class="ho-h">'+esc(title)+' <span class="n">'+rows.length+'</span></div>'+rows.map(render).join('')+'</div>'
}
function handoverHtml(j){
  const link=(ref,id)=>'<span class="ho-ref" data-id="'+esc(id||'')+'">'+esc(ref||'')+'</span>'
  const at=t=>t?esc(fmtTime(t)):''
  return '<div class="ho-since">Since '+(j.since?esc(fmtTime(j.since)):'the last day')+(j.since_by?' ('+esc(j.since_by)+')':'')+'</div>'
    +hoSection('Needs you now',j.attention,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'(no subject)')+'</span> <span class="ho-why">'+esc(r.reason||'')+'</span>'+(r.assignee?' <span class="owner-chip">'+esc(r.assignee)+'</span>':'')+'</div>')
    +hoSection('Open handoffs',j.handoffs,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'')+'</span> <span class="ho-why">'+esc(r.reason||'')+'</span></div>')
    +hoSection('Unsent drafts',j.drafts,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'')+'</span> <span class="ho-why">'+esc((r.text||'').slice(0,120))+'</span></div>')
    +hoSection('Changed this shift',j.touched,r=>'<div class="ho-row">'+link(r.ref,r.id)+' <span class="ho-sub">'+esc(r.subject||'')+'</span> <span class="ho-why">'+esc(r.last_kind||'')+(r.last_actor?' by '+esc(r.last_actor):'')+'</span> <span class="act-when">'+at(r.at)+'</span></div>')
}
async function loadHandover(){
  const body=$('#handover-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/handover').then(r=>r.ok?r.json():null)
    body.innerHTML=j?handoverHtml(j):'<div class="empty">Could not load the handover digest.</div>'
    body.querySelectorAll('.ho-ref').forEach(r=>r.onclick=()=>{ if(r.dataset.id) openCase(r.dataset.id) })
  }catch(e){ body.innerHTML='<div class="empty">Handover error: '+esc(e.message)+'</div>' }
}
panelToggle('#handover-btn','#handover-panel',loadHandover)
const startShiftBtn=$('#start-shift-btn')
if(startShiftBtn) startShiftBtn.onclick=async()=>{
  startShiftBtn.disabled=true
  try{ const r=await api('/api/handover/start-shift',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    if(r.ok){ toast('Shift started -- "changed this shift" counts from now','ok'); await loadHandover() }
    else toast('Could not start the shift','warn')
  }catch(e){ toast('Start-shift error: '+e.message,'warn') }
  startShiftBtn.disabled=false
}
// --- AI offline queue ---
function offlineHtml(j){
  const rows=j.items||[]
  if(!rows.length) return '<div class="empty" style="padding:8px 0">Nothing waiting -- casey is answering normally.</div>'
  return '<div class="act-list">'+rows.map(r=>
    '<div class="act-row off-row" data-id="'+esc(r.id)+'">'
    +'<span class="act-kind off-badge">AI offline</span>'
    +'<span class="ho-ref">'+esc(r.ref||'')+'</span>'
    +'<span class="act-text">'+esc(r.subject||'(no subject)')+'</span>'
    +'<span class="act-who">'+esc(r.channel||'')+'</span>'
    +(r.assignee&&r.assignee!=='agent'?'<span class="owner-chip">'+esc(r.assignee)+'</span>':'')
    +'<span class="act-when">'+esc(fmtTime(r.last_event_at))+'</span></div>'
  ).join('')+'</div>'
}
async function loadOffline(){
  const body=$('#offline-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/unreplied').then(r=>r.ok?r.json():null)
    body.innerHTML=j?offlineHtml(j):'<div class="empty">Could not load the offline queue.</div>'
    if($('#offline-btn')) $('#offline-btn').classList.toggle('has-queue',!!(j&&j.total))
    body.querySelectorAll('.off-row').forEach(r=>r.onclick=()=>{ if(r.dataset.id) openCase(r.dataset.id) })
  }catch(e){ body.innerHTML='<div class="empty">Offline-queue error: '+esc(e.message)+'</div>' }
}
panelToggle('#offline-btn','#offline-panel',loadOffline)
// --- team workload (who is holding what) ---
function teamHtml(j){
  const ops=(j&&j.operators)||[]
  if(!ops.length) return '<div class="empty" style="padding:8px 0">No operators configured -- set CASEY_OPERATORS to give people a name on their work.</div>'
  return '<div class="team-grid">'+ops.map(o=>
    '<div class="team-card'+(o.stale_claims>0?' team-stale':'')+'">'
    +'<div class="team-name">'+esc(o.name||o.id)+'</div>'
    +'<div class="team-stat"><span class="n">'+esc(String(o.open_assigned||0))+'</span> <span class="lbl">open</span></div>'
    +(o.stale_claims>0?'<div class="team-stat team-warn"><span class="n">'+esc(String(o.stale_claims))+'</span> <span class="lbl">sitting too long</span></div>':'')
    +'<div class="team-stat"><span class="n">'+esc(String(o.replies_24h||0))+'</span> <span class="lbl">replies today</span></div>'
    +'<div class="team-stat"><span class="n">'+esc(fmtDur(o.first_reply_ms_median))+'</span> <span class="lbl">usual first reply</span></div>'
    +'<div class="team-stat"><span class="n">'+esc(fmtDur(o.oldest_waiting_ms))+'</span> <span class="lbl">oldest waiting</span></div>'
    +'</div>'
  ).join('')+'</div>'
}
async function loadTeam(){
  const body=$('#team-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{ const j=await api('/api/operators/workload').then(r=>r.ok?r.json():null)
    body.innerHTML=j?teamHtml(j):'<div class="empty">Could not load the team view.</div>'
  }catch(e){ body.innerHTML='<div class="empty">Team-view error: '+esc(e.message)+'</div>' }
}
panelToggle('#team-btn','#team-panel',loadTeam)
// --- Contacts/Reporters panel: promote/demote the operator-assignable access tier ---
function contactsHtml(j){
  const contacts=(j&&j.contacts)||[]
  if(!contacts.length) return '<div class="empty" style="padding:8px 0">No one has reported yet.</div>'
  const isAdmin=currentUser&&currentUser.role==='admin'
  return '<table class="contacts-table" style="width:100%;font-size:13px"><thead><tr>'
    +'<th style="text-align:left">Who</th><th style="text-align:left">Channel</th><th style="text-align:left">Tier</th><th style="text-align:left">Last check-in</th><th></th>'
    +'</tr></thead><tbody>'+contacts.map(c=>{
      const isField=c.tier==='field_worker'
      const checkin=c.last_location_at?fmtTime(c.last_location_at):'never'
      const erased=c.external_id_masked==='[erased]'
      return '<tr data-id="'+esc(c.id)+'">'
        +'<td>'+esc(c.display_name||c.external_id_masked)+'</td>'
        +'<td>'+esc(c.channel||'')+'</td>'
        +'<td>'+(isField?'<span class="owner-chip mine">field worker</span>':'<span class="owner-chip">reporter</span>')+'</td>'
        +'<td>'+esc(checkin)+'</td>'
        +'<td><button class="icon-btn contact-tier-toggle" data-id="'+esc(c.id)+'" data-to="'+(isField?'reporter':'field_worker')+'">'+(isField?'Demote':'Promote')+'</button>'
        +(isAdmin&&!erased?' <button class="icon-btn contact-erase" data-id="'+esc(c.id)+'" title="Data retention / right-to-erasure: irreversibly scrub this contact\'s identifying info and PII report fields">Erase PII</button>':'')
        +'</td>'
        +'</tr>'
    }).join('')+'</tbody></table>'
}
async function loadContacts(){
  const body=$('#contacts-body'); if(!body) return
  body.innerHTML='<div class="empty" style="padding:8px 0">Loading...</div>'
  try{
    const j=await api('/api/contacts').then(r=>r.ok?r.json():null)
    body.innerHTML=j?contactsHtml(j):'<div class="empty">Could not load reporters.</div>'
    body.querySelectorAll('.contact-tier-toggle').forEach(btn=>{
      btn.onclick=async()=>{
        const id=btn.dataset.id, to=btn.dataset.to
        btn.disabled=true
        try{
          const r=await api('/api/contacts/'+encodeURIComponent(id)+'/tier',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tier:to})})
          if(!r.ok){ const err=await r.json().catch(()=>({})); toast(err.error||'Could not change tier','err'); btn.disabled=false; return }
          toast(to==='field_worker'?'Promoted to field worker':'Demoted to reporter','ok')
          loadContacts()
        }catch(e){ toast('Could not change tier: '+e.message,'err'); btn.disabled=false }
      }
    })
    body.querySelectorAll('.contact-erase').forEach(btn=>{
      btn.onclick=async()=>{
        const id=btn.dataset.id
        const dlg=await showDialog({title:'Erase this contact\'s data?',message:'Irreversibly scrubs their identifying info (name, id, location check-ins) and any owner/present-person/photo/audio fields on their cases. The case reports themselves and the audit trail stay -- this only removes what could identify a specific person. This cannot be undone.',inputLabel:'Reason (optional, for the audit trail)',inputPlaceholder:'e.g. contact requested erasure',confirmLabel:'Erase PII',danger:true})
        if(!dlg) return
        btn.disabled=true
        try{
          const r=await api('/api/contacts/'+encodeURIComponent(id)+'/erase',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:dlg.value||''})})
          if(!r.ok){ const err=await r.json().catch(()=>({})); toast(err.error||'Could not erase contact','err'); btn.disabled=false; return }
          const j=await r.json()
          toast('Erased -- '+(j.casesScrubbed?j.casesScrubbed.length:0)+' case(s) scrubbed','ok')
          loadContacts()
        }catch(e){ toast('Could not erase contact: '+e.message,'err'); btn.disabled=false }
      }
    })
  }catch(e){ body.innerHTML='<div class="empty">Reporters error: '+esc(e.message)+'</div>' }
}
panelToggle('#contacts-btn','#contacts-panel',loadContacts)
// --- bulk toolbar wiring ---
;(function wireBulk(){
  const stageSel=$('#bulk-stage')
  if(stageSel){ stageSel.innerHTML='<option value="">Move to...</option>'+CASEY_STAGES.map(s=>'<option value="'+s+'">'+esc(STAGE_LABEL[s]||s)+'</option>').join('') }
  const all=$('#bulk-all')
  if(all) all.onclick=()=>{ const shown=allCases.filter(matchesFull); if(all.checked) shown.forEach(c=>selectedIds.add(c.id)); else shown.forEach(c=>selectedIds.delete(c.id)); renderListFull() }
  const claim=$('#bulk-claim'); if(claim) claim.onclick=()=>bulkAction('claim')
  if(stageSel) stageSel.onchange=()=>{ const to=stageSel.value; if(!to) return; bulkAction('transition',{to}); stageSel.value='' }
  const tag=$('#bulk-tag'); if(tag) tag.onclick=async()=>{ const dlg=await showDialog({title:'Tag selected cases',inputLabel:'Tag to add',inputPlaceholder:'e.g. follow-up',confirmLabel:'Add tag'}); if(dlg&&dlg.value.trim()) bulkAction('tag',{tag:dlg.value.trim()}) }
  const untag=$('#bulk-untag'); if(untag) untag.onclick=async()=>{ const dlg=await showDialog({title:'Untag selected cases',inputLabel:'Tag to remove',inputPlaceholder:'e.g. follow-up',confirmLabel:'Remove tag'}); if(dlg&&dlg.value.trim()) bulkAction('untag',{tag:dlg.value.trim()}) }
  const note=$('#bulk-note'); if(note) note.onclick=async()=>{ const dlg=await showDialog({title:'Add a note to selected cases',inputLabel:'Note',inputPlaceholder:'Visible on each timeline',confirmLabel:'Add note'}); if(dlg&&dlg.value.trim()) bulkAction('note',{text:dlg.value.trim()}) }
  const draftApprove=$('#bulk-draft-approve'); if(draftApprove) draftApprove.onclick=async()=>{ const dlg=await showDialog({title:'Send selected drafts?',message:'Each selected case with a pending draft sends it to the contact exactly as composed. A case with no pending draft is skipped.',confirmLabel:'Send drafts',danger:true}); if(dlg) bulkAction('draft_approve') }
  const draftDiscard=$('#bulk-draft-discard'); if(draftDiscard) draftDiscard.onclick=async()=>{ const dlg=await showDialog({title:'Discard selected drafts?',message:'Each selected case with a pending draft has it discarded, unsent. A case with no pending draft is skipped.',confirmLabel:'Discard drafts',danger:true}); if(dlg) bulkAction('draft_discard') }
  const clr=$('#bulk-clear'); if(clr) clr.onclick=clearSelection
})()
// --- who-am-i badge (login replaces the old cooperative operator picker) ---
// selectedOperator used to be a self-picked dropdown value (cooperative
// attribution, anyone could claim to be anyone); it is now simply the logged-
// in account's own username -- a real identity from the session, not a guess.
function initWhoAmI(){
  const sel=$('#op-picker'); if(!sel || !currentUser) return
  sel.outerHTML='<span id="whoami-badge" style="margin-left:8px" title="Logged in">'
    +esc(currentUser.display_name||currentUser.username)
    +' <a href="#" id="logout-link" style="margin-left:6px">log out</a>'
    +' <a href="#" id="logout-everywhere-link" style="margin-left:6px" title="Sign out any other device or browser tab using this account">log out everywhere</a></span>'
  const lo=$('#logout-link'); if(lo) lo.onclick=(e)=>{ e.preventDefault(); doLogout() }
  const loe=$('#logout-everywhere-link'); if(loe) loe.onclick=(e)=>{ e.preventDefault(); doLogoutEverywhere() }
}
// Inline modal replacement for native prompt()/confirm() -- works on mobile/PWA.
// Uses DOM creation (not innerHTML) to avoid conflicts with the outer template literal.
// Returns a Promise resolving to {value, confirmed:true} or null if cancelled.
function showSplitDialog(evList, caseRef){
  return new Promise(function(resolve){
    function mk(tag, css, txt){ const el=document.createElement(tag); if(css) el.style.cssText=css; if(txt!=null) el.textContent=txt; return el }
    const overlay=mk('div','position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true')
    const card=mk('div','background:var(--panel);border:1px solid var(--border);border-radius:10px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px;max-height:80vh;overflow:auto')
    card.appendChild(mk('h3','margin:0 0 6px;font-size:16px','Split case '+caseRef))
    card.appendChild(mk('p','margin:0 0 10px;color:var(--muted);line-height:1.5','Select events to move into a new case. The rest stay here.'))
    const subLab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)','Subject for new case (optional)')
    card.appendChild(subLab)
    const subInp=document.createElement('input'); subInp.type='text'; subInp.placeholder='e.g. sheep Upington outbreak'
    subInp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;margin-bottom:10px'
    card.appendChild(subInp)
    const evLab=mk('label','display:block;margin:0 0 6px;font-size:12px;color:var(--muted)','Events to move:')
    card.appendChild(evLab)
    const evBox=mk('div','border:1px solid var(--border);border-radius:6px;padding:6px;max-height:220px;overflow-y:auto;margin-bottom:10px')
    const checkboxes=[]
    evList.forEach(function(e){
      const row=mk('div','display:flex;align-items:flex-start;gap:6px;padding:4px 2px;border-bottom:1px solid var(--border)')
      const cb=document.createElement('input'); cb.type='checkbox'; cb.value=e.id; cb.style.cssText='margin-top:3px;flex-shrink:0'
      checkboxes.push(cb)
      const label=mk('span','font-size:12px;color:var(--fg);line-height:1.4','['+e.kind+'] '+(e.text||'').slice(0,120))
      row.appendChild(cb); row.appendChild(label); evBox.appendChild(row)
    })
    card.appendChild(evBox)
    const reasonLab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)','Reason (optional)')
    card.appendChild(reasonLab)
    const reasonInp=document.createElement('textarea'); reasonInp.rows=2; reasonInp.placeholder='e.g. different species, separate location'
    reasonInp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;resize:vertical'
    card.appendChild(reasonInp)
    const row=mk('div','display:flex;gap:8px;margin-top:14px;justify-content:flex-end')
    const cancelBtn=mk('button','background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0','Cancel')
    const okBtn=mk('button','background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0','Split case')
    row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    const close=function(confirmed){
      overlay.remove()
      if(!confirmed){ resolve(null); return }
      const event_ids=checkboxes.filter(cb=>cb.checked).map(cb=>cb.value)
      if(!event_ids.length){ resolve(null); return }
      resolve({event_ids,subject:subInp.value.trim(),reason:reasonInp.value.trim()})
    }
    okBtn.onclick=function(){ close(true) }
    cancelBtn.onclick=function(){ close(false) }
    overlay.addEventListener('keydown',function(e){ if(e.key==='Escape') close(false) })
    setTimeout(function(){ subInp.focus() }, 60)
  })
}
function showDialog(opts){
  const { title='', message='', inputLabel='', inputPlaceholder='', confirmLabel='OK', cancelLabel='Cancel', danger=false } = opts || {}
  return new Promise(function(resolve){
    function mk(tag, css, txt){ const el=document.createElement(tag); if(css) el.style.cssText=css; if(txt!=null) el.textContent=txt; return el }
    const overlay=mk('div','position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true')
    const card=mk('div','background:var(--panel);border:1px solid var(--border);border-radius:10px;max-width:420px;width:100%;padding:22px 24px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:14px')
    if(title){ const h=mk('h3','margin:0 0 8px;font-size:16px',title); card.appendChild(h) }
    if(message){ const p=mk('p','margin:0 0 10px;color:var(--muted);line-height:1.5',message); card.appendChild(p) }
    let inp=null
    if(inputLabel){
      const lab=mk('label','display:block;margin:0 0 4px;font-size:12px;color:var(--muted)',inputLabel); card.appendChild(lab)
      inp=document.createElement('textarea'); inp.rows=2; inp.placeholder=inputPlaceholder
      inp.style.cssText='width:100%;background:var(--panel);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:14px;box-sizing:border-box;resize:vertical'
      card.appendChild(inp)
    }
    const row=mk('div','display:flex;gap:8px;margin-top:14px;justify-content:flex-end')
    const cancelBtn=mk('button','background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0',cancelLabel)
    const okBtn=mk('button','background:'+(danger?'var(--danger)':'var(--accent)')+';color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;margin:0',confirmLabel)
    row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    const close=function(confirmed, value){ overlay.remove(); resolve(confirmed?{value:value||'',confirmed:true}:null) }
    okBtn.onclick=function(){ close(true, inp?inp.value:'') }
    cancelBtn.onclick=function(){ close(false) }
    overlay.addEventListener('keydown',function(e){ if(e.key==='Escape') close(false); if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ e.preventDefault(); close(true,inp?inp.value:'') } })
    setTimeout(function(){ if(inp) inp.focus(); else okBtn.focus() }, 60)
  })
}
// Apply the focus-mode body class and keep the #inbox hash in sync. Returns the
// effective mode so callers can branch their first paint.
function applyInboxMode(){
  document.body.classList.toggle('inbox-mode', inboxMode)
  return inboxMode
}
function setInboxMode(on){
  inboxMode = !!on
  // Preserve any deep-link hash already present (e.g. #case=...) by only
  // adding/removing the inbox token, never clobbering the rest.
  const rest = (location.hash||'').replace(/^#/,'').split('&').filter(p=>p&&p!=='inbox')
  if(inboxMode) rest.unshift('inbox')
  const want = rest.length ? '#'+rest.join('&') : location.pathname+location.search
  if(location.hash !== (rest.length?'#'+rest.join('&'):'')) history.replaceState(null,'',want)
  applyInboxMode()
  renderTriage()
  // Leaving focus mode needs the full list it skipped at boot.
  if(!inboxMode && !allCases.length) loadCases()
}
async function boot(){
  // A shared '#view=' link restores its full filter set before the first list
  // load, so the case list arrives already filtered (no flash of all-cases).
  const hv=viewFromHash()
  if(hv){
    filt.q=String(hv.q||''); const qel=$('#q'); if(qel) qel.value=filt.q
    filt.status=String(hv.status||''); filt.channel=String(hv.channel||''); filt.source=String(hv.source||'')
    mineOnly=!!hv.mine; const mb=$('#mine-btn'); if(mb) mb.classList.toggle('active',mineOnly)
    inboxMode=!!hv.focus
  }
  applyInboxMode()
  // In focus mode skip the heavy ~200-row case poll entirely; the ranked
  // attention list is the whole screen and comes from /api/attention.
  if(!inboxMode) await loadCases()
  await refreshHealth(); refreshAttention()
  const id=restoreFromHash(); if(id){ openCase(id); return }
  await restoreRefFromHash()
}
// Login gate: the app shell (search bar, list, inbox) stays in the DOM but
// hidden behind a full-screen login overlay until a session resolves. A
// not-tech-literate operator sees one simple form, types their username and
// password (set up for them by an admin), and the same dashboard they always
// used appears -- no token to find or paste.
function showLoginOverlay(){
  const app=document.body
  let ov=document.getElementById('login-overlay')
  if(!ov){
    ov=document.createElement('div')
    ov.id='login-overlay'
    ov.style.cssText='position:fixed;inset:0;background:var(--bg,#111);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px'
    ov.innerHTML='<form id="login-form" style="background:var(--panel,#1a1a1a);border:1px solid var(--border,#333);border-radius:10px;padding:28px 24px;max-width:340px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.5)">'
      +'<h1 style="margin:0 0 18px;font-size:20px">casey</h1>'
      +'<label style="display:block;margin-bottom:10px;font-size:13px">Username<input id="login-username" autocomplete="username" style="display:block;width:100%;margin-top:4px;padding:8px;font-size:16px" required></label>'
      +'<label style="display:block;margin-bottom:16px;font-size:13px">Password<input id="login-password" type="password" autocomplete="current-password" style="display:block;width:100%;margin-top:4px;padding:8px;font-size:16px" required></label>'
      +'<div id="login-error" style="color:#e66;font-size:13px;margin-bottom:10px;display:none"></div>'
      +'<button type="submit" style="width:100%;padding:10px;font-size:15px">Log in</button>'
      +'</form>'
    app.appendChild(ov)
    ov.querySelector('#login-form').addEventListener('submit', async (e)=>{
      e.preventDefault()
      const u=ov.querySelector('#login-username').value.trim()
      const p=ov.querySelector('#login-password').value
      const err=ov.querySelector('#login-error')
      err.style.display='none'
      try{
        await doLogin(u,p)
        ov.remove()
        initWhoAmI()
        boot()
      }catch(e2){ err.textContent=e2.message||'Log in failed'; err.style.display='' }
    })
  }
}
;(async ()=>{
  await checkSession()
  if(!currentUser){ showLoginOverlay(); return }
  initWhoAmI()
  boot()
})()
// Background polls. The 5s full-list poll is the expensive one; in focus mode it
// is suppressed so a phone only runs the cheap 30s attention poll plus health.
const _casesIv = setInterval(() => { if(!inboxMode) loadCases() }, 5000)
const _healthIv = setInterval(refreshHealth, 15000)
const _attnIv = setInterval(refreshAttention, 30000)
const _focusBtn = $('#focus-btn'); if(_focusBtn) _focusBtn.onclick = () => setInboxMode(!inboxMode)
function setMineOnly(on){
  if(on && !selectedOperator){ toast('Pick who you are first (top-right) so "Mine" knows whose cases to show.','warn'); return }
  mineOnly=!!on
  const b=$('#mine-btn'); if(b) b.classList.toggle('active',mineOnly)
  renderListFull(); renderTriage()
}
const _mineBtn = $('#mine-btn'); if(_mineBtn) _mineBtn.onclick = () => setMineOnly(!mineOnly)
window.addEventListener('beforeunload', () => { clearInterval(_casesIv); clearInterval(_healthIv); clearInterval(_attnIv) })
window.__casey = { esc, rel, waitFmt, sparkline, draftBanner, draftText, caseHasDraft, latestDraft, loadThresholds, hoursOf, loadMetrics, loadMetricsHtml, loadClusters, clustersHtml, loadGeo, geoHtml, loadMap, get mapState(){return mapState}, fmtDur, loadActivity, activityHtml, initWhoAmI, get selectedOperator(){return selectedOperator}, get currentUser(){return currentUser}, checkSession, doLogin, doLogout, handoverHtml, loadHandover, offlineHtml, loadOffline, teamHtml, loadTeam, fieldNotes, fieldSources, isMine, setMineOnly, get mineOnly(){return mineOnly}, undoToast, replyUndoToast, toggleSelect, clearSelection, syncBulkBar, bulkAction, get selectedIds(){return selectedIds}, applyInboxMode, setInboxMode, get inboxMode(){return inboxMode}, toast, loadCases, openCase, applyTheme, refreshHealth, refreshAttention, refreshRuntimePill, refreshGuardrailsPill, renderTriage, countTitle, setInboxBadge, get inboxCount(){return inboxCount}, get lastHealth(){return lastHealth}, get attentionInbox(){return attentionInbox}, set attentionInbox(v){attentionInbox=v},
  applySimple, stageLabel, STAGE_LABEL,
  get activeId(){return activeId}, get allCases(){return allCases}, get filt(){return filt},
  get editing(){return editing}, get simple(){return simple},
  setFilter(q){filt.q=q;renderListFull()},
  renderList: renderListFull, renderListFull, matchesFull, openIntakeForm,
  // help overlay + per-case hint, exposed for browser-witness
  showHelp, hideHelp, helpSeen, todoHint, get helpOpen(){return helpOpen},
  showOnboard, hideOnboard, onboarded,
  // triage inbox + coaching + handoff, exposed for browser-witness
  cannedReplies, renderTriage,
  checkHandoffs, clearHandoff, hasHandoff, contactMaybeNonEnglish,
  INTAKE_FIELDS,
  get handoffQueue(){return handoffQueue}, get handoffSeen(){return handoffSeen},
  showDialog }   // exposed for browser-witness
