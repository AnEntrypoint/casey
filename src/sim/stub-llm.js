// stub-llm.js  --  a deterministic fake model for offline simulation and tests.
// NOT for production: `casey up` runs the real model via freddie's resolver
// (callLLM=null). This lets `casey sim` and the test suite exercise the full
// agent loop with no provider keys.
//
// Shape matches freddie's callLLM contract: ({messages,tools}) => {content, tool_calls}.
export function stubLLM() {
  return async ({ messages }) => {
    const sys = messages.find(m => m.role === 'system')?.content || ''
    const caseId = (sys.match(/id=(\S+?)\)/) || [])[1]
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || ''
    const toolResults = messages.filter(m => m.role === 'tool').length
    // First turn: triage via tools (update + transition). Later turns: reply.
    if (caseId && toolResults === 0) {
      return {
        content: '',
        tool_calls: [
          { id: 't1', name: 'case_update', arguments: { id: caseId, summary: `Contact says: ${lastUser.slice(0, 80)}`, priority: 'high', tags: 'sim' } },
          { id: 't2', name: 'case_transition', arguments: { id: caseId, to: 'triaging', reason: 'auto-triage (stub)' } },
        ],
      }
    }
    return { content: "Thanks, I've logged this and a human will follow up.", tool_calls: [] }
  }
}
