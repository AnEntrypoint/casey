// Registers AcptoapiAdapter as the 'acptoapi' provider route on freddie's
// ctx.llm (real freddie: ctx.llm.registerAdapter -- see deps/freddie's
// packages/llm/llm-deepseek/src/index.js for the reference registration
// pattern this mirrors).
import { AcptoapiAdapter } from './adapter.js'

export const name = 'casey-llm-acptoapi'
export const inject = ['llm']

const PROVIDER = 'acptoapi'

export function apply(ctx, config) {
  const adapter = new AcptoapiAdapter({ getModel: config?.getModel })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
