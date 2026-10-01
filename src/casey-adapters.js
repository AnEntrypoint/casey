

function channelRegistry(deps) {
  return {
    discord: () => makeDiscordAdapter(deps),
    whatsapp: () => makeWhatsappAdapter(deps),
  }
}

export async function makeChannelAdapter(ch, deps) {
  const registry = channelRegistry(deps)
  const factory = registry[ch]
  if (!factory) throw new Error(`unknown channel "${ch}"`)
  return factory()
}

async function makeDiscordAdapter({ log, store, dataDir, markConnected, markInbound }) {
  {
    const { DiscordAdapter } = await import('./adapters/discord.js')
    const { DiscordSessionStore } = await import('./adapters/discord-lib/session-store.js')
    const { recordDroppedInbound } = await import('./hooks/dropped-intake.js')

    const a = new DiscordAdapter({
      log,
      sessionStore: new DiscordSessionStore({ dataDir, log }),
      onUnresumableGap: (note) => recordDroppedInbound('gateway_gap_unresumable', { channel: 'discord', store, log, note }),
    })

    const followUpWindow = new Map()
    const FOLLOWUP_MS = Number(process.env.CASEY_DISCORD_FOLLOWUP_MS) || 2 * 3600e3

    const pendingIdentityUnknown = []
    const PENDING_IDENTITY_MAX = 50
    const PENDING_IDENTITY_MAX_AGE_MS = 15000

    ;(async () => {
      try {
        const rows = await store?.listCases?.({}, { limit: 10000 })
        for (const c of rows || []) {
          if (c.channel !== 'discord' || c.status === 'closed') continue
          if (!String(c.external_id || '').includes(':')) continue
          followUpWindow.set(c.external_id, Date.now() + FOLLOWUP_MS)
        }
      } catch {  }
    })()
    const origEmit = a.emit.bind(a)
    a.emit = (event, msg, ...rest) => {
      if (event === 'message') {
        const raw = msg?.raw || {}

        const isDM = !raw.guild_id
        const mentions = Array.isArray(raw.mentions) ? raw.mentions : []

        const botMentioned = !!a.botUserId && mentions.some(u => u.id === a.botUserId)
        const followKey = `${raw.channel_id || ''}:${raw?.author?.id || ''}`
        const inConversation = !isDM && !botMentioned && (followUpWindow.get(followKey) || 0) > Date.now()

        if (!isDM && !a.botUserId && !msg._identityReplay) {
          const now = Date.now()
          while (pendingIdentityUnknown.length && now - pendingIdentityUnknown[0].at > PENDING_IDENTITY_MAX_AGE_MS) pendingIdentityUnknown.shift()
          if (pendingIdentityUnknown.length >= PENDING_IDENTITY_MAX) pendingIdentityUnknown.shift()
          pendingIdentityUnknown.push({ msg, rest, at: now })
          log?.info?.('[discord] message held pending gateway identity', { channelId: raw.channel_id || null, guildId: raw.guild_id || null })
          return false
        }
        if (!isDM && !botMentioned && !inConversation) {

          if (!a.botUserId) recordDroppedInbound('gateway_identity_unknown', { channel: 'discord', store, log })

          log?.warn?.('[discord] message filtered (not a DM, bot not mentioned)', {
            channelId: raw.channel_id || null,
            guildId: raw.guild_id || null,
            authorId: raw?.author?.id || null,
            botUserId: a.botUserId || null,
            mentionIds: mentions.map(u => u?.id).filter(Boolean),
          })
          return false
        }

        if (!isDM) {
          followUpWindow.set(followKey, Date.now() + FOLLOWUP_MS)
          if (followUpWindow.size > 500) {
            const now = Date.now()
            for (const [k, exp] of followUpWindow) { if (exp <= now) followUpWindow.delete(k) }
          }
        }

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

    a.on('ready', () => {
      markConnected('discord')

      const now = Date.now()
      const held = pendingIdentityUnknown.splice(0, pendingIdentityUnknown.length)
      for (const { msg, rest, at } of held) {
        if (now - at > PENDING_IDENTITY_MAX_AGE_MS) continue
        a.emit('message', { ...msg, _identityReplay: true }, ...rest)
      }
    })

    return a
  }
}

async function makeWhatsappAdapter({ markInbound } = {}) {
  const { WhatsappAdapter } = await import('./adapters/whatsapp.js')
  const a = new WhatsappAdapter()

  if (typeof markInbound === 'function') a.on('message', () => { try { markInbound('whatsapp') } catch {  } })
  return a
}
