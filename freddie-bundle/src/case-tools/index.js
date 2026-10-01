

import { defineTool } from '@freddie/freddie-tools'
import { buildCaseToolset } from '../../../src/case-tools.js'
import { getCurrentToolCtx } from '../../../src/agent/run-turn.js'
import { adaptParameters, JSON_OUTPUT_SCHEMA, renderJsonOutput } from './schema-adapt.js'

export const name = 'casey-case-tools'
export const inject = ['tools']

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
