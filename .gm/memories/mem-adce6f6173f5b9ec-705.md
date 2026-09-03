---
key: mem-adce6f6173f5b9ec-705
ns: default
created: 1787322968917
updated: 1787322968917
---

## Resolved mutable: mut-commitgate-pii-live-grep

grep -n external_id|contact_id across src/dashboard/routes/*.js: 34 hits, manually reviewed each. cases.js/reports.js/operations.js/map.js hits are comments or internal query use; contacts.js:13 external_id_formatted is a formatted-phone projection gated by authed() for the internal operator triage panel (not worker-facing); map.js:146 contact_id:c.id is thatcher's internal row id per commit 70bf2c0's explicit rationale ("contact_id is internal database ID (not PII, used for map worker assignment)"). Corroborates scripts/lint.mjs's pii-safety gate (lines 233-260) which scans for raw {...c} spread bypass patterns and independently reported clean.
