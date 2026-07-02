// conversation-spec.js -- the agent-driven conversation state machine, as a
// declarative dstate/adaptogen plan() spec.
//
// dstate is an AGENT-OWNED DAG+FSM: the agent moves a cursor along transition
// edges, each carrying a soft/hard/off enforcement policy. casey uses it as the
// DURABLE per-case conversation state so the model knows WHERE it is in the report
// arc across turns -- so it never re-asks something already answered and always
// advances. The agent DECLARES its phase (via the case_stage tool); casey applies
// the transition and feeds orient() (current state + legal next phases) back into
// the system prompt.
//
// The arc:
//   greeting  -- warm opener, first ask (brand-new case)
//   gathering -- collecting the report facts, one at a time
//   enquiring -- the worker asked ABOUT their work (today/mine/near/count/...)
//   answering -- answered a general question
//   complete  -- the report is on record and confirmed (NOT a sink: a fresh report
//                or an enquiry moves out again, so the complete-report dead-end is
//                structurally impossible)
//   handoff   -- a human takeover was requested
//   closed    -- the contact opted out
//
// Enforcement is SOFT for the intake/enquiry arc (every move is allowed and merely
// FLAGGED, never blocked -- a weak model that declares an out-of-arc phase still
// moves, the flag is just observable), and OFF for the irreversible service edges
// (handoff/closed). NOTE: an enforcement:'off' edge still APPLIES and moves the
// cursor in real adaptogen -- which is why advanceCase (conversation-state.js)
// short-circuits handoff/closed and never applies them: the deterministic
// STOP/HUMAN layer owns those states. The soft recovery edges OUT of handoff/
// closed below are belt-and-braces for any pre-existing persisted blob whose
// cursor already landed there.
// The `intake` zone (greeting/gathering/complete) has intra/boundary:off so an
// excursion into enquiring/answering is never counted a zone violation.
export const CONVERSATION_SPEC = {
  nodes: [
    { id: 'greeting', label: 'warm opener, first ask', payload: {} },
    { id: 'gathering', label: 'collecting report facts', payload: { asked: [] } },
    { id: 'enquiring', label: 'worker asked about their work', payload: {} },
    { id: 'answering', label: 'answered a general question', payload: {} },
    { id: 'complete', label: 'report on record, confirmed', payload: {} },
    { id: 'handoff', label: 'human takeover requested', payload: {} },
    { id: 'closed', label: 'stopped by contact', payload: {} },
  ],
  transitions: [
    ['greeting', 'gathering', { enforcement: 'soft', label: 'start collecting' }],
    ['greeting', 'enquiring', { enforcement: 'soft', label: 'opened with a question' }],
    ['gathering', 'gathering', { enforcement: 'soft', label: 'keep collecting' }],
    ['gathering', 'enquiring', { enforcement: 'soft', label: 'worker asked about work' }],
    ['gathering', 'answering', { enforcement: 'soft', label: 'general question' }],
    ['gathering', 'complete', { enforcement: 'soft', label: 'report complete' }],
    ['enquiring', 'gathering', { enforcement: 'soft', label: 'back to collecting' }],
    ['enquiring', 'answering', { enforcement: 'soft', label: 'general question' }],
    ['answering', 'gathering', { enforcement: 'soft', label: 'back to collecting' }],
    ['answering', 'enquiring', { enforcement: 'soft', label: 'another work enquiry' }],
    ['complete', 'gathering', { enforcement: 'soft', label: 'new case, keep collecting' }],
    ['complete', 'enquiring', { enforcement: 'soft', label: 'enquiry after complete' }],
    ['greeting', 'handoff', { enforcement: 'off', label: 'human requested' }],
    ['gathering', 'handoff', { enforcement: 'off', label: 'human requested' }],
    ['enquiring', 'handoff', { enforcement: 'off', label: 'human requested' }],
    ['answering', 'handoff', { enforcement: 'off', label: 'human requested' }],
    ['complete', 'handoff', { enforcement: 'off', label: 'human requested' }],
    ['greeting', 'closed', { enforcement: 'off', label: 'contact stopped' }],
    ['gathering', 'closed', { enforcement: 'off', label: 'contact stopped' }],
    ['enquiring', 'closed', { enforcement: 'off', label: 'contact stopped' }],
    ['answering', 'closed', { enforcement: 'off', label: 'contact stopped' }],
    ['complete', 'closed', { enforcement: 'off', label: 'contact stopped' }],
    // Recovery edges: a blob persisted at handoff/closed (from before advanceCase
    // short-circuited those states) must not be trapped with legalMoves:[] forever.
    ['handoff', 'gathering', { enforcement: 'soft', label: 'back from handoff' }],
    ['handoff', 'enquiring', { enforcement: 'soft', label: 'enquiry after handoff' }],
    ['closed', 'gathering', { enforcement: 'soft', label: 'opted back in' }],
  ],
  zones: [
    { name: 'intake', members: ['greeting', 'gathering', 'complete'], intra: 'off', boundary: 'off' },
  ],
  cursor: ['greeting'],
}

// The phases a caller (the case_stage tool enum, the prompt) may name.
export const CONVERSATION_PHASES = CONVERSATION_SPEC.nodes.map(n => n.id)
