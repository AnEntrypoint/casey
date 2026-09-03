// provider-health.js -- track LLM provider status and queue depth.
//
// Exposes provider health: status (up/down/degraded), timestamps of last
// successful/failed requests, queued turn count, and auto-chain position.
// This is the single source of truth for provider observability across the
// dashboard and CLI.

export class ProviderHealthTracker {
  constructor({ onRecover = null } = {}) {
    this.onRecover = onRecover
    this.state = {
      status: 'unknown',           // up, down, degraded, unknown
      lastSuccessAt: null,         // unix ms
      lastFailureAt: null,         // unix ms
      lastFailureError: null,      // error message string, or null
      queuedTurnCount: 0,          // pending re-drives
      deadLetteredCount: 0,        // exhausted retry budget
      currentChainPosition: null,  // which model in fallback chain being tried
      upSince: null,               // unix ms of last transition from down to up
    }
    this._wasDown = false
  }

  // Record a successful provider call. Updates timestamp and clears failure state.
  recordSuccess() {
    const now = Date.now()
    const wasDown = this.state.status === 'down'
    this.state.lastSuccessAt = now
    this.state.lastFailureError = null
    this.state.status = 'up'

    if (wasDown && this.onRecover) {
      this.state.upSince = now
      try { Promise.resolve(this.onRecover()).catch(() => {}) } catch { /* never break */ }
    }
  }

  // Record a failed provider call with error detail.
  recordFailure(error) {
    const now = Date.now()
    this.state.lastFailureAt = now
    this.state.lastFailureError = error ? String(error).slice(0, 500) : 'unknown error'
  }

  // Update provider status based on resilient backend state.
  updateFromBackend(backendStatus) {
    if (!backendStatus) return
    if (backendStatus.ok === false) {
      this.state.status = 'down'
    } else if (backendStatus.degraded === true) {
      this.state.status = 'degraded'
    } else {
      this.state.status = 'up'
      if (!this.state.upSince) this.state.upSince = Date.now()
    }
  }

  // Update queue depth from the LLM-down queue gate.
  updateQueueDepth(pending, deadLettered) {
    this.state.queuedTurnCount = pending || 0
    this.state.deadLetteredCount = deadLettered || 0
  }

  // Update auto-chain position (which model in the fallback chain).
  updateChainPosition(position) {
    this.state.currentChainPosition = position
  }

  // Get current state snapshot for API responses.
  getStatus() {
    return { ...this.state }
  }
}
