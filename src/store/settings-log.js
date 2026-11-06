
export function taggedObservations(events, prefix, rx = new RegExp(`^${prefix}:(.+)$`, 's')) {
  const out = []
  for (const ev of events || []) {
    if (ev.kind !== 'observation' || typeof ev.text !== 'string') continue
    const m = ev.text.match(rx)
    if (!m) continue
    out.push({ event: ev, payload: m[1] })
  }
  return out
}
