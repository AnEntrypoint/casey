// maximize-quality -- a GENERIC, target-parameterized engineering-DNA quality
// maximiser. It is the project-agnostic generalisation of casey-maximize-quality.js
// (which stays as the proven, casey-tuned instance): same Map -> Audit (per-surface
// AND cross-cutting) -> adversarial default-refute Verify -> Synthesize pipeline,
// but the target repo, its context, and its surfaces all come from `args` so the
// same workflow can audit freddie, thatcher, or any other repo.
//
// Invoke:
//   Workflow({ scriptPath: 'C:/dev/casey/.claude/workflows/maximize-quality.js',
//              args: { root: 'C:/dev/freddie', projectName: 'freddie',
//                      context: '...what the project is + what must NOT break...',
//                      surfaces: [ { key, files, lens }, ... ] } })
//
// args:
//   root        (required) absolute path to the repo to audit
//   projectName (required) short name, used in labels + prompts
//   context     (required) one paragraph: what the project is, who depends on it,
//               and which contracts are PUBLISHED and must not break
//   surfaces    (optional) [{ key, files, lens }] per-surface auditors. When omitted
//               only the cross-cutting lenses run (they are tree-wide and project-
//               agnostic) and the run logs that the per-surface axis was skipped --
//               an honest, visible degradation, never a silent half-audit.

export const meta = {
  name: 'maximize-quality',
  description: 'Generic engineering-DNA quality maximiser: point it at any repo via args (root/projectName/context/surfaces), it maps the system, audits per-surface + cross-cutting, adversarially verifies every finding (default-refute), and returns one deduped, ordered, apply-ready fix plan with concrete patches.',
  phases: [
    { title: 'Map', detail: 'parallel readers build a factual map of surfaces, data model, dependency spine' },
    { title: 'Audit', detail: 'per-surface + cross-cutting principled auditors' },
    { title: 'Verify', detail: 'independent adversarial verifier per finding (default-refute)' },
    { title: 'Synthesize', detail: 'dedupe, drop contract-breakers, order the apply-ready plan' },
  ],
}

// The harness delivers `args` as a JSON STRING (not a parsed object), so parse it.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
if (!A || typeof A !== 'object' || !A.root || !A.projectName || !A.context) {
  throw new Error('maximize-quality requires args = { root, projectName, context, surfaces? }')
}
const ROOT = String(A.root)
const NAME = String(A.projectName)
const CONTEXT = String(A.context)
const SURFACES = Array.isArray(A.surfaces) ? A.surfaces : []

// The twelve principles, compressed to the cue each auditor reasons from. Self-
// contained so the run needs no external skill file at run time.
const PRINCIPLES = [
  'P1 Data First: clean data shapes + explicit state; a bad data model shows up as convoluted code.',
  'P2 Subtractive: remove what carries cost without value -- dead options, unused exports/deps/files, redundant layers.',
  'P3 Evolutionary: ship-simple-then-iterate; revert-first on regression; no premature abstraction.',
  'P4 Composition Spine: each layer adds exactly one capability; no kitchen-sink module; power-of-one.',
  'P5 Physics-First: design within latency/memory/coordination limits; the worst node is the design target.',
  'P6 Adversarial: make misuse structurally hard; assume partition/failure; no dishonest defaults.',
  'P7 Empirical: measure dont assume; profile before optimising; both-ways for genuine disputes.',
  'P8 Automated Correctness: pure functions; make invalid states unrepresentable; guardrail bug recurrence.',
  'P9 Worst-Case Resilience: explicit degradation paths (full->degraded->safe-fail->explicit-error); never silent catastrophe.',
  'P10 Honest Interfaces: published contracts sacred; never claim a property you cannot guarantee; the manifest (package.json deps/exports/scripts) is a contract too.',
  'P11 Crucible: validate by the hardest integration (concurrency + partial failure + real input together).',
  'P12 Human Value: trace every decision to a human outcome -- a real user or a developer consuming this code.',
].join('\n')

// Cross-cutting axis: these lenses cut ACROSS files, so a per-file auditor cannot
// see them. Project-agnostic -- they run for every target. Each gets the whole tree
// and one job.
const CROSSCUTS = [
  {
    key: 'xc-security',
    lens: 'P6 SECURITY across the whole tree. Hunt, grounded in file:line + the exact tainted source->sink path: injection (SQL/shell/template) of any externally-supplied value; XSS where untrusted text reaches innerHTML or an HTML response unescaped; missing/ bypassable auth or authorization on any route or privileged operation; non-constant-time secret comparison; path traversal in any file read/write; secret/token/PII logged or leaked in an error; unsafe deserialization. Report concrete, grounded vulnerabilities only.',
  },
  {
    key: 'xc-manifest',
    lens: 'P10 MANIFEST + DEPENDENCY HONESTY. The package.json is a published contract. Hunt, grounded: (1) a package imported in src/ (a bare, non-relative, non-node-builtin import) that is NOT declared in dependencies -- a fresh install crashes; (2) a declared dependency that is never imported anywhere -- dead weight to remove (P2); (3) a "scripts" entry (esp. test) that does not actually run what it claims (e.g. a test runner that matches zero files); (4) an "exports"/"main"/"bin" path that points at a file that does not exist. For each: file:line of the import or the manifest line, and the exact correction.',
  },
  {
    key: 'xc-subtractive',
    lens: 'P2 SUBTRACTIVE across the whole tree. Hunt net-smaller wins you have CONFIRMED unused (grep every caller before proposing removal): dead code (unreferenced functions/exports/files), redundant abstraction layers that add no capability, config options/flags that should just be the default, duplicated logic that should be one helper, and bespoke code a well-maintained library the project ALREADY depends on provides. Net-smaller bias; a removal that breaks a test or a published export is NOT a win.',
  },
  {
    key: 'xc-resilience',
    lens: 'P9 + P11 WORST-CASE across the whole tree. Hunt silent-catastrophe paths: an await on an I/O boundary with no try/catch; an unhandled promise rejection; a timer/interval/socket/listener that is never cleared on shutdown (leak); a degradation path missing a rung (full->degraded->safe-fail->explicit-error); a place that assumes the network/DB/peer always succeeds. For each name the worst-case trigger and the missing rung.',
  },
  {
    key: 'xc-contracts',
    lens: 'P10 HONEST INTERFACES across the whole tree. Audit every published/stable contract (the exported API surface, any wire protocol, storage/config schema). Hunt: documentation/comments claiming a property the code does not guarantee; a default that looks good in a demo but fails under partition/load; a breaking change hidden as a refactor; a return shape that lies about what happened (reporting success on a swallowed error).',
  },
  {
    key: 'xc-ai-tells',
    lens: 'AI-TELL + DECORATIVE-GLYPH sweep across the whole tree (code AND comments AND user-facing strings). Hunt: machine-authored tells -- boilerplate flourishes, over-hedged/restating comments, generic scaffold names (foo/handler2/tmp/data2), needless ceremony; AND every decorative glyph (arrows, box/geometric glyphs, stars, filled/hollow bullets, checkmarks/crosses, emoji, any non-ASCII decoration) that should become its ASCII industry-standard (-> for arrows, - or * for bullets, [x]/[ ] or done/todo for checks). Functional operators (=>, ??, ?.) and intentional product copy are NOT tells. Report file:line + exact text + ASCII replacement.',
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
          principle: { type: 'string', description: 'which principle (P1-P12)' },
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
          breakingRisk: { type: 'string', description: 'what could break and which test confirms it did not' },
        },
        required: ['rank', 'title', 'file', 'principle', 'severity', 'problem', 'patch'],
      },
    },
    droppedAsDuplicateOrContractBreak: { type: 'number' },
    note: { type: 'string', description: 'one line on the overall shape of the plan' },
  },
  required: ['plan'],
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
  { key: 'data-model', q: `Map ${NAME}'s DATA MODEL (P1): the core data shapes, where each is created and mutated, and any hidden/global mutable state. Return the factual shapes and the spots where state is implicit.` },
  { key: 'spine', q: `Map ${NAME}'s DEPENDENCY SPINE (P4): which module depends on which, the layering from entrypoint down, any module that reaches DOWN past a layer or any circular/kitchen-sink coupling. Return the factual layering.` },
  { key: 'boundaries', q: `Map ${NAME}'s EXTERNAL BOUNDARIES (P5/P10): every I/O edge (network in/out, disk, DB, child processes, timers) and the published surface (exports map, bin, HTTP API). For each: what it assumes about latency/failure, and what its published contract is.` },
]
const systemMap = (await parallel(MAP_JOBS.map(m => () =>
  agent(
    `${CONTEXT}\n\nRead the real ${NAME} code at ${ROOT} with Read/Grep. ${m.q}\nGround everything in actual file:line. Do not judge yet -- just report what is factually there.`,
    { label: `map:${m.key}`, phase: 'Map', schema: MAP_SCHEMA, agentType: 'Explore' }
  ).then(r => `[${m.key}] ${r.summary}${r.risks?.length ? '\nLeads: ' + r.risks.join('; ') : ''}`)
))).filter(Boolean)
const MAP_BRIEF = systemMap.length
  ? `\n\nSHARED SYSTEM MAP (factual, from a prior read -- use it to aim, verify against real code before trusting):\n${systemMap.join('\n\n')}`
  : ''
log(`map built from ${systemMap.length} readers`)

// ---- Audit + Verify pipeline -------------------------------------------------
if (!SURFACES.length) log(`NOTE: no per-surface auditors supplied for ${NAME} -- running the ${CROSSCUTS.length} cross-cutting lenses only (tree-wide). Pass args.surfaces for per-surface depth.`)
const auditJobs = [
  ...SURFACES.map(s => ({
    label: `audit:${s.key}`,
    prompt:
      `${CONTEXT}\n\nApply this engineering lens:\n${PRINCIPLES}${MAP_BRIEF}\n\n` +
      `Audit this surface of ${NAME}: ${s.files}\nReason hardest from these lenses: ${s.lens}\n\n` +
      `Report ONLY real, concrete defects you can point at in the actual code (file:line + evidence). For each, give a specific MINIMAL fix; prefer net-smaller and non-breaking (do not break a published export, wire protocol, or storage shape). Do NOT invent problems, do NOT report pure style nits, do NOT report anything you cannot ground in real code. If the surface is genuinely sound, return an empty findings array. Use Read and Grep against ${ROOT}.`,
  })),
  ...CROSSCUTS.map(c => ({
    label: c.key,
    prompt:
      `${CONTEXT}\n\nApply this engineering lens:\n${PRINCIPLES}${MAP_BRIEF}\n\n` +
      `You are a CROSS-CUTTING auditor of ${NAME} -- scan the WHOLE tree at ${ROOT}, not one file. Your single job:\n${c.lens}\n\n` +
      `Report ONLY real, concrete, grounded findings (file:line + evidence). Give a specific MINIMAL fix for each; net-smaller and non-breaking. If you genuinely find nothing, return an empty findings array -- do not pad. Use Read and Grep against ${ROOT}.`,
  })),
]
log(`auditing ${SURFACES.length} surface(s) + ${CROSSCUTS.length} cross-cutting lens(es) on ${NAME}`)

phase('Audit')
const verified = await pipeline(
  auditJobs,
  (job) => agent(job.prompt, { label: job.label, phase: 'Audit', schema: FINDING_SCHEMA, agentType: 'Explore' }),
  (audit, job) => parallel((audit?.findings || []).map(f => () =>
    agent(
      `${CONTEXT}\n\nAdversarially verify this claimed defect in ${NAME} at ${ROOT}. DEFAULT to isReal=false unless you can confirm it by reading the actual code.\n\n` +
      `File: ${f.file}:${f.line || '?'}\nPrinciple: ${f.principle}\nSeverity: ${f.severity}\nClaim: ${f.problem}\nProposed fix: ${f.fix}\n\n` +
      `Read the real file and check: (1) does the defect actually exist exactly as described? (2) is the fix correct, net-improving (removes more risk/surface than it adds), and non-breaking (does not change a published export, wire protocol, storage shape, or behaviour the tests rely on)? Set isReal=true ONLY if all hold. If the defect is real but the fix is wrong/incomplete, set isReal=true with a corrected adjustedFix.`,
      { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'Explore' }
    ).then(v => ({ ...f, verdict: v, source: job.label }))
  ))
)

const flat = verified.flat().filter(Boolean)
const confirmed = flat.filter(f => f.verdict?.isReal).map(f => ({ ...f, fix: f.verdict?.adjustedFix || f.fix }))
const rejected = flat.filter(f => !f.verdict?.isReal)
log(`confirmed ${confirmed.length} real findings, rejected ${rejected.length}`)

// ---- Synthesize: dedupe, drop contract-breakers, order the plan --------------
if (!confirmed.length) {
  return { project: NAME, plan: [], confirmedCount: 0, rejectedCount: rejected.length, note: `no confirmed net-improving non-breaking findings -- ${NAME} is sound under this lens.` }
}
phase('Synthesize')
const synthesis = await agent(
  `${CONTEXT}\n\nYou are the SYNTHESISER for ${NAME}. Below are ${confirmed.length} findings that each passed an adversarial default-refute verifier. Turn them into ONE apply-ready plan:\n` +
  `- DEDUPE findings that are the same defect seen from two lenses (keep the clearest statement, union the evidence).\n` +
  `- DROP anything that would break a published contract (an exported API, wire protocol, storage/config schema) or a passing test -- correctness over completeness.\n` +
  `- ORDER by rank: apply-first = highest human value + lowest breaking risk + unblocks other fixes. Security and silent-catastrophe (P6/P9) and a broken manifest (P10) outrank style and subtractive wins unless a subtractive win is a prerequisite.\n` +
  `- For each surviving item give a concrete patch specific enough to apply without re-deriving it, and a breakingRisk line naming which test confirms it stayed green.\n\n` +
  `Findings (JSON):\n${JSON.stringify(confirmed.map(f => ({ title: f.title, file: f.file, line: f.line, principle: f.principle, severity: f.severity, problem: f.problem, fix: f.fix, source: f.source })), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, agentType: 'Explore' }
)

return {
  project: NAME,
  plan: synthesis.plan,
  note: synthesis.note,
  confirmedCount: confirmed.length,
  rejectedCount: rejected.length,
  droppedAsDuplicateOrContractBreak: synthesis.droppedAsDuplicateOrContractBreak ?? null,
  surfacesAudited: SURFACES.map(s => s.key),
  crosscutsRun: CROSSCUTS.map(c => c.key),
}
