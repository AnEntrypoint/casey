#!/usr/bin/env node
// check-submodules.mjs -- read-only health check for the deps/* AnEntrypoint
// submodules (freddie, thatcher, acptoapi, design). Each checkout must track
// a real branch named "main", never a detached commit -- see AGENTS.md's
// "Supply-chain integrity" section for why (a detached submodule is how the
// 2026-08 thatcher HiddenSpawn incident's compromised commit went unnoticed).
// This script never mutates git state; it only reports. Run via
// `npm run check-submodules` or as part of `casey doctor`.

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function parseGitmodules(text) {
  const paths = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*path\s*=\s*(.+?)\s*$/)
    if (m) paths.push(m[1])
  }
  return paths
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch (e) {
    return { error: (e.stderr || e.message || '').toString().trim() }
  }
}

function checkOne(relPath) {
  const dir = join(ROOT, relPath)
  if (!existsSync(join(dir, '.git'))) {
    return { path: relPath, ok: false, reason: 'not-initialized (run: git submodule update --init --recursive)' }
  }

  const branchRef = git(['symbolic-ref', '-q', 'HEAD'], dir)
  if (typeof branchRef !== 'string' || !branchRef.startsWith('refs/heads/')) {
    return { path: relPath, ok: false, reason: 'DETACHED HEAD' }
  }
  const branch = branchRef.replace('refs/heads/', '')

  const status = git(['status', '--porcelain'], dir)
  if (typeof status !== 'string') {
    return { path: relPath, ok: false, branch, reason: `could not read status: ${status.error}` }
  }
  const dirty = status.length > 0

  const fetchResult = git(['fetch', '--quiet', 'origin', branch], dir)
  if (typeof fetchResult !== 'string') {
    return { path: relPath, ok: false, branch, dirty, reason: `fetch failed: ${fetchResult.error}` }
  }
  const counts = git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], dir)
  if (typeof counts !== 'string') {
    return { path: relPath, ok: false, branch, dirty, reason: `could not compare against origin/${branch}: ${counts.error}` }
  }
  const parts = counts.split(/\s+/)
  const behind = Number(parts[0])
  const ahead = Number(parts[1])

  const okBranch = branch === 'main'
  const ok = okBranch && !dirty && behind === 0

  return {
    path: relPath,
    ok,
    branch,
    dirty,
    ahead,
    behind,
    reason: !okBranch ? `on branch "${branch}", expected "main"` : dirty ? 'uncommitted changes' : behind > 0 ? `${behind} commit(s) behind origin/${branch}` : null,
  }
}

function main() {
  const gitmodulesPath = join(ROOT, '.gitmodules')
  if (!existsSync(gitmodulesPath)) {
    console.error('No .gitmodules found at repo root.')
    return 1
  }
  const paths = parseGitmodules(readFileSync(gitmodulesPath, 'utf8'))
  if (paths.length === 0) {
    console.log('No submodules declared.')
    return 0
  }

  let failures = 0
  for (const relPath of paths) {
    const r = checkOne(relPath)
    if (r.ok) {
      console.log(`OK    ${r.path}  branch=${r.branch}${r.ahead ? ` ahead=${r.ahead}` : ''}`)
    } else {
      failures++
      console.error(`FAIL  ${r.path}  ${r.reason}`)
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${paths.length} submodule(s) need attention. See AGENTS.md "Supply-chain integrity" for the fix (fetch + reset --hard origin/main).`)
  }
  return failures > 0 ? 1 : 0
}

process.exit(main())
