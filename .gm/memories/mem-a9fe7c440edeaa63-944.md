---
key: mem-a9fe7c440edeaa63-944
ns: default
created: 1782161542384
updated: 1782161542384
---

casey QUALITY-PASS-6 (sha 3bb020d, main, 2026-06-22). KEY FIXES: (1) dashboard auth bug: authed() in server.js now accepts req.query.token for the initial page-load GET / (Bearer and X-Casey-Token headers remain the only API auth); client strips ?token= immediately and switches to X-Casey-Token header. (2) README token doc updated to accurately describe page-load-only ?token= behavior. (3) bin/casey.js sim: prints structured report fields after summary. (4) bin/casey.js cases: --channel filter flag, shows external_id + created_at. (5) bin/casey.js doctor: checks thatcher.config.yml presence. (6) AGENTS.md created (merged with remote comprehensive version): architecture contract, security invariants, thatcher shim caveat, ASCII house-style. (7) CHANGELOG.md created with 0.2.0 entry. (8) package.json bumped to 0.2.0. Remote had 4 commits ahead (CI lint gate, ASCII enforcement, stray crash dump removal, AGENTS.md); merged via rebase.
