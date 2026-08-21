# Turn Degradation Observability Test Plan

## Overview

This document describes manual testing procedures for the turn degradation observability implementation. The system now records detailed degraded_turn events when turns fail due to:
- Provider unreachable (acptoapi down/error)
- Turn timeout (exceeded TURN_HARD_DEADLINE_MS)
- Retry exhausted (all attempts failed)
- LLM refusal (model explicitly refused to respond)

## Test Scenarios

### 1. Provider Offline (provider reason)

**Setup:**
1. Start casey: `npm run up` or `node bin/casey.js up`
2. Set invalid LLM model: `export CASEY_LLM_MODEL=invalid/nonexistent`
3. Or mock the callLLM to return null

**Test:**
1. Send a message via test contact (Discord/WhatsApp simulator or direct test)
2. Verify:
   - Turn fails and returns fallback text ("having trouble" or "still working")
   - Event log contains `kind: 'degraded_turn'` with `reason: 'provider'`
   - GET `/api/turns/degraded` returns the failure record
   - Dashboard `/api/health` shows degradation_rate > 0

**Expected:**
```json
{
  "kind": "degraded_turn",
  "actor": "system",
  "text": "Turn degraded: provider",
  "data": {
    "contact_id": "...",
    "reason": "provider",
    "turn_ts": 1787307766928,
    "recovery_ts": null
  }
}
```

### 2. Timeout (timeout reason)

**Setup:**
1. Mock callLLM to hang indefinitely (return Promise that never settles)
2. Ensure TURN_HARD_DEADLINE_MS is reasonable (default 120s, consider env override)

**Test:**
1. Send a message
2. Wait for TURN_HARD_DEADLINE_MS to elapse
3. Verify:
   - Turn exits with fallback text (should be "having trouble" since it elapsed past soft deadline)
   - Event contains `reason: 'timeout'`
   - Contact receives guaranteed-response fallback message
   - GET `/api/turns/degraded` shows the failure

**Expected:**
```json
{
  "reason": "timeout",
  "turn_ts": 1787307766928,
  "recovery_ts": null
}
```

### 3. Retry Exhausted (retry-exhausted reason)

**Setup:**
1. Mock callLLM to fail on every attempt (return error, not hang)
2. System will retry up to MAX_TOOL_CHOICE_ATTEMPTS (3)

**Test:**
1. Send a message
2. Verify:
   - All 3 attempts fail
   - Turn gives up, sends fallback text
   - Event contains `reason: 'retry-exhausted'` or more specific provider/timeout reason
   - GET `/api/turns/degraded` shows the record

### 4. Recovery Tracking

**Setup:**
1. Record a degraded_turn as above (provider down)
2. Restore provider/fix LLM connection
3. Send another message from same contact

**Test:**
1. Verify next turn succeeds (real response, not fallback)
2. Check if recovery_ts can be inferred from next successful turn
3. Dashboard shows the earlier failure but acknowledges recovery

### 5. Health Pill Conservative Pattern

**Setup:**
1. Send 1 message -> degraded
2. Send 1 message -> success

**Test:**
1. Verify health pill does NOT flip to red on single failure
2. GET `/api/health` shows degraded: false (conservative, needs sustained pattern)
3. Requires degradationMinCount >= 3 for contact_degradation breach

**Test with sustained failures:**
1. Send 3+ degraded messages
2. Verify contact_degradation breach triggers
3. Health pill may show degraded state after threshold crossed

### 6. Dashboard Metrics

**Setup:**
Complete multiple scenarios above

**Test:**
1. GET `/api/turns/degraded` returns:
   - `turns[]` with contact_id, reason, count, last_at
   - `summary.total` = count of all degraded turns
   - `summary.failures_in_last_hour` = count in 1h window
   - `summary.by_reason` = { provider: N, timeout: M, ... }
2. GET `/api/health` includes:
   - `degradation_rate` = (degraded / total) * 100
   - Shows "AI helper: slow" (amber) if degraded but reachable
   - Shows "AI helper: offline" (red) if provider down
3. Dashboard health widget:
   - Displays degradation rate
   - Red alert if rate > 10% (configurable)
   - Drills down to `/api/turns/degraded` on click

## Verification Checklist

- [ ] Event schema: thatcher.config.yml includes degraded_turn kind
- [ ] Handler instrumentation: degraded_turn events recorded on failure paths
- [ ] Reason classification: provider/timeout/retry-exhausted correctly set
- [ ] /api/turns/degraded endpoint: returns last 24h failures by default
- [ ] Pagination: handles limit & since query params
- [ ] Degradation rate: (degraded_count / total_count) * 100 calculated correctly
- [ ] Health pill: conservative (≥3 failures to breach)
- [ ] Dashboard integration: /api/health includes degradation_rate
- [ ] No PII leakage: contact_id only, never phone/external_id in metrics
- [ ] No contact name in aggregates (contact_id is internal key only)

## Manual Test Commands

```bash
# Start casey with test config
npm run up

# Check health including degradation rate
curl -s http://localhost:4000/api/health | jq .degradation_rate

# Get recent degraded turns
curl -s http://localhost:4000/api/turns/degraded | jq .turns

# Get summary
curl -s http://localhost:4000/api/turns/degraded | jq .summary

# Query with since filter (last 10 minutes)
curl -s "http://localhost:4000/api/turns/degraded?since=$(($(date +%s%N)/1000000 - 600000))" | jq .

# Check case event timeline (use real case_id)
curl -s http://localhost:4000/api/cases/{case_id}/events | jq '.[] | select(.kind == "degraded_turn")'
```

## Notes

- Degraded_turn events are append-only; recovery is inferred from next successful turn
- Conservative health pill: single failure won't trip a breach (avoids flaky alerts)
- Timeout reason detection is based on remaining time and elapsed duration
- Provider reason classification looks for provider error messages in exceptions
- All metrics are contact-level aggregates (no case-specific drill-down except via timeline)
