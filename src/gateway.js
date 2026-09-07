// Casey's own minimal Gateway, replacing freddie's src/gateway/run.js
// Gateway class (freddie's messaging-transport surface was removed in a
// later upstream rewrite -- see AGENTS.md's freddie-port PRD rows).
// Deliberately minimal: casey.js always REPLACES handleInbound with its own
// case-aware handler (see gateway-hooks.js) before start(), so freddie's own
// handleInbound (its xstate lifecycle machine, message persistence, safe-fail
// reply) is dead weight for this consumer -- only platform registration +
// start/stop + an overridable handleInbound are load-bearing here.
export class Gateway {
  constructor({ platforms = {} } = {}) {
    this.platforms = new Map()
    for (const [name, adapter] of Object.entries(platforms)) this.register(name, adapter)
  }

  register(name, adapter) {
    this.platforms.set(name, adapter)
    adapter.on?.('message', (m) => {
      this.handleInbound(name, m).catch(e => console.error('[gateway] message listener error', { platform: name, from: m.from, error: String(e?.message || e) }))
    })
  }

  async start() {
    for (const a of this.platforms.values()) await a.start?.()
  }

  async stop() {
    for (const a of this.platforms.values()) await a.stop?.()
  }

  // Overridden by casey.js before start() -- see its own header comment.
  // This default only fires if a caller never replaced it.
  async handleInbound(platform, msg) {
    const adapter = this.platforms.get(platform)
    const reply = { to: msg.from, text: 'Sorry, no handler is configured for this message.', platform }
    try { await adapter?.send?.(reply) } catch (e) { console.error('[gateway] default handleInbound send failed', { platform, error: String(e?.message || e) }) }
    return reply
  }
}
