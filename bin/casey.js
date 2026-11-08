#!/usr/bin/env node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const envPath = path.join(ROOT, '.env')
try { if (existsSync(envPath) && process.loadEnvFile) process.loadEnvFile(envPath) } catch {}

await import('./casey-cli.mjs')
