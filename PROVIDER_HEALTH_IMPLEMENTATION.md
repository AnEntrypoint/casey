# Provider Health Observability Implementation

## Overview
Added comprehensive LLM provider health tracking to casey, enabling real-time monitoring of provider status, request timestamps, queue depth, and auto-chain position through a new `/api/health/provider` dashboard endpoint.

## Changes Made

### 1. New Provider Health Tracker (`src/provider-health.js`)
- **ProviderHealthTracker class**: Tracks detailed provider health state
  - `status`: up/down/degraded/unknown
  - `lastSuccessAt`: unix ms of last successful request
  - `lastFailureAt`: unix ms of last failed request
  - `lastFailureError`: error message from last failure
  - `queuedTurnCount`: pending message count in LLM-down queue
  - `deadLetteredCount`: exhausted retry count
  - `currentChainPosition`: which model in fallback chain
  - `upSince`: unix ms of last recovery
- Methods:
  - `recordSuccess()`: Mark successful call, trigger recovery callback
  - `recordFailure(error)`: Record failed call with error detail
  - `updateFromBackend(status)`: Update from resilient backend state
  - `updateQueueDepth(pending, deadLettered)`: Track queue depth
  - `updateChainPosition(position)`: Track fallback chain position
  - `getStatus()`: Get current state snapshot

### 2. Casey Integration (`src/casey.js`)
- Added `ProviderHealthTracker` import
- Initialize tracker in constructor with onRecover callback
- Added methods:
  - `_enhancedLlmStatus()`: Wrap base llmStatus with tracker data
  - `recordLlmSuccess()`: Record successful call
  - `recordLlmFailure(error)`: Record failed call
  - `updateProviderHealth(backendStatus)`: Update from backend
  - `llmStatus()`: Public API for enhanced status
- Tracker fires `drainQueuedTurns()` on recovery edge

### 3. Dashboard Endpoint (`src/dashboard/routes/operations.js`)
- New `GET /api/health/provider` endpoint (requires auth)
- Returns detailed provider status:
  ```json
  {
    "status": "up|down|degraded|unknown",
    "last_success_at": 1787307788000,
    "last_failure_at": null,
    "last_failure_error": null,
    "queued_turn_count": 0,
    "dead_lettered_count": 0,
    "current_chain_position": "claude-3-sonnet",
    "up_since": 1787307788000
  }
  ```
- Fallback to source-based status if tracker unavailable
- All external strings bounded (max 500/100 chars)

### 4. Worker Integration (`bin/worker.js`)
- Changed `llmStatus` from `brain.status` to `() => casey.llmStatus()`
- Dashboard now receives enhanced status with tracker data

### 5. Test Suite (`src/test-provider-health.js`)
- Unit tests for tracker initialization
- Tests for recordSuccess/recordFailure
- Tests for queue depth tracking
- Tests for backend integration
- Tests for recovery callback

## How It Works

### Provider Down/Recovery
1. Handler detects LLM backend is down via `llmStatus()` check
2. Messages are queued in database with `QUEUED-FOR-AGENT` marker
3. Tracker state updates to `status: 'down'`
4. On recovery (detected by `brain.status()`):
   - Tracker fires `onRecover()` callback
   - Triggers `drainQueuedTurns()` to process queued messages
   - Drains in order (oldest first) until backend degrades again
5. Dashboard shows recovery in real-time

### Queue Visibility
1. `queueStatus()` method scans cases for queue markers
2. Counts `QUEUED-FOR-AGENT` (pending) and `queue-drive-failed` (dead-lettered)
3. `/api/health` endpoint shows queue depth (already implemented)
4. `/api/health/provider` shows detailed queue breakdown

### Health States
- **up**: Backend responding normally, recent turns fast
- **degraded**: Backend slow or recent turns timing out (still responding)
- **down**: Backend unreachable, messages queued
- **unknown**: Status never checked or backend discovery failed

## Testing

### Manual Tests
1. Start casey: `npm start` or `casey up`
2. Check provider status:
   ```bash
   curl -H "Authorization: Bearer ..." http://localhost:4000/api/health/provider
   ```
3. Simulate provider down by stopping acptoapi/LLM
4. Send a message - should be queued (dashboard shows queue count)
5. Restart provider
6. Watch `drainQueuedTurns()` in logs
7. Check `/api/health/provider` shows recovery timestamp

### Test Script
```bash
node src/test-provider-health.js
```

## API Response Examples

### Provider Up
```json
{
  "status": "up",
  "last_success_at": 1787307900000,
  "last_failure_at": 1787307800000,
  "last_failure_error": null,
  "queued_turn_count": 0,
  "dead_lettered_count": 0,
  "current_chain_position": "claude-3-sonnet",
  "up_since": 1787307900000
}
```

### Provider Down (Recovering)
```json
{
  "status": "down",
  "last_success_at": 1787307800000,
  "last_failure_at": 1787307900000,
  "last_failure_error": "connection timeout",
  "queued_turn_count": 5,
  "dead_lettered_count": 0,
  "current_chain_position": null,
  "up_since": null
}
```

### Provider Degraded
```json
{
  "status": "degraded",
  "last_success_at": 1787307900000,
  "last_failure_at": 1787307800000,
  "last_failure_error": null,
  "queued_turn_count": 0,
  "dead_lettered_count": 0,
  "current_chain_position": "claude-3-opus",
  "up_since": 1787307888000
}
```

## Integration Points

### Existing Infrastructure Used
1. **llm.js**: `makeResilientCallLLM()` provides `status()` probe
2. **casey.js**: `drainQueuedTurns()` processes queued turns on recovery
3. **hooks/handler.js**: `queueStatus()` scans for queue markers
4. **dashboard/routes/operations.js**: `/api/health` already shows queue depth

### No Breaking Changes
- All changes are additive (new tracker, new endpoint)
- Falls back gracefully if tracker unavailable
- Existing `/api/health` endpoint still works
- Existing queue functionality unchanged

## Dashboard Display (Future)
The endpoint data enables dashboard pills/indicators:
- **Provider Status Light**: Green/Yellow/Red based on `status`
- **Queue Badge**: Pending count from `queued_turn_count`
- **Recovery Timestamp**: `up_since` shows when provider came back
- **Last Error**: `last_failure_error` shown on hover/detail
- **Chain Position**: Current model in fallback chain

## Monitoring & Alerting
The `/api/health/provider` endpoint can be:
1. Polled by monitoring systems (Prometheus, Datadog, etc.)
2. Integrated into alerting rules (queue growing, provider down >5min)
3. Used for SLA dashboards (show provider uptime metrics)
4. Exposed to on-call rotations (page if queue grows unbounded)

## Design Principles
- **Observability First**: Every action (queue/drain/recover) is visible
- **No Silent Failures**: Queue status always queryable, degradation visible
- **Fail-Safe Defaults**: Graceful degradation if tracker unavailable
- **PII-Free**: No contact/case data in health endpoints
- **Bounded Responses**: All strings bounded to prevent injection/abuse
