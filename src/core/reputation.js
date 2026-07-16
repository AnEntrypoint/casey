// core/reputation.js -- a per-reporter reputation/quality SIGNAL derived
// from verified-vs-unverified observation history. This is a pure function
// over the raw log (tier 3, like every other aggregate), used to WEIGHT
// review, never to silently discard data -- a low signal is a prompt for a
// human to look closer, never an automatic rejection.

export function computeReputationSignal(observations, observerId) {
  const own = observations.filter(o => o.observerId === observerId)
  if (!own.length) {
    // Cold start: a brand-new reporter has no history yet. This is
    // explicitly NOT a low/bad score -- it renders as "no history", a
    // distinct third state from "low reputation" and "high reputation",
    // so a new reporter is never penalized as if they had a bad track
    // record they simply haven't had the chance to build yet.
    return { observerId, status: 'no_history', totalObservations: 0, verifiedCount: 0, verifiedRatio: null }
  }
  const verifiedCount = own.filter(o => o.verificationTier !== 'unverified').length
  return {
    observerId,
    status: 'has_history',
    totalObservations: own.length,
    verifiedCount,
    verifiedRatio: verifiedCount / own.length,
  }
}
