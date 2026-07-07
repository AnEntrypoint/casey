---
key: mem-c48a9fa8d6c7be9a-989
ns: default
created: 1782917584157
updated: 1782917584157
---

gm-method (witnessed): an anti-dead-end / safety FALLBACK can be a silent NO-OP when its text is byte-identical to a string an upstream guard BLANKS. Here the degraded-turn fallback string equalled the stock-ack shape a 'model parroted the ack' detector strips, so the pipeline blanked the model ack then re-emitted the exact same no-ask line -- a dead-end that passed every test because each unit looked correct in isolation. Catch it by driving the REAL degraded path end-to-end (model returns empty/echo, or throws for an outage) and asserting the reply FORWARDS something (asks the next needed fact) AND is not caught by the same blanking guard (assert !isBlanked(fallback)). Fix by making the fallback do real work (append the next question) which also breaks the identity so it is never re-blanked. Two invariants a fan-out scenario sweep is good at surfacing: a reply must be forward-moving, and no two pipeline stages may share a magic string where one blanks what the other emits.
