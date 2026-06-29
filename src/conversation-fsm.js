// conversation-fsm.js -- the per-turn conversation as a SOFT state machine.
//
// casey used to route each message through hard keyword branches: a fixed-phrase
// detector decided enquiry-vs-report, and on a "complete" case any empty model turn
// hit completeReply -- the complete-report dead-end that answered a worker's QUESTION
// with "we have the full report ... your reference is X". The guardrails interfered
// with the conversation.
//
// Now the in-loop agent model INTERPRETS the message (see intent.js) and the
// conversation is an adaptogen (../dstate) DAG+FSM with SOFT enforcement: every
// transition is allowed (a wrong guess is flagged in the trace, never blocked), so
// a question or enquiry from a "finished" case moves freely out of the complete
// state instead of dead-ending. adaptogen holds CONVERSATION state; thatcher remains
// the system-of-record for the case itself (P10).
//
// adaptogen is a file:../dstate sibling like freddie. A bare clone / the dependency-
// free CI lint will not have it, so it is OPTIONAL-imported: absent, the module
// degrades to a pure intent->route map (no persisted FSM, transitions become
// advisory), and the conversation still never dead-ends.

let _Adaptogen = null
let _loaded = false
async function loadAdaptogen() {
  if (_loaded) return _Adaptogen
  _loaded = true
  try {
    const m = await import('adaptogen')
    _Adaptogen = m.Adaptogen || m.DState || null
  } catch { _Adaptogen = null }   // sibling absent (bare clone / CI) -- degrade, do not throw
  return _Adaptogen
}

// The conversation machine as a vendorable adaptogen spec. States are talk phases;
// transitions are SOFT (enforcement:'soft') so movement is always allowed and merely
// flagged when it crosses a guard -- the whole point is that guardrails inform, not
// interfere. The 'complete' state has free exit edges (re-open intake, answer an
// enquiry, take a question), so the complete-report exit can never trap a worker.
export const CONVERSATION_SPEC = {
  nodes: [
    { id: 'greeting', label: 'warm opener' },
    { id: 'gathering', label: 'collecting the report' },
    { id: 'complete', label: 'report complete' },
    { id: 'enquiring', label: 'answering an enquiry about cases' },
    { id: 'answering', label: 'answering a general question' },
    { id: 'chitchat', label: 'social turn' },
    { id: 'handoff', label: 'a person was asked for' },
    { id: 'closed', label: 'opted out' },
  ],
  transitions: [
    ['greeting', 'gathering', { enforcement: 'soft' }],
    ['greeting', 'enquiring', { enforcement: 'soft' }],
    ['greeting', 'answering', { enforcement: 'soft' }],
    ['gathering', 'gathering', { enforcement: 'soft' }],
    ['gathering', 'complete', { enforcement: 'soft' }],
    ['gathering', 'enquiring', { enforcement: 'soft' }],
    ['gathering', 'answering', { enforcement: 'soft' }],
    // The complete state is NOT a sink: a worker may ask, enquire, or start fresh.
    ['complete', 'enquiring', { enforcement: 'soft' }],
    ['complete', 'answering', { enforcement: 'soft' }],
    ['complete', 'gathering', { enforcement: 'soft', label: 'new report' }],
    ['enquiring', 'gathering', { enforcement: 'soft' }],
    ['enquiring', 'complete', { enforcement: 'soft' }],
    ['enquiring', 'enquiring', { enforcement: 'soft' }],
    ['answering', 'gathering', { enforcement: 'soft' }],
    ['answering', 'enquiring', { enforcement: 'soft' }],
    ['chitchat', 'gathering', { enforcement: 'soft' }],
    ['chitchat', 'enquiring', { enforcement: 'soft' }],
    ['chitchat', 'answering', { enforcement: 'soft' }],
  ],
  // No hard deps: the conversation is not a build pipeline, it is a free walk with
  // soft policy. Zones could fence a "safe talk" region but soft transitions already
  // give free movement, so we keep the spec minimal.
  cursor: ['greeting'],
}

// Map an interpreted intent to the conversation state it drives toward, and the
// reply route the gateway should take. The route is what matters to the caller;
// the adaptogen transition records it (with a soft-violation trace) for observability.
//   route: 'intake' | 'enquiry' | 'answer' | 'chitchat' | 'service'
export function routeForIntent(intent) {
  const kind = intent?.kind || 'report'
  switch (kind) {
    case 'enquiry': return { state: 'enquiring', route: 'enquiry' }
    case 'question': return { state: 'answering', route: 'answer' }
    case 'chitchat': return { state: 'chitchat', route: 'chitchat' }
    case 'status': case 'help': case 'human': case 'stop':
      return { state: kind === 'human' || kind === 'stop' ? 'handoff' : 'greeting', route: 'service' }
    case 'report':
    default: return { state: 'gathering', route: 'intake' }
  }
}

// Advance the conversation FSM for a case by the interpreted intent, returning the
// route plus the decision trace. When adaptogen is present we persist a per-case
// machine and record a real (soft) transition; when absent we still return the route
// so the conversation behaves identically -- only the durable trace is skipped.
// store is the CaseStore (for an optional per-case bundle path); caseRow gives id.
export async function advanceConversation(intent, { fsmFromState = null } = {}) {
  const target = routeForIntent(intent)
  const Adaptogen = await loadAdaptogen()
  if (!Adaptogen) {
    return { ...target, trace: { degraded: true, from: fsmFromState, to: target.state, soft: [] } }
  }
  // In-memory machine per call: the conversation's durable memory is the thatcher
  // case (report + events); the FSM here validates the soft move and yields a trace.
  // Using :memory: keeps this cheap and side-effect-free; a future step can persist a
  // per-case bundle if cross-turn FSM memory proves valuable beyond the case report.
  try {
    const ds = Adaptogen.open(':memory:')
    const planned = ds.plan(CONVERSATION_SPEC)
    if (planned && planned.ok === false) { ds.close?.(); return { ...target, trace: { degraded: true, reason: 'plan-failed', to: target.state, soft: [] } } }
    if (fsmFromState) ds.setCursor([fsmFromState])
    const dec = ds.transition(target.state)
    const trace = {
      from: fsmFromState, to: target.state,
      allowed: dec?.ok !== false,
      soft: (dec?.value?.softViolations || dec?.softViolations || []).map(v => v.reason || String(v)),
    }
    ds.close?.()
    return { ...target, trace }
  } catch (e) {
    return { ...target, trace: { degraded: true, reason: e.message, to: target.state, soft: [] } }
  }
}
