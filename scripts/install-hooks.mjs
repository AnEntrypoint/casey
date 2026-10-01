

import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = path.join(repoRoot, 'hooks')

try {

  execFileSync('git', ['config', 'core.hooksPath', 'hooks'], { cwd: repoRoot, stdio: 'pipe' })

  for (const f of readdirSync(hooksDir)) {
    try { chmodSync(path.join(hooksDir, f), 0o755) } catch {  }
  }
  console.log('[casey] git hooks installed: core.hooksPath -> hooks/')
  console.log('[casey] post-merge + post-checkout will nudge a watched file so a running `casey up` reloads on pulled code.')
} catch (e) {

  console.error('[casey] hook install skipped (non-fatal):', e.message)
}
