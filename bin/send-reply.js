import { caseDeliveryTarget } from '../src/hooks/handler.js'
import { proactiveRefusal } from '../src/proactive-sends.js'

export function makeSendReply(casey) {
  return (caseRow, text) => {
    const noStart = proactiveRefusal({})
    if (noStart) return Promise.reject(new Error(noStart))
    const a = casey.adapters[caseRow.channel]
    if (!a?.send) {
      return Promise.reject(new Error(`no adapter for channel "${caseRow.channel}" -- nothing was sent`))
    }
    return a.send({ to: caseDeliveryTarget(caseRow), text })
  }
}
