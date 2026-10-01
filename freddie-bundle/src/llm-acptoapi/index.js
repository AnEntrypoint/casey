

import { AcptoapiAdapter } from './adapter.js'

export const name = 'casey-llm-acptoapi'
export const inject = ['llm']

const PROVIDER = 'acptoapi'

export function apply(ctx, config) {
  const adapter = new AcptoapiAdapter({ getModel: config?.getModel })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
