// rearch-enquiry-design -- a gm-driven, multi-agent DESIGN pass for the casey
// worker-enquiry + active-case re-architecture across three repos.
//
//   Workflow({ name: 'rearch-enquiry-design' })
//
// Goal being designed (not yet implemented): field workers must NEGOTIATE/select a
// case before an excursion and data-dump into THAT case, instead of auto-getting a
// new one; they run role-scoped enquiries ("cases near me", "today's list",
// "anything I can help with", "my cases", free-form); they explicitly pick the case
// they are working on, and only get a new case when they ask. Layering mandate:
// agentic code -> freddie (../freddie), CRM code -> thatcher (../thatcher), casey is
// SETUP + CONFIGURATION (its current behavior must be expressible as configuration).
// thatcher is consumed by casey via npm (^range) and PUBLISHES ON PUSH via CI, so a
// thatcher change reaches casey only after publish; freddie is file:../ (immediate).
//
// Shape: fan out one surface-MAPPER per repo (each drives gm, reads its repo by
// path -- codesearch only indexes casey's cwd, so freddie/thatcher are read via
// Read/Grep against ../freddie and ../thatcher). Then three DESIGN agents (one per
// layer) propose where each piece of the feature lands and how casey expresses it
// as config, each fed all three maps. Then an adversarial COHERENCE verifier checks
// the combined design holds across the repo boundary (npm-publish lag, no agentic
// code in thatcher / no CRM code in freddie, casey-as-config, role-scoped security,
// no external_id leak). Returns an apply-ready, dependency-ordered plan.

export const meta = {
  name: 'rearch-enquiry-design',
  description: 'gm-driven multi-agent DESIGN for the casey worker-enquiry + active-case re-architecture across casey/freddie/thatcher: map each repo, design the layered split (agentic->freddie, CRM->thatcher, casey-as-config), adversarially verify cross-repo coherence, return an apply-ready dependency-ordered plan.',
  phases: [
    { title: 'Map', detail: 'one gm-driving surface-mapper per repo' },
    { title: 'Design', detail: 'one design agent per layer, fed all maps' },
    { title: 'Verify', detail: 'adversarial cross-repo coherence check' },
  ],
}

const CASEY = 'C:/dev/casey'
const FREDDIE = 'C:/dev/freddie'
const THATCHER = 'C:/dev/thatcher'

const CONTEXT =
  'casey is an animal-disease surveillance service for rural South Africa: field workers report ' +
  'a farmer\'s sick/dead livestock over WhatsApp/Discord. THE FEATURE TO DESIGN: a worker must ' +
  'NEGOTIATE/select a case before an excursion and data-dump into THAT case (not auto-get a new ' +
  'one); run role-scoped enquiries ("cases near me", "today\'s list", "anything I can help with", ' +
  '"my cases", free-form questions about their role/cases); explicitly pick the case they work on; ' +
  'and get a NEW case only when they explicitly ask. Worker identity = the channel message author ' +
  '(per-author case keying already exists). LAYERING MANDATE (hard): agentic-work code lives in ' +
  'freddie (' + FREDDIE + '), CRM-style code (entities, queries, lists, role-scoped retrieval, ' +
  'geo/proximity, assignment, lifecycle, sort/paging correctness) lives in thatcher (' + THATCHER + '), ' +
  'and casey (' + CASEY + ') is SETUP + CONFIGURATION -- its current behavior must be expressible as ' +
  'configuration and manipulable through config as much as possible. DEPENDENCY BOUNDARY: casey ' +
  'consumes thatcher via npm (caret range) and thatcher PUBLISHES ON PUSH via CI (so a thatcher ' +
  'change reaches casey only after a publish); freddie is a file:../ dep (immediate). Read sibling ' +
  'repos by path with Read/Grep (codesearch only indexes casey\'s cwd).'

const REPOS = [
  { key: 'casey', root: CASEY, focus: 'src/case-store.js (thatcher wrapper + orderBy/sort/paging workarounds, findOrCreate, ref gen), src/case-tools.js + plugins/case-tools (the freddie case_* plugin), src/gateway-hooks.js (intake, intent, conversationKey per-author, active-case logic), src/attn.js/geo.js/clusters.js/workload.js (attention + proximity + analytics), thatcher.config.yml (entities + case_perms/event_perms + workflow), bin/casey.js (CLI), src/dashboard. Map what is AGENTIC vs CRM vs glue/config, and what currently hard-codes behavior that should be config.' },
  { key: 'freddie', root: FREDDIE, focus: 'src/plugins (plugin model + auto-discovery), src/tools + src/toolsets.js + src/toolset_distributions.js (how tools/toolsets are defined, registered, distributed), src/gateway (inbound handling, adapters, intent), src/agent + src/host (the agent harness), src/config.js. Map HOW a casey-style case/enquiry toolset should live here as a configurable freddie plugin/toolset, and how config flows in.' },
  { key: 'thatcher', root: THATCHER, focus: 'src/index.js + exports, src/engine.js/engine.server.js, src/services + src/lib (crud-factory, generic-crud-handler, query/list/filter, business-rules-engine, events-engine, field-registry, config-* ), src/config, README/CLAUDE.md. Map the CONFIG-DRIVEN CRUD/query model: how casey declares entities, and whether list/filter supports order/sort/paging, assignee filters, date filters, and geo/proximity -- or where casey works around a gap (the orderBy-ignored sort casey does in JS). Identify the smallest upstream changes to support role-scoped enquiry queries.' },
]

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    surfaces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'file or module' },
          role: { type: 'string', enum: ['agentic', 'crm', 'glue-config', 'mixed'], description: 'which layer this belongs in per the mandate' },
          summary: { type: 'string', description: 'what it does, with the concrete symbols/exports' },
          relevance: { type: 'string', description: 'how it bears on the enquiry/active-case feature or the layering move' },
          configurable: { type: 'string', description: 'what is hard-coded here that could/should become configuration' },
        },
        required: ['area', 'role', 'summary', 'relevance'],
      },
    },
    gaps: { type: 'array', items: { type: 'string' }, description: 'missing capabilities this repo would need for the feature (e.g. thatcher list lacks order/geo filter)' },
  },
  required: ['repo', 'surfaces'],
}

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    layer: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          repo: { type: 'string', enum: ['casey', 'freddie', 'thatcher'] },
          kind: { type: 'string', enum: ['new', 'move', 'modify', 'config'] },
          where: { type: 'string', description: 'target file/module' },
          what: { type: 'string', description: 'the concrete change, with the function/config shape' },
          why: { type: 'string', description: 'how it serves the feature + respects the layering mandate' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'titles of changes that must land first (esp. thatcher-publish ordering)' },
          configSurface: { type: 'string', description: 'what casey expresses as configuration for this (keeping casey-as-config)' },
        },
        required: ['title', 'repo', 'kind', 'where', 'what', 'why'],
      },
    },
  },
  required: ['layer', 'changes'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    coheres: { type: 'boolean', description: 'true only if the combined design holds across repos and respects every constraint' },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          constraint: { type: 'string', description: 'which constraint is at risk (layering / npm-publish-lag / casey-as-config / role-scoped-security / no-external_id / feature-completeness)' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['constraint', 'problem', 'fix'],
      },
    },
    orderedPlan: {
      type: 'array',
      description: 'the dependency-ordered apply plan (thatcher first -> publish -> freddie -> casey config), each step apply-ready',
      items: {
        type: 'object',
        properties: {
          step: { type: 'number' },
          repo: { type: 'string' },
          action: { type: 'string' },
          blocks: { type: 'string', description: 'what cannot proceed until this lands (e.g. casey waits on thatcher publish)' },
        },
        required: ['step', 'repo', 'action'],
      },
    },
  },
  required: ['coheres', 'orderedPlan'],
}

const GM_CONTRACT =
  'DRIVE GM for this task: boot probe `cat .gm/exec-spool/.status.json; date +%s%3N`, boot the watcher ' +
  'if stale (`bun x gm-plugkit@latest spool`), dispatch `instruction` and follow it. Use `codesearch` ONLY ' +
  'for casey (cwd); read ../freddie and ../thatcher by absolute path with Read/Grep. Witness every claim ' +
  'against real source -- never guess an API or export. You are DESIGNING, not editing: do not modify files.'

phase('Map')
const maps = await parallel(REPOS.map(r => () =>
  agent(
    `${CONTEXT}\n\n${GM_CONTRACT}\n\nMAP the ${r.key} repo at ${r.root}. Focus: ${r.focus}\n\n` +
    `Produce a precise surface map: for each relevant area, its layer (agentic/crm/glue-config), what it ` +
    `does with concrete symbols/exports, its relevance to the worker-enquiry + active-case feature, and ` +
    `what is hard-coded that should become configuration. List the capability GAPS this repo has for the ` +
    `feature. Be exhaustive and exact -- this map is the input to the design.`,
    { label: `map:${r.key}`, phase: 'Map', schema: MAP_SCHEMA }
  )
)).then(a => a.filter(Boolean))

const mapsDigest = JSON.stringify(maps).slice(0, 24000)

phase('Design')
const LAYERS = [
  { key: 'thatcher-crm', prompt: 'Design the THATCHER (CRM) layer: the config-driven entities + the query surface backing role-scoped enquiries (list/filter cases by assignee/worker, by date "today", by proximity "near me", by availability "anything I can help with" = open/unassigned/needs-attention), assignment/claim persistence, and the order/sort/paging correctness casey currently works around in JS. The SMALLEST upstream thatcher changes that let casey express all this as CONFIG. Remember thatcher publishes via CI on push (casey picks it up via npm caret).' },
  { key: 'freddie-agentic', prompt: 'Design the FREDDIE (agentic) layer: a configurable case/enquiry toolset/plugin housing the case_* tools + the enquiry intent recognition + the active-case binding logic (select a case, bind it, append to it, explicitly create-new only on request). How casey passes configuration (which tools, prompts, intents, active-case policy) into this freddie-resident toolset. Preserve autonomy enforcement and the never-dead-end discipline.' },
  { key: 'casey-config', prompt: 'Design the CASEY (setup + configuration) layer: how casey\'s CURRENT behavior becomes a configuration instance over the freddie toolset + thatcher config -- the intake field set, ask hints, VISIT_CRITICAL, autonomy defaults, enquiry intents, active-case policy, role->permission mapping, geo place tokens. What stays in casey (wiring/glue) vs moves out. The config surface a future operator manipulates.' },
]
const designs = await parallel(LAYERS.map(l => () =>
  agent(
    `${CONTEXT}\n\n${GM_CONTRACT}\n\nHere are the three repo surface maps (JSON):\n${mapsDigest}\n\n` +
    `${l.prompt}\n\nReturn concrete, apply-ready changes (repo, kind new/move/modify/config, target file, the ` +
    `function/config shape, why it serves the feature AND the layering mandate, what depends on what, and the ` +
    `config surface casey exposes). Respect: agentic->freddie, CRM->thatcher, casey-as-config; thatcher reaches ` +
    `casey only after a CI publish; never put agentic code in thatcher or CRM code in freddie.`,
    { label: `design:${l.key}`, phase: 'Design', schema: DESIGN_SCHEMA }
  )
)).then(a => a.filter(Boolean))

phase('Verify')
const designDigest = JSON.stringify(designs).slice(0, 28000)
const verdict = await agent(
  `${CONTEXT}\n\n${GM_CONTRACT}\n\nHere is the combined three-layer design (JSON):\n${designDigest}\n\n` +
  `Adversarially verify it COHERES across the three repos. Check every constraint and default to finding a ` +
  `violation if uncertain: (1) LAYERING -- no agentic code lands in thatcher, no CRM code in freddie, casey ` +
  `stays setup+config; (2) NPM-PUBLISH LAG -- any casey change depending on a thatcher change is ordered AFTER ` +
  `the thatcher publish, never assuming an unpublished version; (3) CASEY-AS-CONFIG -- the current behavior is ` +
  `reachable purely by configuration, nothing the feature needs is hard-locked in casey code; (4) ROLE-SCOPED ` +
  `SECURITY -- an enquiry returns only what the worker\'s role permits and NEVER leaks external_id/phone; ` +
  `(5) FEATURE COMPLETENESS -- negotiate-before-excursion, all the named enquiries, explicit active-case ` +
  `selection, new-case-only-on-request are all covered. Return coheres + any violations with fixes + a ` +
  `dependency-ordered apply plan (thatcher -> publish -> freddie -> casey).`,
  { label: 'verify:coherence', phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' }
)

return { maps, designs, verdict }
