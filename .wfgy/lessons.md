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

## 2026-07-07 -- third ruthless-optimize round: goal fork resolved to all-three
Goal (G): after two prior same-day ruthless-optimize passes (worker-fact
discarding fix, media-bytes + honest-presentation fix), a THIRD undirected
"ruthlessly optimize our goal" prompt arrived with the same no-concrete-target
shape.
What drifted / what went wrong: nothing yet -- caught before drift. PLAN-orient
recall confirmed the two prior rounds already covered capture-completeness and
honest-presentation; a third blind multi-repo audit risked either duplicating
those findings or manufacturing marginal churn to justify the dispatch.
Fix / resolution: applied the G-anchor discipline pre-emptively -- asked the
user which concrete axis this round targets (operator triage speed,
conversation robustness, cross-repo architecture debt, or something else)
instead of guessing. Answer: all three, explicitly, in one pass.
Generalizes to: a same-session repeat of an undirected "optimize the goal"
prompt is a strong signal the user has a NEW concrete target in mind each time,
not a request to re-run the same audit shape -- always ask which axis before
the 3rd+ occurrence, even if the first occurrence's answer felt obvious.

## 2026-07-07 -- third ruthless-optimize round: all-three-axes fixes landed
Goal (G): confirmed via user goal-fork answer -- optimize operator triage speed,
conversation robustness, AND cross-repo architecture debt in one pass across
casey/freddie/thatcher.
What drifted / what went wrong: nothing structural -- three parallel gm-driving
audit subagents (one per axis) returned 12 confirmed findings with zero overlap.
One near-miss during VERIFY: a synthetic test string for the Sesotho/Setswana
tie-break accidentally included a real Setswana-distinctive marker ("a lwala"),
making an intended "ambiguous tie" test case actually resolve correctly to 'tn'
-- initially read as a bug before re-deriving the per-language cue-hit counts by
hand and confirming the code was right and the test string was wrong.
Fix / resolution: applied all 12 fixes with real-execution live witnesses (no
test files, per this project's standing no-synthetic-tests rule) against the
actual live database (data/app.db) wherever a store-level change was involved --
including a full end-to-end replication of the new bulk draft-release logic
against real seeded cases (approve success, discard success, no-pending-draft,
and failed-send-leaves-tag-intact, all 4 confirmed). Deleted ~110 lines of
confirmed-dead code (_thatcherSupportsOperators probe + JS-side operator/sort/
row-access fallback + orphaned opPredicate/orPredicate/recencyKey/_rowAccessField)
once thatcher's installed version (1.0.37) was confirmed 7 releases past when
operator-where landed (1.0.30) -- casey's own npm 'latest' dependency policy
means this can never regress. Corrected 3 AGENTS.md passages whose "non-colliding
toolset" framing implied an active design decision when the real state (freddie's
src/plugins/case/ has no plugin.js, is outside freddie's own discovery root, and
is never loaded) was simply unwired reference code. Closed 11 synthetic test
cases created during live-witnessing (status:closed, test-artifact-cleanup tag)
since CaseStore has no delete API by design (append-only).
Generalizes to: (1) when a live-witness test string accidentally satisfies a
DIFFERENT code path than intended, re-derive the actual per-branch scoring by
hand before concluding the code is wrong -- the test's premise can be the bug.
(2) A subagent's audit finding citing "Portuguese" or another language not
actually promised anywhere in the target codebase's own system prompt is a cue
to verify the finding's scope against the codebase's real stated commitments
before implementing past what was asked (Portuguese was dropped from the
lang-cues fix for exactly this reason -- only Sesotho/Setswana were actually
promised). (3) A dependency's "never pinned, always latest" policy recorded in
AGENTS.md should be preserved even when fixing a shim that depended on version
uncertainty -- deleting the runtime probe was correct, but adding a package.json
semver floor would have been an unrequested policy reversal.
