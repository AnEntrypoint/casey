// install-hooks.mjs -- point this repo's git at the tracked hooks/ dir.
//
// .git/hooks is NOT version-controlled, so a tracked hook only takes effect once git
// is told to look in our hooks/ dir. `core.hooksPath` does exactly that in one shot
// (git >= 2.9), and because hooks/ is tracked, every clone gets the same hooks after
// running this once. The hooks (post-merge / post-checkout) nudge a watched source
// file so a running `casey up` hot-reloads on pulled/checked-out code with no manual
// restart.
//
// Run: node scripts/install-hooks.mjs   (or: npm run install-hooks)
import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = path.join(repoRoot, 'hooks')

try {
  // Relative path keeps the config portable across machines/clone locations.
  execFileSync('git', ['config', 'core.hooksPath', 'hooks'], { cwd: repoRoot, stdio: 'pipe' })
  // Make the hook scripts executable (a no-op on Windows, required on POSIX).
  for (const f of readdirSync(hooksDir)) {
    try { chmodSync(path.join(hooksDir, f), 0o755) } catch { /* windows: ignore */ }
  }
  console.log('[casey] git hooks installed: core.hooksPath -> hooks/')
  console.log('[casey] post-merge + post-checkout will nudge a watched file so a running `casey up` reloads on pulled code.')
} catch (e) {
  console.error('[casey] hook install failed:', e.message)
  process.exit(1)
}
