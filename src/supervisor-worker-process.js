// supervisor-worker-process.js  --  forking the serving worker and reacting to
// the two things it can tell the parent by itself: it came up, and it went away.
//
// Split out of src/supervisor.js. The fork is the supervisor's one irreversible
// effect, and the exit listener is where the restart policy is actually applied
// -- so the policy itself lives next door in supervisor-crash-policy.js and this
// module only performs what that policy returns. The IPC message routing
// (READY/HEALTH/DRAIN_COMPLETE/FATAL) is here too, so the message contract has
// exactly one reader.

import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKER_MSG } from './supervisor-ipc.js'
import { classifyWorkerExit } from './supervisor-crash-policy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WORKER_ENTRY = path.join(__dirname, '..', 'bin', 'worker.js')

// How much of a dying worker's own stderr is kept to explain its exit. Small on
// purpose: this is the last few lines before death, not a log buffer, and it
// ends up inside a crash `reason` string that supervisor-state.js truncates to
// 300 chars for /api/runtime anyway. The byte cap bounds the ONE partial line
// carried between chunks, so a worker printing a single enormous unterminated
// line cannot grow this without limit.
//
// 40 LINES, NOT 12, and the number is measured rather than chosen: Node 24's
// fatal ESM SyntaxError block is 17 lines with a ten-frame stack, so a 12-line
// window kept only frames and the `Node.js vX` banner -- every one of which the
// filter below correctly discards, leaving no cause at all for exactly the crash
// class this exists to explain. A real worker's deeper import chain produces MORE
// frames, not fewer, and the three most useful lines (the file:line, the source
// line, the caret) sit ABOVE the message. 40 keeps the whole block for that shape
// with room to spare, and the extracted cause is still one line.
const STDERR_TAIL_LINES = 40
const STDERR_PARTIAL_LINE_CAP = 8192

// The line that actually names the cause, which is never the literal last line
// of output. Node's fatal-startup shape is: the offending file:line, the source
// line, a caret, the `Error: message`, the `    at ...` frames, and finally a
// bare `Node.js v24.20.0` banner. So the frames and that banner are dropped, and
// an Error/Exception line is preferred over whatever else survives -- taking the
// last remaining line instead reported the Node VERSION as the crash reason
// (witnessed live against a deliberately poisoned worker).
function causeFromStderrTail(lines) {
  const meaningful = lines.filter(l => l.trim() && !/^\s+at\s/.test(l) && !/^Node\.js v/.test(l.trim()))
  const named = meaningful.filter(l => /(?:^|\s)[A-Za-z]*(?:Error|Exception)\b/.test(l))
  const pick = named.length ? named[named.length - 1] : meaningful[meaningful.length - 1]
  return pick ? pick.trim().slice(0, 200) : null
}

// Fold one stderr chunk into a child's kept tail. A chunk boundary falls
// wherever the OS happened to split the write, not on a newline, so the trailing
// fragment is carried on `_stderrRest` and joined to the front of the next chunk
// -- splitting each chunk independently would cut `Error: ...` in half whenever
// a write landed mid-line, and the half that names the cause is the half that
// matters. `flushStderrTail` adds the final unterminated fragment, which is
// exactly where an abruptly-killed worker's last words live.
function absorbStderrChunk(child, text) {
  const parts = ((child._stderrRest || '') + text).split(/\r?\n/)
  child._stderrRest = parts.pop().slice(-STDERR_PARTIAL_LINE_CAP)
  child._stderrTail.push(...parts)
  if (child._stderrTail.length > STDERR_TAIL_LINES) child._stderrTail = child._stderrTail.slice(-STDERR_TAIL_LINES)
}
function flushStderrTail(child) {
  if (child._stderrRest) { child._stderrTail.push(child._stderrRest); child._stderrRest = '' }
  return child._stderrTail
}

export function createWorkerProcess({ log, rt, sup, workerArgs, runtimeEvents, onHealth, restart }) {
  let pendingRestartTimer = null
  function spawn() {
    rt.booted = false
    const child = fork(WORKER_ENTRY, workerArgs, {
      // Inherit env (tokens, CASEY_*). No shell -- fork never interpolates a string,
      // so untrusted data can never reach a shell here (security invariant).
      //
      // stderr is PIPED rather than inherited, and every chunk is written straight
      // through to this process's own stderr below, so the operator-visible output
      // is unchanged. The pipe exists because of what an inherited stderr costs:
      // a worker that dies before its own crash net is installed -- a SyntaxError
      // or a missing export in any module bin/worker.js statically imports, which
      // is what a save landing mid-edit produces -- never reaches
      // `main().catch()` and never sends WORKER_MSG.FATAL, so the exit is
      // recorded as a bare `worker exited code=1 signal=` with the actual cause
      // living only in whatever the parent's stdout happened to be attached to at
      // the time. Thirteen such crashes were audited after the fact with no cause
      // recoverable for twelve of them. Keeping the tail makes the ONE question an
      // operator has -- was that a real bug or a half-written file -- answerable
      // from data/runtime-events.jsonl instead of a lost terminal.
      stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
    })
    rt.worker = child
    child._stderrTail = []
    child._stderrRest = ''
    child.stderr?.on('data', (chunk) => {
      // Pass through FIRST and unmodified: the supervisor is not a log filter,
      // and a worker's stderr must keep reaching wherever it was already going.
      // Wrapped because a write to a closed/broken parent stderr throws, and a
      // supervisor must not die of its own logging while a worker is crashing.
      try { process.stderr.write(chunk) } catch { /* the tail below is the record that matters */ }
      absorbStderrChunk(child, chunk.toString('utf8'))
    })
    child.on('message', (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === WORKER_MSG.READY) handleReady(child, m.payload || {})
      else if (m.type === WORKER_MSG.HEALTH) onHealth(m.payload || {}, Date.now())
      else if (m.type === WORKER_MSG.DRAIN_COMPLETE) restart().completeDrain()
      // The worker's own Cordis HMR declined a source change. Its watch covers
      // the trees this supervisor deliberately stopped watching (freddie's
      // plugin packages, freddie-bundle's plugin sources), so this request is
      // the only thing that keeps such an edit from silently doing nothing.
      // Same entry the fs.watch callback uses, so it coalesces identically.
      else if (m.type === WORKER_MSG.RELOAD_REQUEST) {
        log.info?.('[supervisor] worker asked for a full restart (its in-process hot reload could not apply the change)', { reason: m.payload?.reason })
        restart().requestReload(Date.now())
      }
      else if (m.type === WORKER_MSG.FATAL) {
        log.error?.('[supervisor] worker fatal', { reason: m.payload?.reason })
        // A fatal is treated as a crash on exit below; record the reason now --
        // on THIS CHILD, not on sup.ctx. sup.ctx.lastCrashReason is a display
        // field (/api/runtime, the dashboard pill) that handleExit overwrites on
        // every crash and nothing ever clears, so reading it back as the CAUSE of
        // a later exit reports the first crash's reason for every crash after it,
        // for the whole life of the supervisor. A fatal belongs to exactly one
        // worker process, so it is stored on exactly one worker process.
        child._fatalReason = m.payload?.reason || 'fatal'
        sup.ctx.lastCrashReason = child._fatalReason
      }
    })
    child.on('exit', (code, signal) => handleExit(code, signal, child))
    return child
  }

  function handleReady(child, payload) {
    rt.booted = true
    // booting|restarting -> healthy. (restarting sends RESTART_DONE->booting
    // first; we collapse the common case by firing BOOTED from either.)
    if (sup.state === 'restarting') sup.fire('RESTART_DONE', Date.now())
    const bootedOk = sup.fire('BOOTED', Date.now())
    if (!bootedOk && sup.state !== 'healthy') sup.resyncHealthy(Date.now())
    sup.pushStateToWorker()   // hand the fresh worker the current snapshot immediately
    runtimeEvents.flush()     // persist any lifecycle bounce buffered while no worker was up (e.g. the crash that killed the prior one)
    log.info?.('[supervisor] worker ready', { pid: child.pid, port: payload?.port })
  }

  function handleExit(code, signal, child) {
    const now = Date.now()
    if (rt.stopping || sup.state === 'stopping' || sup.state === 'stopped') return   // expected exit
    // A planned drain (reload or stop) marks the child _expectedExit BEFORE asking
    // it to drain. This per-worker flag is immune to the timing race that the
    // shared `draining` flag has: DRAIN_COMPLETE resolves the drain promise (which
    // clears `draining`) BEFORE the child's 'exit' event lands, so by the time we
    // get here `draining` is already false and the exit would be miscounted as a
    // crash -- inflating the restart count, burning a backoff, and wrongly eating
    // the crash budget on rapid reloads. The child-local flag stays true.
    if (child._expectedExit || rt.draining) return
    const decision = classifyWorkerExit({
      code, signal, now,
      crashes: sup.ctx.crashes,
      restarts: sup.ctx.restarts,
      // This child's OWN fatal report if it managed to send one, else the cause
      // read off its own dying stderr. Never sup.ctx.lastCrashReason: see the
      // FATAL handler above for why that field cannot answer "why did THIS
      // worker exit".
      // The exit code stays in the string when the cause comes from stderr --
      // `classifyWorkerExit` uses lastCrashReason INSTEAD of its own
      // `worker exited code=...` sentence, and a cause with no code is a worse
      // record than a code with no cause.
      //
      // BEST-EFFORT BY CONSTRUCTION, and deliberately not made stricter: Node
      // does not guarantee that a child's stdio has finished flushing when
      // 'exit' fires, so a crash whose last write races the exit yields an empty
      // tail and no cause. That degrades to the bare code-and-signal reason --
      // exactly what this path recorded before -- so the worst case is a missed
      // explanation, never a missed restart. Waiting for 'close' or for the
      // stream's 'end' instead would put the whole restart ladder behind a
      // stream that a surviving grandchild holding fd 2 can keep open forever,
      // which trades a cosmetic loss for a wedged runtime.
      lastCrashReason: child._fatalReason || (() => {
        const cause = causeFromStderrTail(flushStderrTail(child))
        return cause ? `worker exited code=${code} signal=${signal || ''} -- ${cause}` : null
      })(),
    })
    if (decision.kind === 'config-fatal') {
      sup.fire('BUDGET_EXCEEDED', now, decision.reason)
      log.error?.('[supervisor] worker port is already in use (another casey running?) -- not restarting. Stop the other instance or pass a different --port.', { code })
      return
    }
    // Unexpected exit == crash. Record, count against the budget, restart-or-degrade.
    sup.ctx.crashes = decision.crashes
    sup.ctx.lastCrashReason = decision.reason
    log.error?.('[supervisor] worker crashed', { code, signal, reason: decision.reason })
    sup.fire('CRASH', now, decision.reason)
    if (decision.kind === 'budget') {
      sup.fire('BUDGET_EXCEEDED', now, decision.reason)
      log.error?.('[supervisor] crash budget exceeded -- entering degraded, no further auto-restart', {
        crashes: decision.crashes.length, windowMs: decision.windowMs, limit: decision.limit,
      })
      // Do NOT respawn. An operator (or a source change -> RELOAD) recovers it.
      return
    }
    log.info?.('[supervisor] restarting after crash', { backoffMs: decision.backoffMs })
    // NOT unref'd, unlike every other timer in this runtime. Between the dead
    // worker and the respawn, this timer is frequently the ONLY handle the parent
    // holds: the dashboard and the gateway live in the worker, and with live
    // reload off (`casey up --no-reload` / CASEY_RELOAD=0) there are no fs.watch
    // watchers either. Unref'd, Node then drains the loop and the supervisor
    // EXITS 0 -- announcing success -- one second after the first crash, having
    // restarted nothing. Witnessed live against a deliberately poisoned worker:
    // one CRASH row, `restarting after crash { backoffMs: 300 }`, then a clean
    // exit and silence. The whole purpose of this process is to still be here
    // when this timer fires.
    // Held so stop() can clear it. `respawn`'s own rt.stopping guard already
    // stops a pending backoff resurrecting a worker after a deliberate stop, but
    // it cannot stop a REF'D timer keeping the process up for the rest of the
    // backoff (10s at the ceiling) after the drain has finished.
    pendingRestartTimer = setTimeout(() => { pendingRestartTimer = null; restart().respawn(Date.now()) }, decision.backoffMs)
  }

  // Called by the supervisor's stop(): drop a crash backoff that is still pending
  // so a deliberate shutdown exits now rather than at the end of it.
  function cancelPendingRestart() {
    if (!pendingRestartTimer) return
    clearTimeout(pendingRestartTimer)
    pendingRestartTimer = null
  }

  return { spawn, cancelPendingRestart }
}
