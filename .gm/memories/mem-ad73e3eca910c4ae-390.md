---
key: mem-ad73e3eca910c4ae-390
ns: default
created: 1782678149541
updated: 1782678149541
---

## Resolved mutable: three-fields-not-extractable

Confirmed: how_to_find/farmer_available/contact_fallback have no extractor in extract.js, so reportMissingVisitCritical stays true for a content-only model. Addressed by the gate guard (next || justCaptured.length) in 3e5e018 so the gate no longer parrots the holding-ack when intake is exhausted. case-health.js:41; gateway-hooks.js gate.
