---
key: mem-47bf6e47f4fbdfbb-1351
ns: default
created: 1783072853296
updated: 1783072853296
---

gm-method (witnessed): a dedicated purpose-built skill/workflow already existing for a request (a 'maximize quality' skill matching a user's 'find everything to improve, then implement it' ask) should be invoked directly rather than hand-rolling an equivalent ad-hoc Workflow -- check the available-skills list FIRST before authoring a fresh multi-agent script; the purpose-built skill already encodes the right map->audit->adversarial-verify->synthesize shape and often costs less to invoke than to redesign. Also witnessed: CONSOLIDATE's CI-check marker requires a `head_sha` key (the full 40-char sha), not just a short `commit` field -- a marker written with only `commit` gate-denies the COMPLETE transition even when CI is genuinely green, so always include the full `git rev-parse HEAD` output under `head_sha` when hand-writing this marker. Also witnessed (a repeat of an earlier lesson, worth reinforcing): a witness script reusing a fixed msg_id/external_id pattern across repeated runs against the SAME on-disk dev database will trigger real, correct dedup logic from a PRIOR run's leftover data, which looks exactly like a new bug (mass 'duplicate inbound dropped') but is actually stale test fixtures -- tag every witness run's ids with a fresh per-invocation value (timestamp/hrtime) to guarantee no collision with a previous run's data.
