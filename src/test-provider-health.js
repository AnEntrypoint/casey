#!/usr/bin/env node
// test-provider-health.js -- manual test for provider health observability.
// Run with: node src/test-provider-health.js
//
// Tests:
// 1. Provider health tracker initialization
// 2. Recording success/failure
// 3. Queue depth tracking
// 4. /api/health/provider endpoint

import { ProviderHealthTracker } from './provider-health.js'

const tests = []
let passed = 0, failed = 0

function test(name, fn) {
  tests.push({ name, fn })
}

async function runTests() {
  console.log('Starting provider health tests...\n')

  test('ProviderHealthTracker: initialization', () => {
    const tracker = new ProviderHealthTracker()
    const status = tracker.getStatus()
    if (status.status === 'unknown' && status.queuedTurnCount === 0) {
      console.log('✓ Tracker initializes with unknown status and zero queue')
      return true
    }
    console.log('✗ Tracker initialization failed', status)
    return false
  })

  test('ProviderHealthTracker: recordSuccess', () => {
    const tracker = new ProviderHealthTracker()
    tracker.recordSuccess()
    const status = tracker.getStatus()
    if (status.status === 'up' && status.lastSuccessAt != null) {
      console.log('✓ recordSuccess updates status to up')
      return true
    }
    console.log('✗ recordSuccess failed', status)
    return false
  })

  test('ProviderHealthTracker: recordFailure', () => {
    const tracker = new ProviderHealthTracker()
    tracker.recordFailure('test error')
    const status = tracker.getStatus()
    if (status.lastFailureError === 'test error' && status.lastFailureAt != null) {
      console.log('✓ recordFailure records error and timestamp')
      return true
    }
    console.log('✗ recordFailure failed', status)
    return false
  })

  test('ProviderHealthTracker: updateQueueDepth', () => {
    const tracker = new ProviderHealthTracker()
    tracker.updateQueueDepth(5, 2)
    const status = tracker.getStatus()
    if (status.queuedTurnCount === 5 && status.deadLetteredCount === 2) {
      console.log('✓ updateQueueDepth tracks pending and dead-lettered')
      return true
    }
    console.log('✗ updateQueueDepth failed', status)
    return false
  })

  test('ProviderHealthTracker: updateFromBackend degraded', () => {
    const tracker = new ProviderHealthTracker()
    tracker.updateFromBackend({ ok: true, degraded: true })
    const status = tracker.getStatus()
    if (status.status === 'degraded') {
      console.log('✓ updateFromBackend sets degraded status')
      return true
    }
    console.log('✗ updateFromBackend degraded failed', status)
    return false
  })

  test('ProviderHealthTracker: onRecover callback fires', async () => {
    let recoverCalled = false
    const tracker2 = new ProviderHealthTracker({
      onRecover: () => { recoverCalled = true }
    })
    tracker2.state.status = 'down'
    tracker2.recordSuccess()
    // Give the callback a tick
    await new Promise(r => setImmediate(r))
    if (recoverCalled) {
      console.log('✓ onRecover callback fires on recovery')
      return true
    }
    console.log('✗ onRecover callback not fired')
    return false
  })

  // Run all tests sequentially
  for (const { name, fn } of tests) {
    try {
      const result = await fn()
      if (result) {
        passed++
      } else {
        failed++
      }
    } catch (e) {
      console.log(`✗ ${name}: ${e.message}`)
      failed++
    }
  }

  console.log(`\n\nResults: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch(e => {
  console.error('Test runner error:', e)
  process.exit(1)
})
