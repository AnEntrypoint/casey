# WFGY lessons -- casey

## 2026-07-07 -- ruthless goal-optimize: capture + honest presentation
Goal (G): flawless channel-independent field-worker report capture, and operator
presentation that shows only real/confirmed information (reported symptoms) --
never an inferred cause/diagnosis (suspected_disease) dressed up as fact.
What drifted / what went wrong: the initial user prompt ("ruthlessly optimize our
goal") named no concrete target -- three plausible goals existed (capture
completeness, dropped-turn reduction, operator triage speed) and guessing wrong
would have wasted the whole multi-repo investigation. Mid-task the user also
tightened the goal further (real-facts-only, symptom-not-cause) after the initial
audits were already dispatched -- had to fold that in without re-running the
audits from scratch.
Fix / resolution: asked before investigating (AskUserQuestion) rather than picking
the most obvious-looking target: field-worker capture is a small nice-to-have if
the actual priority is operator triage speed. Confirmed goal = capture + honest
presentation, triage explicitly de-prioritized. Ran 3 parallel Explore audits
(casey dashboard/map, casey+freddie capture pipeline, thatcher CRM ceiling)
before writing any code. Found: media (photos/voice notes) was never actually
downloaded by either WhatsApp or Discord adapters in freddie -- casey only ever
recorded a text note ("farmer sent a photo") with zero bytes behind it, a capture
gap disguised as working. Separately, clusters.js exposed a `disease` field
computed straight from suspected_disease (an unverified worker relay of the
farmer's own guess) with no `symptoms` (real, observed) field surfaced at all --
exactly backwards for the honesty constraint.
When a genuinely bigger design decision came up mid-fix (where do downloaded
media bytes actually get stored -- thatcher has no blob/file column, only JSON-
text), did NOT silently pick a scheme (e.g. base64-inline, which would bloat
sqlite) -- surfaced it to the user as a real BBCR checkpoint. Confirmed: local
disk under <dataDir>/media/<caseId>/, path string recorded in the report field.
Generalizes to: (1) when a task-invoking prompt states a goal in the imperative
but doesn't name a concrete target, ask before doing multi-repo research --
the cost of guessing wrong compounds across every subsequent step. (2) In this
codebase specifically, any field derived from `suspected_disease` (or similarly
hearsay-sourced report fields: recent_movement, farmer_available) must never be
surfaced to an operator under a bare confident-sounding label -- always separate
from and subordinate to the directly-observed `symptoms` field, and qualified
("as reported", "unconfirmed") wherever it is shown. (3) freddie's channel
adapters (plugins/platform-whatsapp, plugins/platform-discord) previously gave
the appearance of full media capture via text notes alone -- when auditing any
"is X actually captured" claim in this codebase, trace the ACTUAL bytes, not just
the observation/log line that says they arrived.
