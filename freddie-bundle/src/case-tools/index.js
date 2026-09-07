// Cordis plugin registering casey's case_* tools into freddie's ctx.tools
// (real freddie: defineTool + ctx.tools.register -- see deps/freddie's
// packages/core/tools/src/schema.js and packages/todo/tool-todo/src/index.js
// for the reference pattern this mirrors).
//
// Reuses casey's own buildCaseToolset() (src/case-tools.js) unchanged --
// tool NAMES, DESCRIPTIONS, PARAMETER SCHEMAS, and HANDLER LOGIC all still
// live there, the single source of truth. This plugin is purely an adapter:
// it converts each tool's JSON-Schema parameters to Cordis's DSL
// (schema-adapt.js) and wraps each handler to receive freddie's `exec`
// (carrying exec.agent for session-event writes) instead of casey's own
// toolCtx shape -- casey's toolCtx is supplied at registration time via
// this plugin's Config, not derived from exec, since casey's ctx fields
// (author, tier, activeCaseBinding, dedupeCache) are per-CONTACT-TURN state
// that freddie's own exec object has no equivalent of.
import { defineTool } from '@freddie/freddie-tools'
import { buildCaseToolset } from '../../../src/case-tools.js'
import { getCurrentToolCtx } from '../../../src/agent/run-turn.js'
import { adaptParameters, JSON_OUTPUT_SCHEMA, renderJsonOutput } from './schema-adapt.js'

export const name = 'casey-case-tools'
export const inject = ['tools']

/**
 * @param ctx - the Cordis context (ctx.tools is required, per `inject` above)
 *
 * Each tool's execute(args, exec) resolves casey's live per-turn toolCtx
 * (author/tier/store/activeCaseBinding/dedupeCache) via
 * getCurrentToolCtx(exec.agent.id) -- src/agent/run-turn.js publishes it
 * fresh on every runTurn() call, keyed by the agent's own session id (which
 * IS the sessionKey runTurn() was called with -- SessionId() is an identity
 * brand, not a transform).
 */
export function apply(ctx) {
  for (const tool of buildCaseToolset(null)) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.schema.description,
      parameters: adaptParameters(tool.schema.parameters),
      output: { schema: JSON_OUTPUT_SCHEMA, render: renderJsonOutput },
      execute: (args, exec) => tool.handler(args, getCurrentToolCtx(exec.agent.id)),
    }))
  }
}
