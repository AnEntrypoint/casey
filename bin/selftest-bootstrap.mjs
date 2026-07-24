#!/usr/bin/env node
// Loads .env BEFORE any casey/handler module is ever imported, then hands
// off to the real selftest logic. Exists because ES module `import`
// statements are hoisted -- they run before any top-level code in the
// importing module, so a process.loadEnvFile() call placed inside
// selftest.js itself (even as the very first line after its own imports)
// always runs AFTER every statically-imported module (casey.js, and
// transitively hooks/handler.js) has already evaluated its own top-level
// constants. hooks/handler.js's TURN_HARD_DEADLINE_MS is exactly one such
// constant -- live-witnessed this session: selftest kept measuring against
// the stale 60000ms default no matter what CASEY_TURN_HARD_DEADLINE_MS was
// set to in .env, because by the time selftest.js's own loadEnvFile() call
// ran, handler.js's module body (including that constant) had already
// executed with process.env still missing the .env values. A separate
// bootstrap file with NO static imports of its own loads .env first, then
// dynamically imports selftest.js -- dynamic import() only begins
// evaluating its target module after this line actually runs, so every
// downstream module sees the fully-loaded environment from the start.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const envPath = path.join(ROOT, '.env')
try { if (existsSync(envPath) && process.loadEnvFile) process.loadEnvFile(envPath) } catch { /* ignore, selftest still runs on code defaults */ }

await import('./selftest.js')
