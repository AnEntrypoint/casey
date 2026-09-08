// hooks/typing.js -- the guaranteed-response FSM's typing indicator, owned in
// one place instead of threaded as a start-flag plus a closure through
// hooks/handler.js's turn body.
//
// Discord's own typing-indicator TTL is ~10s and DiscordAdapter.startTyping
// re-POSTs on its own shorter interval internally, so a turn only needs to call
// start/stop once, never manage a repeat itself.
//
// Best-effort by construction: startTyping is a UX affordance, never
// load-bearing -- an adapter with no typing support (WhatsApp today) or a
// failed POST degrades silently, never blocks or throws into the real turn. The
// returned stop function must be called from EVERY exit path of the turn. A
// genuine process crash bypasses all of them, which is fine: Discord's
// indicator expires on its own TTL with no re-POST, so a crashed turn's
// indicator self-clears rather than hanging forever.

// Starts the indicator when `enabled` (a live, first-attempt turn -- never a
// background resume/queue re-drive) and the adapter actually supports it.
// Returns the idempotent stop function; calling it more than once, or on a turn
// that never started one, is a no-op.
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
