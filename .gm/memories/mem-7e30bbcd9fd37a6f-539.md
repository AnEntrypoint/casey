---
key: mem-7e30bbcd9fd37a6f-539
ns: default
created: 1782477453867
updated: 1782477453867
---

## Resolved mutable: greeting-triggers-caseack

CONFIRMED design bug. gateway-hooks.js:1076 reportMissingVisitCritical(empty report)==true, so the precedence gate (was :804, now :859) forced captureDrivenReply -> fallbackReply (FALLBACK_REPLY) for a bare 'hi'; empty-text branch (now :820) did the same. FIX landed: both gates now guarded by `&& !isContentFreeTurn(justCaptured, fresh.report)` (:820 if-branch, :859 gate), so a content-free turn takes warmConversationalReply (:406) instead. node --check src/gateway-hooks.js -> SYNTAX_OK.
