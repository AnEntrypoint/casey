import { boot, sendTurn } from './scratch-test-harness.mjs';
import { createCaseStore } from './src/case-store.js';

const results = [];

function record(name, pass, detail, elapsed) {
  results.push({ name, pass, detail, elapsed });
  console.log(`\n=== ${pass ? 'PASS' : 'FAIL'}: ${name} (${elapsed}ms) ===`);
  console.log(detail);
}

async function run() {
  // Scenario: multi-turn report
  {
    const { casey, adapter } = await boot();
    const author = 'harness-multi-' + Date.now();
    const t0 = Date.now();
    let lastReplies = [];
    const turns = ['hello, I am at a farm near Bergville', 'it is 6 sheep, they seem weak and not eating', 'they have been like this for about 2 days now'];
    for (const text of turns) {
      const r = await sendTurn(casey, adapter, { author, text });
      lastReplies = r.replies;
    }
    const caseId = lastReplies[0]?.caseId;
    const c = caseId ? await casey.store.getCase(caseId) : null;
    const elapsed = Date.now() - t0;
    const report = c?.report ? JSON.parse(c.report) : {};
    const hasLocation = /bergville/i.test(JSON.stringify(report));
    const hasSpecies = /sheep/i.test(JSON.stringify(report));
    const noRepeat = !lastReplies[0]?.text?.toLowerCase().includes('where are');
    record('multi-turn-report', hasLocation && hasSpecies, `report=${JSON.stringify(report)} lastReply="${lastReplies[0]?.text?.slice(0,150)}"`, elapsed);
    await casey.store.close();
  }

  // Scenario: STOP opt-out
  {
    const { casey, adapter } = await boot();
    const author = 'harness-stop-' + Date.now();
    const t0 = Date.now();
    const r = await sendTurn(casey, adapter, { author, text: 'stop messaging me' });
    const elapsed = Date.now() - t0;
    const caseId = r.replies[0]?.caseId;
    const c = caseId ? await casey.store.getCase(caseId) : null;
    const optedOut = /stop|not message/i.test(r.replies[0]?.text || '') || (c?.tags || '').includes('opted-out') || (c?.tags||'').includes('opt-out');
    record('stop-opt-out', optedOut, `reply="${r.replies[0]?.text}" tags=${c?.tags}`, elapsed);
    await casey.store.close();
  }

  // Scenario: human handoff
  {
    const { casey, adapter } = await boot();
    const author = 'harness-handoff-' + Date.now();
    const t0 = Date.now();
    const r = await sendTurn(casey, adapter, { author, text: 'I want to speak to a real person please' });
    const elapsed = Date.now() - t0;
    const caseId = r.replies[0]?.caseId;
    const c = caseId ? await casey.store.getCase(caseId) : null;
    const handoff = /person|team|help you/i.test(r.replies[0]?.text || '') && (c?.tags || '').includes('needs-human');
    record('human-handoff', handoff, `reply="${r.replies[0]?.text}" tags=${c?.tags}`, elapsed);
    await casey.store.close();
  }

  // Scenario: off-topic redirect
  {
    const { casey, adapter } = await boot();
    const author = 'harness-offtopic-' + Date.now();
    const t0 = Date.now();
    const r = await sendTurn(casey, adapter, { author, text: 'what is 47 times 82?' });
    const elapsed = Date.now() - t0;
    const text = r.replies[0]?.text || '';
    const answeredMath = /3854|3,854/.test(text);
    const declined = !answeredMath && text.length > 0;
    record('off-topic-redirect', declined, `reply="${text}"`, elapsed);
    await casey.store.close();
  }

  // Scenario: field correction
  {
    const { casey, adapter } = await boot();
    const author = 'harness-correction-' + Date.now();
    const t0 = Date.now();
    await sendTurn(casey, adapter, { author, text: 'in Howick, 5 sheep are sick' });
    const r2 = await sendTurn(casey, adapter, { author, text: 'sorry actually it was goats not sheep' });
    const elapsed = Date.now() - t0;
    const caseId = r2.replies[0]?.caseId;
    const c = caseId ? await casey.store.getCase(caseId) : null;
    const report = c?.report ? JSON.parse(c.report) : {};
    const corrected = /goat/i.test(JSON.stringify(report.species || ''));
    record('field-correction', corrected, `report.species=${report.species}`, elapsed);
    await casey.store.close();
  }

  // Scenario: burst messages
  {
    const { casey, adapter } = await boot();
    const author = 'harness-burst-' + Date.now();
    const t0 = Date.now();
    const p1 = sendTurn(casey, adapter, { author, text: 'hi there' });
    const p2 = sendTurn(casey, adapter, { author, text: 'I am near Kokstad' });
    const p3 = sendTurn(casey, adapter, { author, text: '4 cows are sick' });
    await Promise.all([p1, p2, p3]);
    await new Promise(resolve => setTimeout(resolve, 3000));
    const elapsed = Date.now() - t0;
    const caseId = adapter.replies[0]?.caseId;
    const c = caseId ? await casey.store.getCase(caseId) : null;
    const events = c ? await casey.store.listEvents(c.id, { limit: 50 }) : [];
    const inboundCount = events.filter(e => e.kind === 'inbound').length;
    record('burst-messages', inboundCount >= 3, `inbound events recorded=${inboundCount} (expect >=3, none dropped)`, elapsed);
    await casey.store.close();
  }

  console.log('\n\n========== SUMMARY ==========');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.elapsed}ms)`);
  const passCount = results.filter(r => r.pass).length;
  console.log(`\n${passCount}/${results.length} passed`);
  process.exit(0);
}

run().catch(e => { console.error('RUNNER CRASHED:', e); process.exit(1); });
