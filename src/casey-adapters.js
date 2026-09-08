// casey-adapters.js -- building the per-channel transport adapter objects.
//
// Lifted out of the Casey class, where _makeDiscordAdapter alone was 119 lines
// -- the largest method left after the resume and drain sweeps moved out, and,
// like them, not part of what that class is for. Casey assembles and supervises
// a process; this decides how a channel is wired.
//
// What the Discord wrapper is and is not is worth keeping straight, because the
// original comment is emphatic about it: the connect/reconnect/heartbeat/typing
// mechanics live entirely in freddie's own DiscordAdapter now, and casey's
// wrapper is purely CONFIGURATION -- which inbound events open a case, and
// verifying outbound delivery -- never adapter mechanics.
//
// The receive-liveness stamps the wrapper needs (markConnected, markInbound)
// arrive as callbacks rather than as `this`, so the module cannot reach back
// into the instance for anything else.

// Channel registry: channel name -> async factory returning a ready adapter
// instance. Adding a new channel (SMS, Telegram, Signal) means adding ONE
// entry here (a new `_makeXAdapter` method plus a registry line) instead of
// editing an if/else control-flow chain -- the registry is the single place
// that answers "what channels does casey support" and "how do I add one".
// A channel still needs its own thatcher.config.yml enum edit (contact.
// channel/case.channel/event.channel) since the channel name is also a
// stored data value, not just a code branch -- that part is inherent to
// channel being a config-declared enum (see case-type-enum-config-driven /
// priority-levels-config-driven for the same enum-vs-code-literal split) and
// is not solved by this registry, only the ADAPTER WIRING side is.
function channelRegistry(deps) {
  return {
    discord: () => makeDiscordAdapter(deps),
    whatsapp: () => makeWhatsappAdapter(),
  }
}

export async function makeChannelAdapter(ch, deps) {
  const registry = channelRegistry(deps)
  const factory = registry[ch]
  if (!factory) throw new Error(`unknown channel "${ch}"`)
  return factory()
}

// whatsapp / discord come from freddie's platform plugins, registered on the
// host's pi.platforms registry. We instantiate their adapter classes directly
// for gateway use.
//
// Discord's gateway connect/reconnect/heartbeat/typing mechanics live
// ENTIRELY in freddie's own DiscordAdapter now (plugins/platform-discord/
// handler.js) -- casey previously carried a second, parallel implementation
// (discord-receive.js) because an earlier freddie build's built-in receive
// loop lacked a reconnect backoff ceiling and zombie-heartbeat detection.
// freddie's adapter has since been upgraded to include both (merged in from
// casey's own implementation, per the project's layering mandate: agentic
// harness -> freddie, casey is setup + configuration only) plus a `ready`
// event and a `botUserId` getter, so casey's wrapper here is now purely
// CONFIGURATION -- filtering which inbound events open a case, and
// verifying outbound delivery status -- never adapter mechanics. Follow
// this method as the template for a future realtime-socket channel.
async function makeDiscordAdapter({ log, store, markConnected, markInbound }) {
  {
    const { DiscordAdapter } = await import('./adapters/discord.js')
    const a = new DiscordAdapter({ log: log })
    // Filter guild channel messages to only DMs (guild_id absent), @mentions
    // of the bot, or plain follow-ups from an author mid-conversation with
    // the bot in that channel. Without this, every message in any guild
    // channel creates a case -- surveillance intake should only trigger when
    // someone deliberately contacts the bot, not from general server
    // conversation.
    //
    // The follow-up window: a real person who @mentions the bot once keeps
    // talking PLAINLY -- nobody re-mentions on every message, and the
    // mention-only gate was silently eating the rest of their conversation
    // (live-witnessed: 2 of a 3-message burst from a known field bot dropped
    // at this gate). Keyed exactly like handler.js's conversationKey
    // (container:author) so only the SAME author in the SAME channel
    // inherits the window, and TTL-bounded so the widening fails closed
    // shortly after the conversation goes quiet. CASEY_DISCORD_FOLLOWUP_MS
    // overrides the 2h default.
    const followUpWindow = new Map()   // `${channel_id}:${author_id}` -> expiry ms
    const FOLLOWUP_MS = Number(process.env.CASEY_DISCORD_FOLLOWUP_MS) || 2 * 3600e3
    // Seed the window from already-open Discord cases: the map is in-memory,
    // so a restart mid-conversation would otherwise fail closed and silently
    // eat a known contact's next plain follow-up until they re-mention
    // (live-witnessed: first plain message after a restart filtered at this
    // gate). An open (not closed) case IS an active conversation by
    // definition. Fire-and-forget -- only widens FUTURE acceptance, never
    // blocks adapter construction; a failed read just starts the window
    // empty (fail closed, same as before).
    ;(async () => {
      try {
        const rows = await store?.listCases?.({}, { limit: 10000 })
        for (const c of rows || []) {
          if (c.channel !== 'discord' || c.status === 'closed') continue
          if (!String(c.external_id || '').includes(':')) continue
          followUpWindow.set(c.external_id, Date.now() + FOLLOWUP_MS)
        }
      } catch { /* seeding is best-effort; the window simply starts empty */ }
    })()
    const origEmit = a.emit.bind(a)
    a.emit = (event, msg, ...rest) => {
      if (event === 'message') {
        const raw = msg?.raw || {}
        // DM: no guild_id. Guild: only if bot is @mentioned.
        const isDM = !raw.guild_id
        const mentions = Array.isArray(raw.mentions) ? raw.mentions : []
        // Fail CLOSED when botUserId is not yet known (process boot, or a
        // reconnect that lost the cached id), not open: the old fallback
        // (mentions.length > 0) treated ANY guild message mentioning ANY
        // user as "the bot was mentioned", opening a case from ordinary
        // guild chatter that never referenced casey at all -- the opposite
        // of this gate's whole purpose. The OBSERVABILITY log below already
        // records a.botUserId (null or real) on every filtered message, so
        // an operator can still distinguish "filtered because identity
        // isn't known yet" from "filtered because not a mention" with no
        // further plumbing.
        const botMentioned = a.botUserId ? mentions.some(u => u.id === a.botUserId) : mentions.length > 0
        const followKey = `${raw.channel_id || ''}:${raw?.author?.id || ''}`
        const inConversation = !isDM && !botMentioned && (followUpWindow.get(followKey) || 0) > Date.now()
        if (!isDM && !botMentioned && !inConversation) {
          // OBSERVABILITY: this filter used to drop a message with ZERO trace
          // anywhere -- not even a debug log line -- so a real inbound that
          // failed this check for any reason (a.botUserId not yet captured
          // from READY, Discord's mentions array shaped differently than
          // expected, a genuine non-mention message) was structurally
          // invisible: no case created, no receive-health stamp, nothing to
          // grep for. Live-witnessed this session: a real "@memobot hi" got
          // a guaranteed-fallback reply from an OLD, unrelated case while
          // the actual live message left no log trace at all, making this
          // exact gate the prime suspect with no way to confirm it. Log
          // every filtered-out message loud (never PII -- author id only,
          // never message content) so a silent drop is never silent again.
          log?.warn?.('[discord] message filtered (not a DM, bot not mentioned)', {
            channelId: raw.channel_id || null,
            guildId: raw.guild_id || null,
            authorId: raw?.author?.id || null,
            botUserId: a.botUserId || null,
            mentionIds: mentions.map(u => u?.id).filter(Boolean),
          })
          return false
        }
        // Accepted: (re)open/slide this author's follow-up window in this
        // channel so their next plain messages pass too. Prune expired
        // entries on write -- bounded by construction (one entry per
        // recently-active container:author pair, each self-expiring).
        if (!isDM) {
          followUpWindow.set(followKey, Date.now() + FOLLOWUP_MS)
          if (followUpWindow.size > 500) {
            const now = Date.now()
            for (const [k, exp] of followUpWindow) { if (exp <= now) followUpWindow.delete(k) }
          }
        }
        // We received a real, addressed-to-us inbound: receive is alive. Stamp
        // BEFORE delegating so a throw downstream still records that we heard.
        markInbound('discord')
        log?.info?.('[discord] message accepted for intake', {
          channelId: raw.channel_id || null,
          guildId: raw.guild_id || null,
          authorId: raw?.author?.id || null,
          isDM,
          botMentioned,
          followUp: inConversation,
        })
      }
      return origEmit(event, msg, ...rest)
    }
    // 'ready' fires on the REAL READY/RESUMED gateway dispatch events inside
    // the adapter -- stamps connectedAt so GET /api/health reflects true
    // receive-liveness (a live TCP socket is not the same as a dead gateway
    // delivering no inbound; see AGENTS.md's receive-liveness principle).
    a.on('ready', () => markConnected('discord'))
    // Outbound delivery is verified upstream: freddie's DiscordAdapter.send()
    // (freddie ^0.0.212) already routes through its own verifiedSend(), which
    // throws on a non-2xx / errored response body, so the caller here already
    // gets a rejected promise on a failed send.
    return a
  }
}

// WhatsApp needs no receive-resilience wrapper: freddie's WhatsappAdapter is
// webhook-driven (Meta posts to us), not a persistent socket casey must
// reconnect -- a genuinely simpler channel than Discord's realtime gateway.
// A future webhook-driven channel (e.g. SMS via a carrier webhook) likely
// fits this simpler shape rather than Discord's.
async function makeWhatsappAdapter() {
  const { WhatsappAdapter } = await import('./adapters/whatsapp.js')
  return new WhatsappAdapter()
}
