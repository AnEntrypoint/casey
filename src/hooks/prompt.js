// hooks/prompt.js -- casey's system-prompt construction for the agent turn.
//
// caseSystemPrompt is pure text construction over its arguments: no I/O, no
// store writes, synchronous. Keep it that way -- prompt-context.js's constants
// depend on it (see LOCATION_STALE_MS there).
//
// This file owns the COMPOSITION and the structural regression guard at the
// bottom. The two halves it composes live beside it:
//   prompt-context.js  the derived facts (fenced timeline, firstMessage,
//                      returnedAfterGap, the report line) plus the injection fence
//   prompt-sections.js the four blocks of prompt text, in order
// The guard below still runs caseSystemPrompt itself and asserts against the
// FULLY COMPOSED output, so it covers every line in prompt-sections.js exactly
// as it covered them inline -- splitting the text out did not move anything out
// from under it, and a dropped instruction still throws at module load.

import { loadDomainConfig } from '../config-loader.js'
import { buildPromptContext } from './prompt-context.js'
import { headerSection, caseContextSection, gatherSection, replySection } from './prompt-sections.js'

const { persona } = loadDomainConfig()

// Build the system context the agent sees for a given case + recent timeline.
//
// The contact may be elderly, may not read well, and may not speak English as a
// first language. So the prompt does two jobs: it keeps a private structured
// record for the agent's own reasoning (status/priority/timeline, never shown to
// the contact), and it spells out plain-language REPLY rules -- mirror the
// contact's language, short warm sentences, one question, no jargon, greet+give
// the reference on first contact, and reassure when a human is requested.
export function caseSystemPrompt(caseRow, events, contact) {
  const ctx = buildPromptContext(caseRow, events)
  return [
    // --- Private structured context ---
    ...headerSection(persona, caseRow, contact),
    ...caseContextSection(caseRow, ctx),
    // --- What to gather ---
    ...gatherSection(persona, caseRow, ctx),
    // --- How to reply ---
    ...replySection(persona, caseRow, contact, ctx),
  ].join('\n')
}

// Structural regression guard, not a test file. A prompt rewrite (a
// token-budget squeeze, say) can gut a load-bearing behavioral instruction
// without failing lint or syntax checks, because the prompt is just string
// content to every other tool in the pipeline. This module-load-time
// self-check calls caseSystemPrompt with synthetic inputs chosen to trigger
// the two conditional instructions it guards (a long inbound gap, a stale
// check-in) alongside the always-present rules, then asserts each required
// phrase survived. Runs once per process boot (these phrases change only when
// code changes, never turn to turn) and fails loud -- an uncaught throw that
// crashes boot -- the moment an edit silently drops one.
// No standing test file, no test framework: this IS production code, run by
// the real module on real startup. Adding a new conditional instruction that
// matters means adding both an input that triggers it and its phrase below.
function selfCheckLoadBearingPromptContent() {
  const now = Date.now()
  const oldTs = new Date(now - 5 * 3600e3).toISOString()
  const recentTs = new Date(now).toISOString()
  const staleContact = { last_location_lat: -1, last_location_lon: 1, last_location_at: String(Math.floor((now - 10 * 3600e3) / 1000)) }
  const events = [
    { kind: 'inbound', actor: 'contact', text: 'x', created_at: oldTs },
    { kind: 'inbound', actor: 'contact', text: 'y', created_at: recentTs },
  ]
  const caseRow = { ref: 'SELFCHECK', id: 'selfcheck', status: 'triaging', priority: 'normal', assignee: null, subject: null, summary: null, tags: null, report: null, autonomy: 'auto' }
  const text = caseSystemPrompt(caseRow, events, staleContact)
  const required = [
    { name: 'two-item question requirement', pattern: /top TWO|TOP TWO|top two/ },
    { name: 'gap-detection instruction (reporter went quiet)', pattern: /person was gone a while/ },
    { name: 'stale-location no-assume instruction', pattern: /ask where they are now/ },
    { name: 'priority-order asking sequence', pattern: /PRIORITY ORDER/ },
    { name: 'permission-to-skip owner-contact question', pattern: /PERMISSION TO SKIP/ },
    // The single rule this whole system rests on: every value in a report came
    // from a person, not from the model. Guarded here because a prompt rewrite
    // that drops it does not fail anything -- the agent simply starts filling
    // gaps plausibly, and nobody reading the dashboard can tell which values
    // were said and which were inferred.
    { name: 'record-only-what-was-said rule', pattern: /RECORD ONLY WHAT WAS ACTUALLY SAID/ },
    // The carve-out has to survive with it: without the exception sentence the
    // rule above contradicts the geo fields, whose own descriptions ask the
    // model to estimate a coordinate from a described place.
    { name: 'estimate-exception carve-out', pattern: /explicitly asks you to estimate/ },
  ]
  for (const { name, pattern } of required) {
    if (!pattern.test(text)) {
      throw new Error(`caseSystemPrompt regression: required phrase missing (${name}). A prompt rewrite silently dropped a load-bearing behavioral instruction -- see AGENTS.md's prompt-steering notes.`)
    }
  }
}
selfCheckLoadBearingPromptContent()
