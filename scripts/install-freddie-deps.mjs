// install-freddie-deps.mjs -- runs `pnpm install` inside deps/freddie so its
// ~220-package pnpm workspace (workspace:^ cross-deps npm cannot resolve at
// all) has each package's own node_modules correctly linked before
// scripts/link-deps.mjs symlinks each @freddie/* package into casey's own
// node_modules. See link-deps.mjs's own header comment for the full
// resolution-strategy rationale.
//
// Degrades to a loud warning (never a hard failure) when the submodule isn't
// checked out or pnpm isn't installed -- matches this repo's existing
// postinstall discipline (scan-deps.mjs's `|| true`), since a bare clone
// with no deps/freddie yet, or a machine without pnpm, should not block
// `npm install` for the rest of the repo.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const freddieDir = path.join(repoRoot, 'deps', 'freddie')

if (!existsSync(path.join(freddieDir, 'pnpm-workspace.yaml'))) {
  console.warn('[install-freddie-deps] skip: deps/freddie/pnpm-workspace.yaml not found (submodule not checked out -- run `git submodule update --init` first)')
  process.exit(0)
}

const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(pnpmCmd, ['install'], { cwd: freddieDir, stdio: 'inherit', shell: process.platform === 'win32' })

if (result.error || result.status !== 0) {
  console.warn('[install-freddie-deps] pnpm install failed or pnpm is not installed -- casey\'s freddie-bundle plugins will fail to resolve until this is fixed manually (cd deps/freddie && pnpm install)')
  process.exit(0)
}

console.log('[install-freddie-deps] deps/freddie pnpm workspace installed')
