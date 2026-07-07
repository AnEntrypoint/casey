---
key: mem-c3ddd6ae6c78df89-1246
ns: default
created: 1780928453579
updated: 1780928453579
---

casey low-tech-literacy uplift (commit 96129f5, AnEntrypoint/casey main). WhatsApp input side (src/gateway-hooks.js): caseSystemPrompt rewritten for plain/short/warm/one-question replies that mirror the contact's language, greet+give the reference on first message, reassure on human request, never expose jargon; detectContactIntent/intentReply give deterministic multilingual HELP/STATUS/HUMAN/STOP answers WITHOUT an LLM turn (HUMAN flags needs-human tag + bumps priority; STOP opts out and suppresses later auto-replies via opted-out tag; first-message greeting wins over HELP). Dashboard (src/dashboard/server.js): Aa plain-language mode (STAGE_LABEL/stageLabel, already-applied by a workflow subagent), ? first-run help overlay (casey_help_seen), per-case todoHint 'what to do now'. src/sim/scenarios.js = 6 low-literacy personas, casey sim --scenario <name>; stub-llm.js plain/Spanish/human-aware citing ref. test.js 29 green (+10 scenario asserts). Dashboard client edits browser-witnessed. Built via a Workflow fan-out of 7 design+critique subagents whose concrete code I integrated, applying the critique's conflict fixes (ref in every intentReply, opt-out suppression, first-message precedence, stub regex kept via CURRENT CASE token).
