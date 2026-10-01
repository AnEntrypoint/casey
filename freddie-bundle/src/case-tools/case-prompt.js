

const PERSONA_SECTION = 'deployment:persona'

const HARNESS_IDENTITY_SECTION = 'harness:identity'

const TOOL_SECTION_PREFIX = 'tool:'

export function installCasePrompt(agentCtx, getPromptText, allowedNames = []) {
  return agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()

    const allowed = new Set(typeof allowedNames === 'function' ? allowedNames() : allowedNames)
    const text = getPromptText()

    if (!text) return assembled
    const sections = []
    for (const section of assembled.sections) {
      if (section.name === HARNESS_IDENTITY_SECTION) continue
      if (section.name === PERSONA_SECTION) { sections.push({ ...section, text }); continue }
      if (section.name.startsWith(TOOL_SECTION_PREFIX)
        && !allowed.has(section.name.slice(TOOL_SECTION_PREFIX.length))) continue
      sections.push(section)
    }

    if (!sections.some(s => s.name === PERSONA_SECTION)) {
      sections.unshift({ name: PERSONA_SECTION, text })
    }
    return { ...assembled, sections }
  })
}
