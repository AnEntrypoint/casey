// store/settings-log.js  --  reading casey's settings singletons back out of the
// append-only event log.
//
// Three operator-tunable settings (thresholds, fleet-health, shift) are
// persisted the same way: one 'system'-channel singleton case per key, and each
// change stamped as an audited `observation` event whose text is
// `<prefix>:<payload>`. Every reader then walks that case's events looking for
// the newest parseable payload. The WRITE half needs the store (findOrCreateCase
// + appendEvent) and stays in case-store.js; the scan is pure and lives here so
// the three readers cannot drift on what counts as a settings observation.

// Every observation event on `events` whose text carries this prefix, in event
// order (oldest -> newest), as { event, payload } pairs. The event is returned
// alongside the payload because a reader may also need the event's own `data`
// blob (getShiftMarker reads `by` off it), which a payload-only return would
// throw away.
//
// `rx` defaults to the permissive `^<prefix>:(.+)$` (dotall, so a payload
// carrying newlines -- a pretty-printed JSON blob -- still matches). A reader
// whose payload has a stricter shape passes its own pattern rather than
// post-filtering, so a malformed row never reaches its parse step at all.
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
