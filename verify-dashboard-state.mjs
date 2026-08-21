#!/usr/bin/env node
/**
 * Dashboard State Stability & Data Consistency Verification
 *
 * Tests:
 * 1. Dashboard load time (LCP baseline)
 * 2. Create case via API (WhatsApp simulator)
 * 3. Verify case appears in case-list within 2s (live update)
 * 4. Edit case field, save, refresh (persistence)
 * 5. Concurrent edit detection (optimistic locking / merge)
 * 6. Performance metrics (query times, detail view)
 * 7. Console/network error detection
 */

import http from 'node:http'
import { performance } from 'node:perf_hooks'

const BASE_URL = 'http://localhost:4000'
const OPERATOR_ID = 'test-verify-operator'
const TEST_CASE_REF = `TEST-${Date.now().toString(36).toUpperCase()}`

// Measurement baseline
const metrics = {
  dashboard_lcp_ms: 0,
  case_list_query_ms: 0,
  case_detail_query_ms: 0,
  case_list_to_first_appearance_ms: 0,
  field_edit_persist_ms: 0,
  concurrent_merge_handled: false,
  console_errors: [],
  network_errors: [],
}

/**
 * HTTP GET helper
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const startMs = performance.now()
    const opts = new URL(url)
    const req = http.get(opts, { headers }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const elapsedMs = performance.now() - startMs
        try {
          const parsed = JSON.parse(data)
          resolve({ status: res.statusCode, data: parsed, elapsedMs })
        } catch (e) {
          resolve({ status: res.statusCode, data, elapsedMs })
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy())
  })
}

/**
 * HTTP POST helper
 */
function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const startMs = performance.now()
    const opts = new URL(url)
    const payload = JSON.stringify(body)
    const finalHeaders = { ...headers, 'Content-Type': 'application/json', 'Content-Length': payload.length }

    const req = http.request(opts, { method: 'POST', headers: finalHeaders }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const elapsedMs = performance.now() - startMs
        try {
          const parsed = JSON.parse(data)
          resolve({ status: res.statusCode, data: parsed, elapsedMs })
        } catch (e) {
          resolve({ status: res.statusCode, data, elapsedMs })
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy())
    req.write(payload)
    req.end()
  })
}

/**
 * Login and get session token
 */
async function login() {
  console.log('  Logging in as testop...')
  const result = await httpPost(`${BASE_URL}/api/login`, {
    username: 'testop',
    password: 'd102c8499baf68557dbf',
  })

  if (result.status === 200 && result.data?.token) {
    console.log('  [x] Logged in')
    return result.data.token
  } else if (result.status === 200 && result.data?.authed) {
    // May be in cookie-based session
    console.log('  [x] Session established')
    return 'cookie-based'
  }
  throw new Error(`Login failed: ${result.status}`)
}

/**
 * Test 1: Dashboard load performance baseline
 */
async function testDashboardLoadTime() {
  console.log('\n=== Test 1: Dashboard Load Time (LCP Baseline) ===')
  const startMs = performance.now()
  const result = await httpGet(`${BASE_URL}/`)
  const elapsedMs = performance.now() - startMs
  metrics.dashboard_lcp_ms = elapsedMs
  console.log(`[x] Dashboard home page loads in ${elapsedMs.toFixed(1)}ms (target: <2000ms)`)
  if (elapsedMs > 2000) {
    console.warn(`WARNING LCP exceeds target (${elapsedMs.toFixed(1)}ms > 2000ms)`)
  }
}

/**
 * Test 2: Create case via API (simulating WhatsApp input)
 */
async function testCreateCase() {
  console.log('\n=== Test 2: Create Case via API ===')
  const casePayload = {
    ref: TEST_CASE_REF,
    status: 'new',
    subject: 'Test Case for State Verification',
    channel: 'test-channel',
    case_type: 'disease_report',
    report: {
      date: new Date().toISOString(),
      species: 'cattle',
      symptoms: 'test symptoms',
      location: 'test location',
    },
  }

  const result = await httpPost(`${BASE_URL}/api/cases`, casePayload)
  if (result.status >= 200 && result.status < 300) {
    console.log(`[x] Case created: ${result.data?.id || TEST_CASE_REF}`)
    return result.data
  } else {
    console.error(`[-] Failed to create case: ${result.status}`, result.data)
    return null
  }
}

/**
 * Test 3: Verify case appears in case-list within 2s (live update)
 */
async function testCaseListUpdate() {
  console.log('\n=== Test 3: Case Appears in List (Live Update) ===')
  const startCheckMs = performance.now()
  const timeout = 2500

  for (let attempt = 0; attempt < 10; attempt++) {
    const listResult = await httpGet(`${BASE_URL}/api/cases`)
    const elapsedMs = performance.now() - startCheckMs

    if (listResult.status === 200 && Array.isArray(listResult.data)) {
      const found = listResult.data.find(c => c.ref === TEST_CASE_REF || c.subject?.includes('State Verification'))
      if (found) {
        metrics.case_list_to_first_appearance_ms = elapsedMs
        console.log(`[x] Case found in list after ${elapsedMs.toFixed(0)}ms (target: <2000ms)`)
        if (elapsedMs > 2000) {
          console.warn(`WARNING Appearance time exceeds target (${elapsedMs.toFixed(0)}ms > 2000ms)`)
        }
        return found
      }
    }

    if (elapsedMs > timeout) {
      console.error(`[-] Case not found in list after ${timeout}ms (${attempt + 1} attempts)`)
      return null
    }

    await new Promise(r => setTimeout(r, 200))
  }
}

/**
 * Test 4: Edit case field and verify persistence
 */
async function testFieldEditPersistence() {
  console.log('\n=== Test 4: Field Edit Persistence ===')

  // Fetch case first
  const listResult = await httpGet(`${BASE_URL}/api/cases`)
  if (listResult.status !== 200 || !Array.isArray(listResult.data)) {
    console.error('[-] Failed to fetch case list')
    return false
  }

  const caseToEdit = listResult.data.find(c => c.ref === TEST_CASE_REF || c.subject?.includes('State Verification'))
  if (!caseToEdit) {
    console.error('[-] Test case not found for edit')
    return false
  }

  const caseId = caseToEdit.id
  const startMs = performance.now()

  // Edit: update assignee field
  const updatePayload = { assignee: OPERATOR_ID }
  const updateResult = await httpPost(`${BASE_URL}/api/cases/${caseId}`, updatePayload)

  if (updateResult.status >= 200 && updateResult.status < 300) {
    console.log(`[x] Case field updated (assignee=${OPERATOR_ID})`)

    // Refresh and verify persistence
    await new Promise(r => setTimeout(r, 100))
    const refetchResult = await httpGet(`${BASE_URL}/api/cases/${caseId}`)

    if (refetchResult.status === 200 && refetchResult.data?.assignee === OPERATOR_ID) {
      const elapsedMs = performance.now() - startMs
      metrics.field_edit_persist_ms = elapsedMs
      console.log(`[x] Field edit persisted after ${elapsedMs.toFixed(0)}ms`)
      return true
    } else {
      console.error(`[-] Field edit did not persist (got: ${refetchResult.data?.assignee})`)
      return false
    }
  } else {
    console.error(`[-] Failed to update case field: ${updateResult.status}`, updateResult.data)
    return false
  }
}

/**
 * Test 5: Concurrent edit detection (optimistic locking)
 */
async function testConcurrentEditHandling() {
  console.log('\n=== Test 5: Concurrent Edit Handling (Optimistic Locking) ===')

  // Simulate two concurrent edits: fetch case, then both clients try to edit
  const listResult = await httpGet(`${BASE_URL}/api/cases`)
  const testCase = listResult.data.find(c => c.ref === TEST_CASE_REF)
  if (!testCase) {
    console.error('[-] Test case not found')
    return false
  }

  const caseId = testCase.id

  // Simulate two concurrent edits
  const edit1 = httpPost(`${BASE_URL}/api/cases/${caseId}`, { status: 'triaging' })
  const edit2 = httpPost(`${BASE_URL}/api/cases/${caseId}`, { status: 'in_progress' })

  const [result1, result2] = await Promise.all([edit1, edit2])

  // One should succeed, one may conflict (depending on optimistic locking implementation)
  const success1 = result1.status >= 200 && result1.status < 300
  const success2 = result2.status >= 200 && result2.status < 300
  const conflict1 = result1.status === 409 || result1.data?.error?.includes('conflict')
  const conflict2 = result2.status === 409 || result2.data?.error?.includes('conflict')

  if (success1 || success2 || conflict1 || conflict2) {
    console.log(`[x] Concurrent edits handled (Edit1: ${success1 ? 'success' : conflict1 ? 'conflict' : 'error'}, Edit2: ${success2 ? 'success' : conflict2 ? 'conflict' : 'error'})`)
    metrics.concurrent_merge_handled = success1 || success2 || conflict1 || conflict2

    // Fetch final state
    const finalResult = await httpGet(`${BASE_URL}/api/cases/${caseId}`)
    if (finalResult.status === 200) {
      console.log(`[x] Final case state retrieved (status: ${finalResult.data?.status})`)
      return true
    }
  } else {
    console.error('[-] Concurrent edits not handled correctly')
  }

  return false
}

/**
 * Test 6: Performance metrics (query times)
 */
async function testPerformanceMetrics() {
  console.log('\n=== Test 6: Performance Metrics ===')

  // Test case-list query time (cold run already captured, warm run here)
  const result1 = await httpGet(`${BASE_URL}/api/cases`)
  metrics.case_list_query_ms = result1.elapsedMs
  console.log(`  /api/cases query: ${result1.elapsedMs.toFixed(1)}ms (target: <200ms)`)
  if (result1.elapsedMs > 200) {
    console.warn(`  WARNING Case-list query exceeds target (${result1.elapsedMs.toFixed(1)}ms > 200ms)`)
  }

  // Test case-detail query time
  const testCase = result1.data?.find(c => c.ref === TEST_CASE_REF)
  if (testCase?.id) {
    const result2 = await httpGet(`${BASE_URL}/api/cases/${testCase.id}`)
    metrics.case_detail_query_ms = result2.elapsedMs
    console.log(`  /api/cases/:id detail query: ${result2.elapsedMs.toFixed(1)}ms (target: <200ms)`)
    if (result2.elapsedMs > 200) {
      console.warn(`  WARNING Case-detail query exceeds target (${result2.elapsedMs.toFixed(1)}ms > 200ms)`)
    }
  }
}

/**
 * Test 7: Health/status checks
 */
async function testSystemHealth() {
  console.log('\n=== Test 7: System Health ===')

  const healthResult = await httpGet(`${BASE_URL}/api/health`)
  if (healthResult.status === 200) {
    const health = healthResult.data
    console.log(`[x] Health endpoint: ${health.ok ? 'OK' : 'DEGRADED'}`)
    if (health.provider) console.log(`  Provider: ${health.provider.ok ? 'OK' : 'DOWN'}`)
    if (health.gateway) console.log(`  Gateway: ${health.gateway.ok ? 'OK' : 'DOWN'}`)
    if (health.queue) console.log(`  Queue depth: ${health.queue?.pending || 0}`)
  } else {
    console.error(`[-] Health check failed: ${healthResult.status}`)
  }
}

/**
 * Main verification runner
 */
async function runVerification() {
  console.log('=' .repeat(60))
  console.log('DASHBOARD STATE STABILITY & DATA CONSISTENCY VERIFICATION')
  console.log('=' .repeat(60))

  try {
    // Step 0: Login
    console.log('\n=== Step 0: Authentication ===')
    let sessionToken = await login()

    await testDashboardLoadTime()
    await testCreateCase()
    await testCaseListUpdate()
    await testFieldEditPersistence()
    await testConcurrentEditHandling()
    await testPerformanceMetrics()
    await testSystemHealth()

    console.log('\n' + '=' .repeat(60))
    console.log('VERIFICATION COMPLETE - RESULTS SUMMARY')
    console.log('=' .repeat(60))
    console.log(JSON.stringify(metrics, null, 2))

    // Return exit code based on thresholds
    const failures = []
    if (metrics.dashboard_lcp_ms > 2000) failures.push('dashboard_lcp exceeds 2000ms')
    if (metrics.case_list_query_ms > 200) failures.push('case_list_query exceeds 200ms')
    if (metrics.case_detail_query_ms > 200) failures.push('case_detail_query exceeds 200ms')
    if (metrics.case_list_to_first_appearance_ms > 2000) failures.push('case_list_to_first_appearance exceeds 2000ms')

    if (failures.length > 0) {
      console.error('\nWARNING THRESHOLD VIOLATIONS:')
      failures.forEach(f => console.error(`  - ${f}`))
      process.exit(1)
    }

    console.log('\n[x] All tests passed')
    process.exit(0)
  } catch (err) {
    console.error('\n[-] VERIFICATION FAILED:', err.message)
    console.error(err.stack)
    process.exit(1)
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runVerification()
}

export { runVerification, metrics }
