// Installs casey's per-turn case system prompt into the agent's own prompt
// assembly -- the seam that carries persona.cjs, report-fields.yml's gather
// rules, the untrusted-data fence, the reply-style rules and the last-chance
// push to the model at all.
//
// WHY THIS EXISTS AS ITS OWN INSTALL: freddie owns the system prompt. It
// assembles one from its OWN registered sections (@freddie/freddie-system-prompt's
// SystemPrompt service) -- `harness:identity`, an empty `deployment:persona`
// slot, and one `tool:<name>` guidance section per tool freddie-base registers.
// Nothing in that assembly reads casey's `hooks/prompt.js`. runTurn() accepts a
// `messages:[{role:'system',...}]` array from hooks/turn-attempts.js purely as a
// signature leftover of the old casey-owned loop, and freddie's agent loop never
// looks at it. So without this module the contact-facing model runs on
// "You are an AI agent powered by Freddie" plus tool prose for bash/write/edit,
// with casey's whole domain prompt discarded -- witnessed live against a real
// booted tree and a real provider: a six-bullet question list, the word "case"
// spoken to the contact (it is on the never-say list), and a spurious case_new
// on a first message. Every behavioural rule casey documents lives in that
// prompt; none of it was in force.
//
// Scoped to the agent's OWN context (agentCtx, from ctx.agents.create()'s
// `setup` callback) exactly like installToolAllowlist, so one conversation's
// prompt never leaks into a concurrent one.
//
// `getPromptText` is a THUNK, not a string: the prompt is rebuilt every turn
// (report-so-far, recent timeline, firstMessage, the nudges), while setup() runs
// once per agent. Reading it at assembly time is what keeps a reused agent's
// prompt current instead of frozen at the first turn.

// The slot freddie reserves for the deployment's own persona, and the order it
// renders at. Named literally rather than imported so this module does not take
// a dependency on a freddie package's export surface for two constants.
const PERSONA_SECTION = 'deployment:persona'

// freddie's own opener. It names Freddie to a contact who is talking to casey,
// and it renders BEFORE the persona slot (order -100), so the first thing the
// model reads would contradict the identity the next section establishes.
const HARNESS_IDENTITY_SECTION = 'harness:identity'

// One guidance section per registered tool, named `tool:<tool name>`.
const TOOL_SECTION_PREFIX = 'tool:'

/**
 * @param agentCtx - the per-agent Cordis context from `ctx.agents.create()`'s `setup`.
 * @param getPromptText - () => string, read at EACH prompt assembly.
 * @param allowedNames - the tool names this conversation may call; every other
 *   tool's `tool:<name>` guidance section is dropped, since installToolAllowlist
 *   has already hidden the schema it describes and prose telling the model to
 *   "use the write tool" for a tool it cannot see is a pure liability.
 * @returns a disposer.
 */
export function installCasePrompt(agentCtx, getPromptText, allowedNames = []) {
  const allowed = new Set(allowedNames)
  return agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const text = getPromptText()
    // No prompt for this turn is a real fault, but not one to fail a live
    // contact's turn over: fall through to freddie's own assembly unchanged so
    // the conversation still gets a reply, and let the caller's own logging say
    // so. Silently substituting nothing here would be indistinguishable from
    // the bug this module fixes.
    if (!text) return assembled
    const sections = []
    for (const section of assembled.sections) {
      if (section.name === HARNESS_IDENTITY_SECTION) continue
      if (section.name === PERSONA_SECTION) { sections.push({ ...section, text }); continue }
      if (section.name.startsWith(TOOL_SECTION_PREFIX)
        && !allowed.has(section.name.slice(TOOL_SECTION_PREFIX.length))) continue
      sections.push(section)
    }
    // The persona slot is freddie's, not casey's: a freddie build that stops
    // registering it must not silently swallow the whole domain prompt. Append
    // rather than lose it.
    if (!sections.some(s => s.name === PERSONA_SECTION)) {
      sections.unshift({ name: PERSONA_SECTION, text })
    }
    return { ...assembled, sections }
  })
}
