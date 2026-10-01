

export function installToolAllowlist(agentCtx, allowedNames) {

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
