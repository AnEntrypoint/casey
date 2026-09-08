#!/usr/bin/env node
// postinstall.mjs -- the npm postinstall chain, as a script rather than a shell
// one-liner, because the one-liner silently disarmed the supply-chain scanner.
//
// It used to be:
//
//   install-freddie-deps && link-deps && install-hooks && scan-deps || true
//
// In both sh and cmd, `||` binds to the WHOLE preceding `&&` chain, so the
// trailing `|| true` swallowed the exit code of every link -- including
// scan-deps.mjs, the last one. Live-witnessed: plant a file carrying the
// HiddenSpawn signature and `node scripts/scan-deps.mjs` exits 1 and prints
// "Do not run `npm install`/`casey up` again until every FAIL/BLOCKED above is
// confirmed malicious or a real false positive"; append `|| true` and the same
// run exits 0. npm therefore reported a clean install while the scanner was
// telling the operator to stop. That scanner exists because thatcher's own main
// was compromised on 2026-08-09 (see AGENTS.md, "thatcher / busybase chain"),
// and npm install is its primary automated trigger, so this was the one place
// it most needed to bite.
//
// The `|| true` was not pointless, though, which is why this is a script and not
// a deletion: the three SETUP steps genuinely may fail on a machine that is not
// set up for them (no pnpm, deps/ submodules not checked out, a git dir that
// will not take a hook) and must not break `npm install` over it -- AGENTS.md
// states that degrade-to-a-loud-warning contract for install-freddie-deps
// explicitly. So the tolerance stays exactly where it was earned, on the setup
// steps, and stops covering the security gate.
//
// Setup failures are reported, not hidden: a swallowed step that leaves the tree
// half-linked is worth seeing in the install log even when it is not fatal.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Each setup step may fail without failing the install, but never silently.
const SETUP = ['install-freddie-deps.mjs', 'link-deps.mjs', 'install-hooks.mjs']

// The security gate. Its exit code is this script's exit code, full stop.
const GATE = 'scan-deps.mjs'

function run(script) {
  return spawnSync(process.execPath, [path.join(HERE, script)], { stdio: 'inherit' }).status
}

const degraded = []
for (const step of SETUP) {
  if (run(step) !== 0) degraded.push(step)
}

if (degraded.length) {
  // Loud, but not fatal -- see the contract above.
  console.warn(`postinstall: ${degraded.length} setup step(s) did not complete: ${degraded.join(', ')}.`)
  console.warn('postinstall: the install continues, but this tree may be only partly linked -- run `node bin/casey.js doctor` before trusting it.')
}

// Never wrapped in a tolerance. A non-zero here means the supply-chain scanner
// found something, and npm must fail so a human looks at it.
process.exit(run(GATE))
