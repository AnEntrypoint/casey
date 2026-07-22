import { createCasey } from './src/casey.js';

const PLATFORM = 'testplatform';
const CONTAINER = 'test-channel-' + Date.now();

function makeAdapter(log) {
  return {
    name: PLATFORM,
    replies: [],
    typingCalls: [],
    async send(reply) { this.replies.push(reply); if (log) console.log('REPLY>', JSON.stringify(reply).slice(0, 500)); },
    startTyping(to) { this.typingCalls.push({ event: 'start', to }); },
    stopTyping(to) { this.typingCalls.push({ event: 'stop', to }); },
  };
}

async function boot() {
  const casey = await createCasey({ channels: [], resumeOnBoot: false, sweepIntervalMs: 0, drainPollIntervalMs: 0 });
  const adapter = makeAdapter(true);
  casey.gateway.platforms.set(PLATFORM, adapter);
  casey.adapters = casey.adapters || {};
  casey.adapters[PLATFORM] = adapter;
  return { casey, adapter };
}

function makeMsg({ author, text, msgId, container = CONTAINER }) {
  return {
    from: author,
    text,
    platform: PLATFORM,
    raw: { channel_id: container, id: msgId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, author: { username: author } },
  };
}

async function sendTurn(casey, adapter, { author, text, msgId, container }) {
  const msg = makeMsg({ author, text, msgId, container });
  const before = adapter.replies.length;
  const t0 = Date.now();
  await casey.gateway.handleInbound(PLATFORM, msg);
  const elapsed = Date.now() - t0;
  const newReplies = adapter.replies.slice(before);
  return { elapsed, replies: newReplies, msg };
}

export { boot, sendTurn, makeMsg, PLATFORM, CONTAINER };
