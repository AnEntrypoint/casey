# Case Machine Verification Report

## Workflow Graph (from thatcher.config.yml)

```
new
├─ forward: [triaging, in_progress]
├─ backward: []
├─ requires_role: []

triaging
├─ forward: [in_progress, waiting, resolved]
├─ backward: [new]
├─ requires_role: []

in_progress
├─ forward: [waiting, resolved]
├─ backward: [triaging]
├─ requires_role: []

waiting
├─ forward: [in_progress, resolved]
├─ backward: []
├─ requires_role: []

resolved
├─ forward: [closed]
├─ backward: [in_progress]
├─ requires_role: []

closed
├─ forward: []
├─ backward: [resolved]
├─ requires_role: [operator, admin]
```

## State Enumeration

Total states: 6
- new
- triaging
- in_progress
- waiting
- resolved
- closed

## Transition Analysis

### Forward edges (unrestricted):
- new → triaging
- new → in_progress
- triaging → in_progress
- triaging → waiting
- triaging → resolved
- in_progress → waiting
- in_progress → resolved
- waiting → in_progress
- waiting → resolved
- resolved → closed

### Backward edges (role-gated):
- triaging ← new
- in_progress ← triaging
- in_progress ← resolved (requires operator/admin)
- resolved ← closed (requires operator/admin)

## Confluence Checking

Confluence requires: For any two transitions with the same origin or target,
different orderings produce the same final state.

### Test Case: Multiple Report Paths to Resolved

Path 1: new → triaging → resolved
Path 2: new → in_progress → resolved

Both reach resolved from new via different intermediate states.

Question: Can the same case reach "resolved" from different states without path dependency?

- new → triaging → resolved ✓
- new → in_progress → resolved ✓
- new → triaging → in_progress → resolved ✓

All paths reach resolved without issues.

### Diamond Pattern: in_progress

From triaging:
- triaging → in_progress → resolved
- triaging → resolved

Both reachable from triaging. If a case is in in_progress after triaging,
can transition to resolved. If triaging goes direct to resolved, reaches same state.

### Backward Path: Reopen

From closed (requires operator/admin):
- closed → resolved (requires role gate)
- resolved → in_progress (no role gate)
- in_progress → waiting
- waiting → resolved

Then closed → resolved again (requires role gate again)

## Known Issues to Verify

1. **Role Gate Direction**: The comment in case-machine.js (lines 48-66) indicates
   a prior bug where TARGET's requires_role was checked instead of FROM's for
   backward edges. The fix checks FROM's requires_role for backward edges only.

2. **Missing Event Handlers**: Each state should handle exactly these events:
   - Forward events: GO_<target> for each in forward array
   - Backward events: GO_<target> for each in backward array

3. **Unreachable States**: All 6 states should be reachable from 'new' (initial state)
   - new ✓ (initial)
   - triaging ✓ (new → triaging)
   - in_progress ✓ (new → in_progress or new → triaging → in_progress)
   - waiting ✓ (triaging → waiting or in_progress → waiting)
   - resolved ✓ (triaging → resolved or in_progress → resolved or waiting → resolved)
   - closed ✓ (resolved → closed)

4. **Idempotency**: Replaying the same transition sequence must produce the same state.
   Example: new → triaging → triaging (NO) - triaging has no self-loop, so second call fails.

5. **No Implicit Transitions**: The machine only allows explicitly declared edges.
   Example: cannot jump new → waiting (not in forward/backward arrays).

## Implementation Review

### buildCaseMachine (lines 27-40)
- Takes workflow graph object
- Throws if empty (guards against nil graph)
- For each stage, collects backward set for viaBackward marker
- Merges forward and backward targets
- Creates event handlers (GO_<target> → target with viaBackward meta)
- Carries requires_role on state meta

**Status**: Correct. No implicit transitions. Totality check: every state gets an `on` object.

### canTransition (lines 67-86)
- Validates from and to states exist
- Checks edge exists
- For backward edges (viaBackward=true), checks FROM node's requires_role
- Returns explicit error messages

**Status**: Correct per the documented fix. Role gate applies to backward edges only.

### nextStates (lines 93-101)
- Returns list of reachable states from a given state and role
- Filters based on viaBackward + requires_role

**Status**: Correct. Matches canTransition logic exactly.

## Specific Concerns

1. **Totality**: All 6 states defined? YES
2. **Confluence**: Can case reach same final state via different paths? YES
3. **Idempotency**: Same sequence → same state? Need to test
4. **Role gates**: Backward edges checked on FROM, not TO? YES (verified in code)
5. **Unreachable states**: All reachable from initial? YES
6. **Missing handlers**: All states handle all declared edges? YES (buildCaseMachine creates on for each target)

