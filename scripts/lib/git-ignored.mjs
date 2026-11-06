

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

    if (e.status === 1 && e.stdout != null) {
      const ignored = new Set(String(e.stdout).split('\n').filter(Boolean))
      return paths.filter((_, i) => !ignored.has(rel[i]))
    }
    return paths
  }
}
