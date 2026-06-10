// casey-quality-audit -- a reusable multi-agent quality audit for the casey
// project, run through the synthesized-engineering-dna 12-principle lens.
//
// Invoke with no args to audit every surface:
//     Workflow({ name: 'casey-quality-audit' })
// Or pass a list of surface keys to audit a subset:
//     Workflow({ name: 'casey-quality-audit', args: ['gateway-hooks', 'dashboard'] })
//
// Shape: one auditor subagent per surface critiques it against the principles
// most likely to bite that surface, then EACH finding is handed to an
// independent adversarial verifier that defaults to refuting it. Only findings
// the verifier confirms as real AND net-improving AND non-breaking survive into
// the returned `confirmed` list. The audit and verify stages run as a pipeline
// (no barrier) so a surface's findings start verifying the moment that surface
// finishes, rather than waiting for the slowest auditor.

export const meta = {
  name: 'casey-quality-audit',
  description: 'Audit every casey surface through the synthesized-engineering-dna 12 principles; adversarially verify each finding (default-refute) and return only the confirmed, net-improving, non-breaking quality fixes.',
  phases: [
    { title: 'Audit', detail: 'one principled auditor per casey surface' },
    { title: 'Verify', detail: 'independent adversarial verifier per finding' },
  ],
}

const ROOT = 'C:/dev/casey'

// The twelve principles, compressed to the cue each auditor reasons from. Kept in
// the script so the audit is self-contained and portable -- no external skill
// file needed at run time.
const PRINCIPLES = [
  'P1 Data First: clean data shapes + explicit state; bad data model shows up as convoluted code.',
  'P2 Subtractive: remove what carries cost without value; dead options, unused abstractions, redundant layers.',
  'P3 Evolutionary: ship-simple-then-iterate; revert-first on regression; no premature abstraction.',
  'P4 Composition Spine: each layer one capability; no kitchen-sink module; power-of-one (one engineer holds it).',
  'P5 Physics-First: design within latency/memory/coordination constraints; the worst node is the design target.',
  'P6 Adversarial: make misuse structurally hard; assume partition/failure; no dishonest defaults.',
  'P7 Empirical: measure dont assume; profile before optimising; both-ways for genuine disputes.',
  'P8 Automated Correctness: pure functions; make invalid states unrepresentable; guardrail against bug recurrence.',
  'P9 Worst-Case Resilience: explicit degradation paths (full->degraded->safe-fail->explicit-error); never silent catastrophe.',
  'P10 Honest Interfaces: published contracts sacred; never claim a property you cannot guarantee.',
  'P11 Crucible: validate by the hardest integration (concurrency + partial failure + real input together).',
  'P12 Human Value: trace every decision to a human outcome; DX and low-end performance are human outcomes.',
].join('\n')

// Each surface names its files and the principles most likely to expose a defect
// there, so auditors reason from the sharpest lens rather than a generic sweep.
const ALL_SURFACES = [
  {
    key: 'gateway-hooks',
    files: 'src/gateway-hooks.js',
    lens: 'The 784-LOC heart: inbound handler, intent detection, the case_report extraction discipline (collect-maximally/ask-minimally, invisible to the farmer), one-shot closing-nudge, language detection/fallback, deterministic reply tables. Sharpest lenses: P1 (report/intent state), P6 (intent false-positives, misuse), P9 (LLM timeout/error/unreachable degradation), P4 (is this one module doing too much?), P12 (does a worried farmer ever get interrogated or alarmed?).',
  },
  {
    key: 'case-data',
    files: 'src/case-tools.js, src/case-store.js, src/case-runtime.js',
    lens: 'The data model + system of record over thatcher. Sharpest lenses: P1 (case/report/event shapes, hidden mutation, JSON merge correctness), P6 (observe-mode bypass, concurrent writes, dedup), P9 (count caps, thatcher quirks like ignored orderBy), P8 (invalid states representable that should not be). Note thatcher is a published dependency: do not propose forking it.',
  },
  {
    key: 'dashboard',
    files: 'src/dashboard/server.js',
    lens: 'The 861-LOC operator dashboard (express API + single-file HTML PAGE). Sharpest lenses: P6 (XSS where farmer-supplied text reaches innerHTML, request validation, auth gate), P10 (API contract honesty), P8 (input validation guardrails), P12 (operator observability: report panel, readiness, plain language), P9 (behaviour under load / malformed input). Flag any unescaped contact-supplied value.',
  },
  {
    key: 'orchestration',
    files: 'src/casey.js, src/llm.js, src/discord-receive.js',
    lens: 'Orchestrator, LLM backend resolution (stub|acptoapi|none), Discord receive WebSocket. Sharpest lenses: P9 (LLM unreachable/slow degradation, WS reconnect/zombie-socket resilience, graceful shutdown), P10 (honest llm source reporting), P4 (clean layering, no bypass), P6 (assume the socket drops, the provider walks dead providers for minutes).',
  },
  {
    key: 'sim-tests',
    files: 'src/sim/scenarios.js, src/sim/stub-llm.js, src/sim/inject.js, test.js',
    lens: 'The offline simulation harness + test suite. Sharpest lenses: P11 (does the hardest integration get tested -- concurrency + dup + partial-failure + real-input together?), P8 (coverage gaps on confirmed bug classes), P3 (test determinism, isolation between tests), P12 (do the personas reflect real low-literacy SA farmers?). Flag untested surfaces and flaky/order-dependent tests.',
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
          principle: { type: 'string', description: 'which principle (P1-P12) it violates' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          problem: { type: 'string', description: 'the concrete defect, with the code evidence that proves it' },
          fix: { type: 'string', description: 'a specific, minimal fix; prefer net-smaller and non-breaking' },
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
    adjustedFix: { type: 'string', description: 'corrected fix when the defect is real but the original fix was wrong' },
  },
  required: ['isReal', 'reason'],
}

// Resolve the surfaces to audit: args may be a single key, an array of keys, or
// empty/absent for all. Unknown keys are dropped (with a log) rather than failing
// the whole run -- a caller subset typo should not abort a useful audit.
function pickSurfaces(a) {
  if (a == null) return ALL_SURFACES
  const wanted = Array.isArray(a) ? a : [a]
  const known = new Set(ALL_SURFACES.map(s => s.key))
  const bad = wanted.filter(k => !known.has(k))
  if (bad.length) log(`ignoring unknown surface key(s): ${bad.join(', ')} (known: ${ALL_SURFACES.map(s => s.key).join(', ')})`)
  const chosen = ALL_SURFACES.filter(s => wanted.includes(s.key))
  return chosen.length ? chosen : ALL_SURFACES
}

const SURFACES = pickSurfaces(args)
log(`auditing ${SURFACES.length} surface(s): ${SURFACES.map(s => s.key).join(', ')}`)

phase('Audit')
const verified = await pipeline(
  SURFACES,
  (s) => agent(
    `You are auditing the casey project at ${ROOT}. casey is an animal-disease surveillance service for rural South Africa: farmers and NGO field workers report sick or dead livestock over WhatsApp; casey gently gathers a structured report without interrogating them, and gives organisers an observable record. It amplifies the team's intent and must never impose disease rules or escalation.\n\n` +
    `Apply this engineering lens (the synthesized-engineering-dna principles):\n${PRINCIPLES}\n\n` +
    `Audit this surface: ${s.files}\n` +
    `Reason hardest from these lenses for this surface: ${s.lens}\n\n` +
    `Report ONLY real, concrete defects you can point at in the actual code (file:line + the evidence). For each, give a specific MINIMAL fix; prefer fixes that are net-smaller and do not break a published contract (the /v1 dashboard API, the case/event storage shape, thatcher). Do NOT invent problems, do NOT report style nits, do NOT report anything you cannot ground in the real code. If the surface is genuinely sound, return an empty findings array. Use the Read and Grep tools against the real files at ${ROOT}.`,
    { label: `audit:${s.key}`, phase: 'Audit', schema: FINDING_SCHEMA, agentType: 'Explore' }
  ),
  (audit, s) => parallel((audit?.findings || []).map(f => () =>
    agent(
      `Adversarially verify this claimed defect in casey at ${ROOT}. Default to isReal=false unless you can confirm it by reading the actual code.\n\n` +
      `File: ${f.file}:${f.line || '?'}\nPrinciple: ${f.principle}\nSeverity: ${f.severity}\nClaim: ${f.problem}\nProposed fix: ${f.fix}\n\n` +
      `Read the real file and check: (1) does the defect actually exist exactly as described? (2) is the proposed fix correct, net-improving (removes more risk/surface than it adds), and non-breaking (does not change a published contract, the storage shape, or established behaviour the tests rely on)? Set isReal=true ONLY if all hold. If the defect is real but the fix is wrong or incomplete, set isReal=true and give a corrected adjustedFix. Casey's principles must be respected: collect-maximally/ask-minimally, do-not-impose, honest degradation, invisible-to-the-farmer extraction, SA context.`,
      { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'Explore' }
    ).then(v => ({ ...f, verdict: v, surface: s.key }))
  ))
)

const flat = verified.flat().filter(Boolean)
const confirmed = flat.filter(f => f.verdict?.isReal)
const rejected = flat.filter(f => !f.verdict?.isReal)
const bySeverity = (a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity])
log(`confirmed ${confirmed.length} real fixes, rejected ${rejected.length}`)
return {
  confirmed: confirmed.sort(bySeverity).map(f => ({
    title: f.title, file: f.file, line: f.line, principle: f.principle,
    severity: f.severity, surface: f.surface, problem: f.problem,
    fix: f.verdict?.adjustedFix || f.fix, verifyReason: f.verdict?.reason,
  })),
  rejectedCount: rejected.length,
  surfacesAudited: SURFACES.map(s => s.key),
}
