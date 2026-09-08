// One operator-facing sentence for "this panel could not load".
//
// Every panel used to compose its own, and each composed it out of two
// developer strings: a per-panel fallback label (`e.message || 'geo error'`)
// and a prefix at the render site (`'Hotspots error: ' + error`). An operator
// whose link dropped therefore read "Hotspots error: geo error" -- a developer
// label twice over, in which the two halves do not even agree on the panel's
// name -- or "Hotspots error: Failed to fetch", a browser internal.
//
// The audience is the one AGENTS.md describes: secretarial and AHT staff on a
// metered, intermittent rural link. For them the useful facts are WHAT did not
// load and WHETHER to try again, in that order. The technical detail is kept,
// because a technician looking over a shoulder still needs it, but demoted to
// a parenthetical instead of being the headline.
//
// What this deliberately does NOT do is guess the cause. A failed fetch here
// is usually the link, but it can equally be a 500 from the dashboard's own
// server, and telling someone to check their connection when the server is
// broken sends them to fix the wrong thing. The sentence states only what is
// actually known.
export function panelError(what, e) {
  const detail = String((e && e.message) || '').trim()
  return `Could not load ${what}. Try again in a moment.` + (detail ? ` (${detail})` : '')
}
