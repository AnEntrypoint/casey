#!/usr/bin/env node
// Loads .env BEFORE any casey/handler module is ever imported, then hands
// off to the real CLI implementation (bin/casey-cli.mjs). Exists because ES
// module `import` statements are hoisted -- they run before any top-level
// code in the importing module, so a process.loadEnvFile() call placed
// inside this file's own body (even as the very first statement) would
// always run AFTER every statically-imported module (createCasey ->
// src/casey.js -> transitively src/hooks/handler.js) has already evaluated
// its own top-level constants. hooks/handler.js's TURN_HARD_DEADLINE_MS
// (and every other `Number(process.env.CASEY_*) || default` module-level
// constant in that file) is exactly one such constant -- live-witnessed
// this session via bin/selftest.js hitting the identical bug: a real turn
// kept degrading at the stale 60000ms code default no matter what
// CASEY_TURN_HARD_DEADLINE_MS was set to in .env, because the constant had
// already been captured before .env was loaded. This file is the SAME fix
// applied to the actual production entry point (`casey up`, forked by the
// supervisor, inherited by every worker child) -- not just the test
// harness -- since the live process was subject to the identical bug.
//
// A separate file with NO static imports of its own loads .env first, then
// dynamically imports the real CLI -- only a dynamic import() begins
// evaluating its target module after this line actually runs, so every
// downstream module sees the fully-loaded environment from the start.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const envPath = path.join(ROOT, '.env')
try { if (existsSync(envPath) && process.loadEnvFile) process.loadEnvFile(envPath) } catch { /* ignore */ }

await import('./casey-cli.mjs')
