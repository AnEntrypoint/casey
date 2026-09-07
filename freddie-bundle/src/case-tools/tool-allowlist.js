// Installs a per-agent tool allowlist -- the real freddie replacement for
// casey's old enabledToolsets/disabledToolsets contract (freddie has no
// toolset-category concept; ctx.tools is one global registry shared by
// every plugin, including freddie's own base bundle's bash/write/edit/
// file/credential tools -- see AGENTS.md's "pi tool surface" security
// invariant this preserves).
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
  const disposeExecute = agentCtx.on('tools/pre-execute', async (exec, next) => {
    if (!allowed.has(exec.name)) {
      return { kind: 'deny', reason: `tool "${exec.name}" is not available to this agent` }
    }
    return next()
  })
  return () => { disposePrompt(); disposeExecute() }
}
