export const ROUTER_STATUS_DEFAULT_HEARTBEAT_S = 3600;
export const ROUTER_STATUS_DEFAULT_GRACE_S = 900;

const positiveOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
const nonNegativeOr = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

export function routerStatusWindows(idleHeartbeatS, graceS) {
  const heartbeat = positiveOr(idleHeartbeatS, ROUTER_STATUS_DEFAULT_HEARTBEAT_S);
  const grace = nonNegativeOr(graceS, ROUTER_STATUS_DEFAULT_GRACE_S);
  const onlineMaxS = heartbeat + grace;
  return { onlineMaxS, offlineAtS: 2 * onlineMaxS };
}

export function routerLiveness(lastSeenMs, nowMs, idleHeartbeatS, graceS) {
  if (!Number.isFinite(lastSeenMs)) return 'never';
  const ageS = Math.max(0, (nowMs - lastSeenMs) / 1000);
  const { onlineMaxS, offlineAtS } = routerStatusWindows(idleHeartbeatS, graceS);
  if (ageS <= onlineMaxS) return 'online';
  if (ageS < offlineAtS) return 'quiet';
  return 'offline';
}
