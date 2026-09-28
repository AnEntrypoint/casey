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
  // `allowedNames` is an array (fixed for the agent's life) or a function read at
  // EACH prompt assembly and dispatch. src/agent/run-turn.js passes the function
  // form so a contact promoted mid-conversation (a role code, a dashboard
  // assignment) gets their new tools on the very next turn instead of keeping the
  // allowlist the agent was created with.
  const current = () => new Set(typeof allowedNames === 'function' ? allowedNames() : allowedNames)
  const disposePrompt = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const allowed = current()
    return { ...assembled, tools: assembled.tools.filter(t => allowed.has(t.name)) }
  })
  const disposeExecute = agentCtx.on('tools/pre-execute', async (exec, next) => {
    const allowed = current()
    if (!allowed.has(exec.name)) {
      const callable = [...allowed].join(', ')
      return { kind: 'deny', reason: `"${exec.name}" is not one of this conversation's tools -- call one of these instead: ${callable}` }
    }
    return next()
  })
  return () => { disposePrompt(); disposeExecute() }
}
