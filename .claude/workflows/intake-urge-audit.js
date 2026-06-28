// intake-urge-audit -- a reusable multi-agent audit of casey's intake-completion
// URGING behavior: the chat agent must urge the conversation toward every
// remaining visit-critical fact while someone is still on-site, because there is
// only ONE point in time when a person is with the animals. After that the farmer
// leaves and the facts a field visit needs are unrecoverable.
//
// Invoke with no args to audit every dimension of that behavior:
//     Workflow({ name: 'intake-urge-audit' })
// Or pass a list of dimension keys to audit a subset:
//     Workflow({ name: 'intake-urge-audit', args: ['precedence-gate', 'once-per-field'] })
//
// Shape: one subagent per dimension of the intake-urge surface. Each subagent is
// instructed to DRIVE GM on its scoped slice -- boot the spool watcher, dispatch
// `instruction`, walk PLAN -> EXECUTE, witness every claim against the real code
// via the `codesearch`/`exec_js` verbs -- and return a structured findings object.
// Then EACH finding is handed to an independent adversarial verifier that also
// drives gm and defaults to refuting it. Audit and verify run as a pipeline (no
// barrier) so a dimension's findings start verifying the moment that dimension
// finishes. Only findings the verifier confirms as real survive into `confirmed`.
//
// Every finding stays AGGREGATE-ONLY: subagents are forbidden from quoting raw
// contact text or any external_id/phone number into a finding -- the casey
// security invariant (NEVER external_id; observations record field KEYS only)
// binds an audit artifact exactly as it binds production code.

export const meta = {
  name: 'intake-urge-audit',
  description: 'Audit casey\'s intake-completion-urging behavior (the chat agent urging the conversation toward every remaining on-site fact while someone is with the animals). One gm-driving subagent per dimension; each finding adversarially verified by an independent gm-driving refuter. Returns only confirmed, real, aggregate-only findings.',
  phases: [
    { title: 'Audit', detail: 'one gm-driving subagent per intake-urge dimension' },
    { title: 'Verify', detail: 'independent gm-driving adversarial refuter per finding' },
  ],
}

const ROOT = 'C:/dev/casey'

// The one-line gm-driving contract every subagent gets, so each fan-out agent
// runs its own real gm chain rather than a loose read-and-opine. Kept inline so
// the workflow is self-contained and portable.
const GM_CONTRACT =
  'DRIVE GM for this task. First tool call: the boot probe ' +
  '`cat .gm/exec-spool/.status.json; echo ---; date +%s%3N` -- if the watcher ts is ' +
  'stale (>15s) or missing, boot it with `bun x gm-plugkit@latest spool > /dev/null 2>&1 &` ' +
  '(npx fallback if no bun), wait ~8s, re-read .status.json for a fresh ts, THEN dispatch ' +
  '`instruction` with {"prompt":"<your scoped task>"} and follow its imperative. Every ' +
  'code/file/symbol lookup is a `codesearch` verb, every hypothesis you cannot reason to ' +
  'certainty is an `exec_js`/`Read` witness -- never guess, never a platform search agent. ' +
  'Walk PLAN -> EXECUTE only as far as the AUDIT needs (you are reporting findings, not ' +
  'landing edits, so do not transition to EMIT/COMPLETE or push). Witness every claim ' +
  'against the REAL code before you assert it.'

// Each dimension names the files + the exact invariant the intake-urge behavior
// must hold there, so each subagent reasons from the sharpest slice rather than a
// generic sweep. These are the load-bearing pieces of the behavior as it exists
// in the tree today (witnessed at plan time).
const ALL_DIMENSIONS = [
  {
    key: 'one-chance-prompt',
    files: 'src/gateway-hooks.js (caseSystemPrompt, the "THIS IS USUALLY YOUR ONE CHANCE" block ~line 132-150)',
    invariant: 'The system prompt must tell the model that this is usually its one chance before the farmer leaves the animals, give the on-site PRIORITY ORDER (where -> which animals -> signs -> how to find -> farmer present -> other contact), permit at most ONE gentle question when the person is wrapping up, and NEVER re-ask a field already in "report so far". Check: is the priority order complete and correctly ordered for a field visit? Does it forbid interrogation and re-asking? Is the photos nudge gated on most-fields-filled? Does any wording leak a copyable sample reply (banned -- small models parrot it)?',
  },
  {
    key: 'precedence-gate',
    files: 'src/gateway-hooks.js (the PRECEDENCE GATE ~line 843-876, reportMissingVisitCritical, captureDrivenReply)',
    invariant: 'While visit-critical intake is INCOMPLETE, the deterministic capture-driven reply must REPLACE the small model\'s output (which captures nothing and carries no reference). Check: does the gate fire on exactly the incomplete-and-not-content-free condition? Is the override observable/audited? Once intake is complete, is model prose trusted again? Can a non-empty-but-useless model reply ever slip past the gate and reach the contact as a dead-end?',
  },
  {
    key: 'once-per-field',
    files: 'src/gateway-hooks.js (nextUnaskedMissingField ~line 1211, VISIT_CRITICAL_ASK ~line 1085, FALLBACK-ASK observation guard)',
    invariant: 'Each still-missing on-site fact is asked AT MOST ONCE, ever, and the intake advances field-by-field across turns (where -> which -> signs -> ...) instead of re-asking or re-greeting. The once-per-field guarantee is backed by append-only FALLBACK-ASK:<key> observations so the agent\'s own case_update cannot clobber it. Check: can a field be asked twice across turns? Does askedKeys reconstruct correctly from the event log? What happens when every field has been asked once (does it degrade to a plain holding ack, never a re-greet)?',
  },
  {
    key: 'greeting-exemption',
    files: 'src/gateway-hooks.js (isContentFreeTurn ~line 427, warmConversationalReply, the CONVERSATIONAL branch ~line 821)',
    invariant: 'A content-free turn (bare "hi"/"hello"/"help"/chit-chat with nothing captured AND an empty report) must get a warm conversational reply, NEVER the case-ack and NEVER the intake-drive. The moment the contact states a real fact (a captured field or any recorded report field) the turn is no longer content-free and intake proceeds. Check: is the content-free signal exactly (nothing-captured AND empty-report)? Does a symptom-only "blue eyes" correctly fall through to capture+intake, not the warm reply? Is the precedence gate correctly exempted on a content-free turn?',
  },
  {
    key: 'closing-capture',
    files: 'src/gateway-hooks.js (the one-shot closing capture ~line 647, closingCapture path into caseSystemPrompt)',
    invariant: 'When the farmer is wrapping up ("thanks", "ok bye"), casey gets ONE last chance to gently ask for the single most important still-missing on-site fact before they go -- once, never a list, never interrogation. Check: does the closing nudge fire only on a genuine wrap-up signal? Does it ask exactly the most-important missing field (mostImportantMissingField)? Is it one-shot (never repeated)?',
  },
  {
    key: 'field-capture-completeness',
    files: 'src/extract.js (extractFields), src/gateway-hooks.js (captureFieldsFromText, CAPTURE_KEYS, markReportFieldsIfEmpty)',
    invariant: 'Deterministic capture must fill the report from plain contact text (species/symptoms/counts/location/onset/name) in EN/AF/isiZulu/isiXhosa, so a case is never an empty shell even when the small model drives no tools. markReportFieldsIfEmpty must never overwrite an already-captured field. Check: are there visit-critical facts a farmer commonly states that extract.js silently drops (so intake keeps asking for something already said)? Does capture record field KEYS only in observations (never raw PII text)? Any regex that over-captures a greeting/stop-word as a location/name?',
  },
  {
    key: 'assisted-draft-hold',
    files: 'src/gateway-hooks.js (the assisted-mode draft hold + JARGON-HELD + REF-CORRECTED guards ~line 877-925)',
    invariant: 'An intake-urging reply still passes every delivery guard: assisted mode holds it as a draft (never auto-sends), a jargon leak holds it for a human in ANY mode, and a fabricated/stale case reference is rewritten to the real ref before the reply leaves. Check: can an intake-drive reply ever bypass the assisted hold? Can the deterministic ask leak internal jargon (case/triage/workflow/status/priority)? Does the ref-correction run on the deterministic reply too, not just model prose?',
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
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          problem: { type: 'string', description: 'the concrete defect in the intake-urge behavior, with the code evidence that proves it. AGGREGATE-ONLY: never quote raw contact text or any external_id/phone number.' },
          fix: { type: 'string', description: 'a specific, minimal, non-breaking fix; preserve the warm-language and never-dead-end invariants and the single test.js witness.' },
          gmWitness: { type: 'string', description: 'the codesearch hit / exec_js output / file:line you witnessed the claim against while driving gm' },
        },
        required: ['title', 'file', 'severity', 'problem', 'fix', 'gmWitness'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean', description: 'true ONLY if the defect genuinely exists in the intake-urge behavior AND the fix is sound, net-improving, and non-breaking' },
    reason: { type: 'string' },
    adjustedFix: { type: 'string', description: 'corrected fix when the defect is real but the original fix was wrong or breaks a casey invariant' },
  },
  required: ['isReal', 'reason'],
}

// Resolve the dimensions to audit: args may be a single key, an array of keys, or
// empty/absent for all. Unknown keys are dropped (with a log) rather than failing
// the whole run -- a caller subset typo should not abort a useful audit.
function pickDimensions(a) {
  if (a == null) return ALL_DIMENSIONS
  const wanted = Array.isArray(a) ? a : [a]
  const known = new Set(ALL_DIMENSIONS.map(d => d.key))
  const bad = wanted.filter(k => !known.has(k))
  if (bad.length) log(`ignoring unknown dimension key(s): ${bad.join(', ')} (known: ${ALL_DIMENSIONS.map(d => d.key).join(', ')})`)
  const chosen = ALL_DIMENSIONS.filter(d => wanted.includes(d.key))
  return chosen.length ? chosen : ALL_DIMENSIONS
}

const DIMENSIONS = pickDimensions(args)
log(`auditing ${DIMENSIONS.length} intake-urge dimension(s): ${DIMENSIONS.map(d => d.key).join(', ')}`)

const CASEY_CONTEXT =
  `casey is an animal-disease surveillance service for rural South Africa. Farmers and NGO ` +
  `field workers report sick or dead livestock over WhatsApp/Discord in their own language; ` +
  `casey gently gathers a structured report WITHOUT interrogating them. The chat agent's job ` +
  `is to URGE the conversation toward every remaining visit-critical fact while the person is ` +
  `still on-site with the animals -- there is only ONE point in time when someone is with the ` +
  `animals, and after that the farmer leaves and the facts a field visit needs are ` +
  `unrecoverable. The behavior must stay warm and never interrogate, never dead-end, never ` +
  `re-ask a known fact, never re-greet, and never leak internal jargon. The repo is at ${ROOT}.`

phase('Audit')
const verified = await pipeline(
  DIMENSIONS,
  (d) => agent(
    `${CASEY_CONTEXT}\n\n${GM_CONTRACT}\n\n` +
    `Your scoped slice -- audit this ONE dimension of the intake-urge behavior:\n` +
    `Dimension: ${d.key}\nFiles: ${d.files}\nInvariant that must hold: ${d.invariant}\n\n` +
    `Report ONLY real, concrete defects you can point at in the actual code, each witnessed ` +
    `against the real source while driving gm (gmWitness = the codesearch hit / exec_js output ` +
    `/ file:line). For each give a specific MINIMAL fix that preserves casey's invariants ` +
    `(warm plain language, never-dead-end, collect-maximally/ask-minimally, the single ` +
    `mock-free test.js witness, NEVER external_id). Do NOT invent problems, do NOT report ` +
    `style nits, do NOT report anything you cannot ground in the real code. If the dimension ` +
    `is genuinely sound, return an empty findings array. AGGREGATE-ONLY: a finding must never ` +
    `contain raw contact text or a phone number.`,
    { label: `audit:${d.key}`, phase: 'Audit', schema: FINDING_SCHEMA }
  ),
  (audit, d) => parallel((audit?.findings || []).map(f => () =>
    agent(
      `${CASEY_CONTEXT}\n\n${GM_CONTRACT}\n\n` +
      `Adversarially verify this claimed defect in casey's intake-urge behavior. Default to ` +
      `isReal=false unless you can confirm it by reading the actual code while driving gm.\n\n` +
      `Dimension: ${d.key}\nFile: ${f.file}:${f.line || '?'}\nClaim: ${f.problem}\n` +
      `Proposed fix: ${f.fix}\nAuditor's witness: ${f.gmWitness}\n\n` +
      `Witness the real file yourself via codesearch/Read and check: (1) does the defect ` +
      `actually exist exactly as described? (2) is the proposed fix correct, net-improving, ` +
      `and non-breaking -- does it preserve the warm-language, never-dead-end, ` +
      `once-per-field, greeting-exemption, and aggregate-only invariants, and not break the ` +
      `single test.js witness? Set isReal=true ONLY if all hold. If the defect is real but ` +
      `the fix is wrong or breaks an invariant, set isReal=true and give a corrected ` +
      `adjustedFix. AGGREGATE-ONLY in your reason: never echo raw contact text or a phone number.`,
      { label: `verify:${d.key}:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    ).then(v => ({ ...f, verdict: v, dimension: d.key }))
  ))
)

const flat = verified.flat().filter(Boolean)
const confirmed = flat.filter(f => f.verdict?.isReal)
const rejected = flat.filter(f => !f.verdict?.isReal)
const bySeverity = (a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity])
log(`confirmed ${confirmed.length} real intake-urge findings, rejected ${rejected.length}`)
return {
  confirmed: confirmed.sort(bySeverity).map(f => ({
    title: f.title, file: f.file, line: f.line, severity: f.severity,
    dimension: f.dimension, problem: f.problem,
    fix: f.verdict?.adjustedFix || f.fix, verifyReason: f.verdict?.reason,
  })),
  rejectedCount: rejected.length,
  dimensionsAudited: DIMENSIONS.map(d => d.key),
}
