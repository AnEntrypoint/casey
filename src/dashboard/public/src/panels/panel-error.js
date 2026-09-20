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
// The one exception to "keep the detail verbatim": the header above cites
// "Failed to fetch" as a browser internal an operator should never have been
// shown, and this function was still passing that exact string through into its
// own parenthetical. It is the browser's way of saying the request never left
// the device, which IS a fact worth stating -- in words, once, rather than as
// the engine's own phrasing. Every other message is a real sentence from this
// dashboard's own server and passes through untouched.
const BROWSER_INTERNAL = /^(failed to fetch|networkerror.*|load failed|the operation was aborted.*|signal is aborted.*)$/i;

export function panelError(what, e) {
  const raw = String((e && e.message) || '').trim();
  const detail = BROWSER_INTERNAL.test(raw) ? 'the request never reached the server' : raw;
  return `Could not load ${what}. Try again in a moment.` + (detail ? ` (${detail})` : '');
}
