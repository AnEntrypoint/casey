// Installs a per-agent tool allowlist -- the real freddie replacement for
// casey's old enabledToolsets/disabledToolsets contract (freddie has no
// toolset-category concept; ctx.tools is one global registry shared by
// every plugin, including freddie's own base bundle's bash/write/edit/
// file/credential tools -- see AGENTS.md's "freddie integration" section,
// the paragraph headed "the load-bearing replacement for the old
// enabledToolsets contract", which this preserves).
//
// Two independent gates, defense in depth:
//   1. `system-prompt/assemble` waterfall -- hides every non-allowlisted
//      tool's schema from the prompt the model sees.
//   2. `tools/pre-execute` waterfall -- denies dispatch of any
//      non-allowlisted tool by name even if the model somehow names one
//      not in its own visible schema list (a hallucinated/leaked name).
//
// Both are installed scoped to the agent's OWN context (agentCtx, passed to
// `agents.create()`'s `setup` callback) -- not globally -- so a per-turn
// allowlist (e.g. reporter tier vs field_worker tier) never leaks across
// concurrent conversations.
export function installToolAllowlist(agentCtx, allowedNames) {
  const allowed = new Set(allowedNames)
  const disposePrompt = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, tools: assembled.tools.filter(t => allowed.has(t.name)) }
  })
  // The denial names what IS callable, not just what is not. freddie's own
  // registry makes the same point about its collapsed-tool denial (see
  // @freddie/freddie-tools's createExecution): a bare refusal for a name the
  // model believes in reads as a broken deployment, and the model gives up
  // rather than reaching for a tool it may actually use. The reason string is
  // read by the model, never by a person.
  const disposeExecute = agentCtx.on('tools/pre-execute', async (exec, next) => {
    if (!allowed.has(exec.name)) {
      const callable = [...allowed].join(', ')
      return { kind: 'deny', reason: `"${exec.name}" is not one of this conversation's tools -- call one of these instead: ${callable}` }
    }
    return next()
  })
  return () => { disposePrompt(); disposeExecute() }
}
