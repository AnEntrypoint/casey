// auto-update.mjs -- OPTIONAL auto-deploy loop for a casey host.
//
// `casey up` already hot-reloads on a local source change, and the git hooks make a
// `git pull` trigger that reload. This loop closes the last gap for an unattended
// HOST: it periodically `git pull`s, so a push to origin auto-deploys (the
// post-merge hook then nudges the running worker to reload on the new code) with no
// human on the box at all.
//
// OPT-IN by design: a dev checkout must NOT auto-pull under your feet. Enable with
//   CASEY_AUTO_UPDATE=1 node scripts/auto-update.mjs
// Tune the interval with CASEY_AUTO_UPDATE_INTERVAL_MS (default 60000). Run it
// alongside `casey up` (a second process / pm2 / systemd unit), not inside it.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INTERVAL_MS = Number(process.env.CASEY_AUTO_UPDATE_INTERVAL_MS || 60_000)

if (process.env.CASEY_AUTO_UPDATE !== '1') {
  console.error('[casey auto-update] disabled. Set CASEY_AUTO_UPDATE=1 to enable (opt-in).')
  process.exit(0)
}

async function pullOnce() {
  try {
    const before = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
    // --ff-only: never auto-merge divergent local commits on a deploy host; a host
    // that has diverged needs a human, not a silent merge.
    await run('git', ['pull', '--ff-only'], { cwd: repoRoot })
    const after = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
    if (before !== after) {
      console.log(`[casey auto-update] pulled ${before.slice(0, 7)} -> ${after.slice(0, 7)}; the post-merge hook nudged a reload.`)
    }
  } catch (e) {
    // A transient network/ff failure must never kill the loop -- log and retry next tick.
    console.error('[casey auto-update] pull failed (will retry):', e.message)
  }
}

console.log(`[casey auto-update] enabled; pulling --ff-only every ${Math.round(INTERVAL_MS / 1000)}s.`)
await pullOnce()
setInterval(pullOnce, INTERVAL_MS)
