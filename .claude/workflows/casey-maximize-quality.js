// casey-maximize-quality -- an end-to-end, multi-agent quality maximiser for the
// casey project, run through the synthesized-engineering-dna 12-principle lens.
//
// This supersedes the audit-only casey-quality-audit.js. Where that workflow
// stops at "return findings", this one closes the whole loop the discipline
// demands:
//
//   Map      -- parallel readers build a shared, factual picture of every
//               surface, the data model (P1) and the dependency spine (P4),
//               so every later auditor reasons from real structure not a guess.
//   Audit    -- TWO axes run together: per-surface auditors (each file-cluster
//               through its sharpest principle lens) AND cross-cutting auditors
//               (security, subtractive/dead-code, worst-case resilience,
//               contract honesty, crucible test-gap, AI-tell + glyph sweep)
//               that no single-file audit can see.
//   Verify   -- every finding is handed to an independent adversarial verifier
//               that DEFAULTS TO REFUTING it; only real, net-improving,
//               non-breaking findings survive, each carrying a concrete patch.
//   Synthesize -- one synthesiser dedupes overlapping findings, drops anything
//               that breaks a published contract, and returns a single ordered,
//               apply-ready plan. The caller (main loop) applies the patches,
//               runs test.js, and reverts-first on any regression (P3).
//
// Invoke (the saved-by-name registry does not resolve .claude/workflows in this
// env -- use scriptPath):
//     Workflow({ scriptPath: 'C:/dev/casey/.claude/workflows/casey-maximize-quality.js' })
// Optional args: a subset of surface keys to narrow the per-surface axis. The
// cross-cutting axis always runs in full -- security and dead-code do not respect
// file boundaries, so subsetting them would hide exactly what they exist to find.

export const meta = {
  name: 'casey-maximize-quality',
  description: 'End-to-end engineering-DNA quality maximiser for casey: map the system, audit it on per-surface AND cross-cutting axes, adversarially verify every finding (default-refute), and return one deduped, ordered, apply-ready fix plan with concrete patches.',
  phases: [
    { title: 'Map', detail: 'parallel readers build a factual map of surfaces, data model, dependency spine' },
    { title: 'Audit', detail: 'per-surface + cross-cutting principled auditors' },
    { title: 'Verify', detail: 'independent adversarial verifier per finding (default-refute)' },
    { title: 'Synthesize', detail: 'dedupe, drop contract-breakers, order the apply-ready plan' },
  ],
}

const ROOT = 'C:/dev/casey'

const CONTEXT =
  `casey is an animal-disease surveillance service for rural South Africa: livestock ` +
  `farmers and NGO field workers report sick or dead animals over WhatsApp (and Discord); ` +
  `casey gently gathers a STRUCTURED report without interrogating the reporter, and gives ` +
  `organisers an observable record they can act on. casey is built on three published ` +
  `dependencies it must NOT fork: freddie (agent harness), thatcher (case system of record), ` +
  `anentrypoint-design (dashboard UI). Casey's own principles: collect-maximally / ` +
  `ask-minimally, do-not-impose (never invent disease rules or escalation the team did not ` +
  `ask for), honest degradation when the LLM is unreachable, extraction invisible to a ` +
  `worried low-literacy farmer, and South-African language/context awareness.`

// The twelve principles, compressed to the cue each auditor reasons from. Kept in
// the script so the run is self-contained -- no external skill file at run time.
const PRINCIPLES = [
  'P1 Data First: clean data shapes + explicit state; a bad data model shows up as convoluted code.',
  'P2 Subtractive: remove what carries cost without value -- dead options, unused exports/deps, redundant layers.',
  'P3 Evolutionary: ship-simple-then-iterate; revert-first on regression; no premature abstraction.',
  'P4 Composition Spine: each layer adds exactly one capability; no kitchen-sink module; power-of-one.',
  'P5 Physics-First: design within latency/memory/coordination limits; the worst node is the design target.',
  'P6 Adversarial: make misuse structurally hard; assume partition/failure; no dishonest defaults.',
  'P7 Empirical: measure dont assume; profile before optimising; both-ways for genuine disputes.',
  'P8 Automated Correctness: pure functions; make invalid states unrepresentable; guardrail bug recurrence.',
  'P9 Worst-Case Resilience: explicit degradation paths (full->degraded->safe-fail->explicit-error); never silent catastrophe.',
  'P10 Honest Interfaces: published contracts sacred; never claim a property you cannot guarantee.',
  'P11 Crucible: validate by the hardest integration (concurrency + partial failure + real input together).',
  'P12 Human Value: trace every decision to a human outcome; a worried farmer must never be interrogated or alarmed.',
].join('\n')

// Per-surface axis. Each cluster names its files and the principles most likely
// to expose a defect there, so the auditor reasons from the sharpest lens.
const ALL_SURFACES = [
  {
    key: 'gateway-hooks',
    files: 'src/gateway-hooks.js',
    lens: 'The inbound handler heart: intent detection, the case_report extraction discipline (collect-maximally/ask-minimally, invisible to the farmer), one-shot closing-nudge, language detection/fallback, deterministic reply tables. Sharpest: P1 (report/intent state), P6 (intent false-positives), P9 (LLM timeout/error/unreachable degradation), P4 (one module doing too much?), P12 (does a worried farmer ever get interrogated or alarmed?).',
  },
  {
    key: 'case-data',
    files: 'src/case-tools.js, src/case-store.js, src/case-runtime.js, src/correlate.js',
    lens: 'The data model + system of record over thatcher, plus the pure case-correlation/merge/split logic. Sharpest: P1 (case/report/event shapes, hidden mutation, JSON merge correctness), P6 (observe-mode bypass, concurrent writes, dedup), P8 (invalid states representable that should not be), P9 (count caps, thatcher quirks). thatcher is published -- do not propose forking it.',
  },
  {
    key: 'case-lifecycle',
    files: 'src/case-machine.js, src/case-health.js, src/case-sweep.js',
    lens: 'The xstate case-lifecycle machine + the time-based health sweep that keeps cases from going wrong over time. Sharpest: P1 (state space, illegal transitions made unrepresentable), P6 (can a case reach a state it should not?), P9 (what happens to a stuck/abandoned case; is the sweep idempotent and crash-safe?), P8 (guardrails against invalid lifecycle), P5 (sweep cost as case count grows).',
  },
  {
    key: 'dashboard',
    files: 'src/dashboard/server.js',
    lens: 'The operator dashboard (express API + single-file HTML PAGE). Sharpest: P6 (XSS where farmer-supplied text reaches innerHTML, request validation, auth gate), P10 (API contract honesty), P8 (input validation guardrails), P12 (operator observability + plain language), P9 (behaviour under load / malformed input). Flag EVERY unescaped contact-supplied value.',
  },
  {
    key: 'orchestration',
    files: 'src/casey.js, src/llm.js, src/discord-receive.js',
    lens: 'Orchestrator, LLM backend resolution (stub|acptoapi|none), Discord receive WebSocket. Sharpest: P9 (LLM unreachable/slow degradation, WS reconnect/zombie-socket resilience, graceful shutdown, sweep-timer cleanup), P10 (honest llm-source reporting), P4 (clean layering, no bypass), P6 (assume the socket drops and the provider walks dead for minutes).',
  },
  {
    key: 'sim-tests',
    files: 'src/sim/scenarios.js, src/sim/stub-llm.js, src/sim/inject.js, test.js',
    lens: 'The offline simulation harness + test suite. Sharpest: P11 (is the HARDEST integration tested -- concurrency + dup + partial-failure + real low-literacy input together?), P8 (coverage gaps on confirmed bug classes), P3 (test determinism, isolation between tests), P12 (do the personas reflect real low-literacy SA farmers?). Flag untested surfaces and flaky/order-dependent tests.',
  },
]

// Cross-cutting axis. These lenses cut ACROSS files; a per-file auditor structurally
// cannot see them. Each gets the whole tree and one job.
const CROSSCUTS = [
  {
    key: 'xc-security',
    lens: 'P6 SECURITY across the whole tree. Hunt: XSS where any farmer/contact-supplied text reaches innerHTML or an HTML response unescaped; the dashboard auth gate (is it bypassable, is the token compared safely, is it absent on any route?); request/body validation; path traversal in any file read; injection into thatcher queries or shell; secret/token handling and accidental logging of contact PII. Report concrete, grounded vulnerabilities only -- file:line + the exact tainted path from source to sink.',
  },
  {
    key: 'xc-subtractive',
    lens: 'P2 SUBTRACTIVE across the whole tree. Hunt net-smaller wins: dead code (unreferenced functions/exports/files), unused dependencies in package.json, redundant abstraction layers that add no capability (P4 violation), config options or opts.* flags that should just be the default, duplicated logic that should be one helper, and bespoke code that a thatcher/freddie/express/xstate/js-yaml primitive already provides. Only propose a removal you have CONFIRMED is unused (grep for every caller). Net-smaller bias; a removal that breaks a test or contract is NOT a win.',
  },
  {
    key: 'xc-resilience',
    lens: 'P9 + P11 WORST-CASE across the whole tree. Hunt silent-catastrophe paths: an await with no try/catch on an I/O boundary; an unhandled promise rejection; a timer/interval/socket that is never cleared on shutdown (leak); a degradation path that is missing a rung (full->degraded->safe-fail->explicit-error); a place that assumes the LLM/socket/thatcher succeeds. For each, name the worst-case trigger and the missing degradation rung.',
  },
  {
    key: 'xc-contracts',
    lens: 'P10 HONEST INTERFACES across the whole tree. Audit every published/stable contract: the /v1 dashboard API shape, the case/report/event storage shape, the gateway handleInbound contract, the llm-source reporting. Hunt: documentation/comments claiming a property the code does not guarantee; a default that looks good in the sim but fails under partition/load; a breaking change hidden as a refactor; a return shape that lies about what happened (e.g. reporting success on a swallowed error).',
  },
  {
    key: 'xc-ai-tells',
    lens: 'AI-TELL + DECORATIVE-GLYPH sweep across the whole tree (code AND comments AND any user-facing string). Hunt: machine-authored tells -- boilerplate flourishes, over-hedged or restating comments, generic scaffold names (foo/handler2/tmp/data2), needless ceremony; AND every decorative glyph (arrows, box/geometric glyphs, stars, filled/hollow bullets, checkmarks/crosses, emoji, any non-ASCII decoration) that should become its ASCII industry-standard (-> for arrows, - or * for bullets, [x]/[ ] or done/todo for checks). Functional operators (=>, ??, ?.) and any intentional product copy are NOT tells. Report file:line + the exact text and its ASCII replacement.',
  },
]

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string', description: 'line number or range, best effort' },
          principle: { type: 'string', description: 'which principle (P1-P12) it relates to' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          problem: { type: 'string', description: 'the concrete defect, with the code evidence that proves it' },
          fix: { type: 'string', description: 'a specific, minimal, net-smaller, non-breaking fix -- concrete enough to apply' },
        },
        required: ['title', 'file', 'principle', 'severity', 'problem', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean', description: 'true ONLY if the defect genuinely exists AND the fix is sound, net-improving, and non-breaking' },
    reason: { type: 'string' },
    adjustedFix: { type: 'string', description: 'corrected concrete fix when the defect is real but the original fix was wrong/incomplete' },
  },
  required: ['isReal', 'reason'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'array',
      description: 'the final deduped, ordered, apply-ready fix plan',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number', description: '1 = apply first (highest value, lowest risk, unblocks others)' },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' },
          principle: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          problem: { type: 'string' },
          patch: { type: 'string', description: 'the concrete change to make -- specific enough to apply without re-deriving it' },
          breakingRisk: { type: 'string', description: 'what could break and how to confirm it did not (which test covers it)' },
        },
        required: ['rank', 'title', 'file', 'principle', 'severity', 'problem', 'patch'],
      },
    },
    droppedAsDuplicateOrContractBreak: { type: 'number' },
    note: { type: 'string', description: 'one line on the overall shape of the plan' },
  },
  required: ['plan'],
}

function pickSurfaces(a) {
  if (a == null) return ALL_SURFACES
  const wanted = Array.isArray(a) ? a : [a]
  const known = new Set(ALL_SURFACES.map(s => s.key))
  const bad = wanted.filter(k => !known.has(k))
  if (bad.length) log(`ignoring unknown surface key(s): ${bad.join(', ')} (known: ${ALL_SURFACES.map(s => s.key).join(', ')})`)
  const chosen = ALL_SURFACES.filter(s => wanted.includes(s.key))
  return chosen.length ? chosen : ALL_SURFACES
}

// ---- Map: build a shared factual picture before anyone judges anything -------
phase('Map')
const MAP_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'what this aspect of the system actually is, factually, from the code' },
    risks: { type: 'array', items: { type: 'string' }, description: 'aspects most worth auditing, as leads not verdicts' },
  },
  required: ['summary'],
}
const MAP_JOBS = [
  { key: 'data-model', q: 'Map casey\'s DATA MODEL (P1): the exact shape of a case, a report, an event, the correlation record; where each is created and mutated; any hidden/global mutable state. Return the factual shapes and the spots where state is implicit.' },
  { key: 'spine', q: 'Map casey\'s DEPENDENCY SPINE (P4): which module depends on which, the layering from entrypoint down to thatcher/freddie, any module that reaches DOWN past a layer or any circular/kitchen-sink coupling. Return the factual layering.' },
  { key: 'boundaries', q: 'Map casey\'s EXTERNAL BOUNDARIES (P5/P10): every I/O edge -- WhatsApp/Discord in, the LLM call, thatcher reads/writes, the dashboard HTTP API, timers. For each: what it assumes about latency/failure, and what its published contract is.' },
]
const systemMap = (await parallel(MAP_JOBS.map(m => () =>
  agent(
    `${CONTEXT}\n\nRead the real casey code at ${ROOT} with Read/Grep. ${m.q}\nGround everything in actual file:line. Do not judge yet -- just report what is factually there.`,
    { label: `map:${m.key}`, phase: 'Map', schema: MAP_SCHEMA, agentType: 'Explore' }
  ).then(r => `[${m.key}] ${r.summary}${r.risks?.length ? '\nLeads: ' + r.risks.join('; ') : ''}`)
))).filter(Boolean)
const MAP_BRIEF = systemMap.length
  ? `\n\nSHARED SYSTEM MAP (factual, from a prior read -- use it to aim, verify against real code before trusting):\n${systemMap.join('\n\n')}`
  : ''
log(`map built from ${systemMap.length} readers`)

// ---- Audit + Verify pipeline -------------------------------------------------
// Both axes feed ONE pipeline so each finding starts verifying the moment its
// auditor finishes -- no barrier between the slow auditor and the fast verifier.
const SURFACES = pickSurfaces(args)
const auditJobs = [
  ...SURFACES.map(s => ({
    label: `audit:${s.key}`,
    prompt:
      `${CONTEXT}\n\nApply this engineering lens:\n${PRINCIPLES}${MAP_BRIEF}\n\n` +
      `Audit this surface: ${s.files}\nReason hardest from these lenses: ${s.lens}\n\n` +
      `Report ONLY real, concrete defects you can point at in the actual code (file:line + evidence). For each, give a specific MINIMAL fix; prefer net-smaller and non-breaking (do not break the /v1 dashboard API, the case/event storage shape, or thatcher/freddie). Do NOT invent problems, do NOT report pure style nits, do NOT report anything you cannot ground in real code. If the surface is genuinely sound, return an empty findings array. Use Read and Grep against ${ROOT}.`,
  })),
  ...CROSSCUTS.map(c => ({
    label: c.key,
    prompt:
      `${CONTEXT}\n\nApply this engineering lens:\n${PRINCIPLES}${MAP_BRIEF}\n\n` +
      `You are a CROSS-CUTTING auditor -- scan the WHOLE tree at ${ROOT}, not one file. Your single job:\n${c.lens}\n\n` +
      `Report ONLY real, concrete, grounded findings (file:line + evidence). Give a specific MINIMAL fix for each; net-smaller and non-breaking. If you genuinely find nothing, return an empty findings array -- do not pad. Use Read and Grep against ${ROOT}.`,
  })),
]
log(`auditing ${SURFACES.length} surface(s) + ${CROSSCUTS.length} cross-cutting lens(es)`)

phase('Audit')
const verified = await pipeline(
  auditJobs,
  (job) => agent(job.prompt, { label: job.label, phase: 'Audit', schema: FINDING_SCHEMA, agentType: 'Explore' }),
  (audit, job) => parallel((audit?.findings || []).map(f => () =>
    agent(
      `${CONTEXT}\n\nAdversarially verify this claimed defect in casey at ${ROOT}. DEFAULT to isReal=false unless you can confirm it by reading the actual code.\n\n` +
      `File: ${f.file}:${f.line || '?'}\nPrinciple: ${f.principle}\nSeverity: ${f.severity}\nClaim: ${f.problem}\nProposed fix: ${f.fix}\n\n` +
      `Read the real file and check: (1) does the defect actually exist exactly as described? (2) is the fix correct, net-improving (removes more risk/surface than it adds), and non-breaking (does not change the /v1 API, the storage shape, or behaviour the tests rely on)? Set isReal=true ONLY if all hold. If the defect is real but the fix is wrong/incomplete, set isReal=true with a corrected adjustedFix. Respect casey's principles: collect-maximally/ask-minimally, do-not-impose, honest degradation, invisible-to-the-farmer extraction, SA context.`,
      { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'Explore' }
    ).then(v => ({ ...f, verdict: v, source: job.label }))
  ))
)

const flat = verified.flat().filter(Boolean)
const confirmed = flat.filter(f => f.verdict?.isReal).map(f => ({
  ...f, fix: f.verdict?.adjustedFix || f.fix,
}))
const rejected = flat.filter(f => !f.verdict?.isReal)
log(`confirmed ${confirmed.length} real findings, rejected ${rejected.length}`)

// ---- Synthesize: dedupe, drop contract-breakers, order the plan --------------
if (!confirmed.length) {
  return { plan: [], confirmedCount: 0, rejectedCount: rejected.length, note: 'no confirmed net-improving non-breaking findings -- the audited surfaces are sound under this lens.' }
}
phase('Synthesize')
const synthesis = await agent(
  `${CONTEXT}\n\nYou are the SYNTHESISER. Below are ${confirmed.length} findings about the casey project that each passed an adversarial default-refute verifier. Your job is to turn them into ONE apply-ready plan:\n` +
  `- DEDUPE findings that are the same defect seen from two lenses (keep the clearest statement, union the evidence).\n` +
  `- DROP anything that, on reflection, would break a published contract (the /v1 dashboard API, the case/report/event storage shape, thatcher/freddie/xstate behaviour) or a passing test -- correctness over completeness.\n` +
  `- ORDER by rank: apply-first = highest human value + lowest breaking risk + unblocks other fixes. Security and silent-catastrophe (P6/P9) outrank style and subtractive wins unless a subtractive win is a prerequisite.\n` +
  `- For each surviving item give a concrete patch specific enough to apply without re-deriving it, and a breakingRisk line naming which test confirms it stayed green.\n\n` +
  `Findings (JSON):\n${JSON.stringify(confirmed.map(f => ({ title: f.title, file: f.file, line: f.line, principle: f.principle, severity: f.severity, problem: f.problem, fix: f.fix, source: f.source })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, agentType: 'Explore' }
)

return {
  plan: synthesis.plan,
  note: synthesis.note,
  confirmedCount: confirmed.length,
  rejectedCount: rejected.length,
  droppedAsDuplicateOrContractBreak: synthesis.droppedAsDuplicateOrContractBreak ?? null,
  surfacesAudited: SURFACES.map(s => s.key),
  crosscutsRun: CROSSCUTS.map(c => c.key),
}
