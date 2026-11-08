

export function makeTypingIndicator({ adapter, replyTo, log = console, caseId, enabled = true }) {
  let started = false
  if (enabled && typeof adapter?.startTyping === 'function') {
    try { adapter.startTyping(replyTo); started = true }
    catch (e) { log.warn?.('[casey] startTyping failed', { caseId, error: e.message }) }
  }
  return function stopTyping() {
    if (!started) return
    started = false
    try { adapter.stopTyping?.(replyTo) }
    catch (e) { log.warn?.('[casey] stopTyping failed', { caseId, error: e.message }) }
  }
}
