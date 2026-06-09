// sim/inject.js  --  offline message injector. Emits synthetic inbound 'message'
// events into a freddie Gateway exactly as a real platform adapter would, so we
// can exercise the full case-tracking + agent path with no bot token or webhook.
//
// A MockAdapter satisfies the same contract the Gateway expects (EventEmitter
// with start/stop/send). send() captures replies so a sim script can assert on
// or print them.

import { EventEmitter } from 'node:events'

export class MockAdapter extends EventEmitter {
  constructor(platform = 'sim') {
    super()
    this.platform = platform
    this.sent = []
    this.onReply = null
  }
  getRequiredEnv() { return [] }
  async start() {}
  async stop() {}
  async send(reply) {
    this.sent.push(reply)
    if (this.onReply) await this.onReply(reply)
    return { ok: true, mock: true }
  }
  // Simulate a contact sending a message on a given conversation/channel.
  // `id` and `type` flow into raw so dedup and media handling can be exercised.
  inject({ from = 'user-1', channel_id = 'sim-chan-1', text, username, id, type }) {
    this.emit('message', {
      from,
      text,
      platform: this.platform,
      raw: { channel_id, id, type, author: { id: from, username: username || from } },
    })
  }
}

// Drive a scripted conversation through a gateway's mock adapter, printing each
// turn. `lines` is an array of strings (contact messages) or objects.
export async function runScript(adapter, lines, { from = 'alice', channel_id = 'sim-chan-1', username = 'Alice', wait = () => Promise.resolve() } = {}) {
  const transcript = []
  // Carry caseId so callers can print THIS run's case rather than guessing with
  // listCases()[0] (thatcher ignores orderBy, so "first" is arbitrary across
  // accumulated sim runs sharing one external_id).
  adapter.onReply = (reply) => { transcript.push({ role: 'agent', text: reply.text, caseId: reply.caseId }) }
  for (const line of lines) {
    const msg = typeof line === 'string' ? { text: line } : line
    transcript.push({ role: 'contact', text: msg.text })
    adapter.inject({ from, channel_id, username, ...msg })
    await wait()                 // allow the async gateway turn to complete
  }
  return transcript
}
