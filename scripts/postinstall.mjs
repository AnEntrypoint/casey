#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const SETUP = ['install-freddie-deps.mjs', 'link-deps.mjs', 'install-hooks.mjs']

const GATE = 'scan-deps.mjs'

function run(script) {
  return spawnSync(process.execPath, [path.join(HERE, script)], { stdio: 'inherit' }).status
}

const degraded = []
for (const step of SETUP) {
  if (run(step) !== 0) degraded.push(step)
}

if (degraded.length) {

  console.warn(`postinstall: ${degraded.length} setup step(s) did not complete: ${degraded.join(', ')}.`)
  console.warn('postinstall: the install continues, but this tree may be only partly linked -- run `node bin/casey.js doctor` before trusting it.')
}

process.exit(run(GATE))
