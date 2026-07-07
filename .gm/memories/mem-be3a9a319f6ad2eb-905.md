---
key: mem-be3a9a319f6ad2eb-905
ns: default
created: 1782462620259
updated: 1782462620259
---

A dashboard "focus/inbox mode" pattern: a single client-side flag (read from a URL hash token, e.g. #inbox) gates an expensive top-of-screen render. When on, a body-level CSS class hides the heavy full list/filters/bulk chrome and the ranked-attention list renders ALL rows instead of a capped peek; boot() skips the heavy initial full-list fetch; the expensive fast setInterval poll is wrapped `if(!mode) load()` so it is suppressed while the cheap poll keeps running. Toggling re-syncs the hash (preserving any co-existing deep-link token), reapplies the body class, re-renders, and lazily fetches the list it skipped only when leaving the mode. Witness the round-trip live via a window.* global: page.evaluate setMode(true) -> body class + hash + chrome hidden + list visible all true; setMode(false) -> full restore. Lesson: gate cost with one flag + a body class + a hash, never fork the render path.
