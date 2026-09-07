// Shared by scripts/lint.mjs and scripts/scan-deps.mjs, both of which walk the
// repo themselves and then need to drop whatever git already ignores.
//
// Untracked scratch workspaces (gm-plugkit tool-verb clones, session
// scratchpads) live at the repo root under gitignored names that no hardcoded
// skip list keeps up with -- ask git which of the walk's candidates it would
// actually ignore, rather than growing that list by hand forever.
//
// Dependency-free on purpose: both callers must run from a bare clone with no
// install at all, so this falls back to the unfiltered list whenever git is
// unavailable (no git on PATH, not a repo).
import { execFileSync } from 'node:child_process'

const relativize = (paths, root) => paths.map((p) => p.slice(root.length).replace(/\\/g, '/'))

export function filterGitignored(paths, root) {
  const rel = relativize(paths, root)
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root, input: rel.join('\n'), stdio: ['pipe', 'pipe', 'pipe'],
    }).toString()
    const ignored = new Set(out.split('\n').filter(Boolean))
    return paths.filter((_, i) => !ignored.has(rel[i]))
  } catch (e) {
    // git check-ignore exits 1 (not an error) when NOTHING is ignored --
    // only fall back on a genuine invocation failure (git missing/not a repo).
    if (e.status === 1 && e.stdout != null) {
      const ignored = new Set(String(e.stdout).split('\n').filter(Boolean))
      return paths.filter((_, i) => !ignored.has(rel[i]))
    }
    return paths
  }
}
