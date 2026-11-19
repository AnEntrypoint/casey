import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routerLiveness, routerStatusWindows } from '../src/dashboard/public/src/router-status.js'
import { liveness } from '../src/portal/portal-store.js'

const HEARTBEAT_S = 3600
const GRACE_S = 900
const MINUTE_MS = 60 * 1000
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const seenAgo = (minutes) => NOW - minutes * MINUTE_MS

test('windows: online to 75 min, offline from 150 min (two heartbeats of 60 + 15 min grace)', () => {
  assert.deepEqual(routerStatusWindows(HEARTBEAT_S, GRACE_S), { onlineMaxS: 4500, offlineAtS: 9000 })
})

test('boundaries at 74, 75, 149, 150 and 151 minutes', () => {
  assert.equal(routerLiveness(seenAgo(74), NOW, HEARTBEAT_S, GRACE_S), 'online')
  assert.equal(routerLiveness(seenAgo(75), NOW, HEARTBEAT_S, GRACE_S), 'online')
  assert.equal(routerLiveness(seenAgo(149), NOW, HEARTBEAT_S, GRACE_S), 'quiet')
  assert.equal(routerLiveness(seenAgo(150), NOW, HEARTBEAT_S, GRACE_S), 'offline')
  assert.equal(routerLiveness(seenAgo(151), NOW, HEARTBEAT_S, GRACE_S), 'offline')
})

test('a router with no report is never connected, and a future timestamp is online', () => {
  assert.equal(routerLiveness(NaN, NOW, HEARTBEAT_S, GRACE_S), 'never')
  assert.equal(routerLiveness(NOW + MINUTE_MS, NOW, HEARTBEAT_S, GRACE_S), 'online')
})

test('the grace comes from config: grace 0 moves every boundary back', () => {
  assert.equal(routerLiveness(seenAgo(61), NOW, HEARTBEAT_S, 0), 'quiet')
  assert.equal(routerLiveness(seenAgo(121), NOW, HEARTBEAT_S, 0), 'offline')
})

test('a missing heartbeat or grace falls back to the defaults, not to a zero window', () => {
  assert.deepEqual(routerStatusWindows(undefined, undefined), { onlineMaxS: 4500, offlineAtS: 9000 })
  assert.deepEqual(routerStatusWindows(0, -5), { onlineMaxS: 4500, offlineAtS: 9000 })
})

test('server liveness and client routerLiveness agree at every minute from 0 to 200', () => {
  for (let minutes = 0; minutes <= 200; minutes += 1) {
    const iso = new Date(seenAgo(minutes)).toISOString()
    assert.equal(liveness(iso, NOW, HEARTBEAT_S, GRACE_S), routerLiveness(seenAgo(minutes), NOW, HEARTBEAT_S, GRACE_S), `minute ${minutes}`)
  }
})
