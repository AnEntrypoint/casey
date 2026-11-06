import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { assertIsAdapter } from './base.js'
import * as noneAdapter from './none.js'

async function resolveAdapter() {
  if (!process.env.CASEY_EXTERNAL_SYNC_ADAPTER) return noneAdapter
  const p = path.resolve(process.env.CASEY_EXTERNAL_SYNC_ADAPTER)
  if (!existsSync(p)) throw new Error(`CASEY_EXTERNAL_SYNC_ADAPTER not found: ${p}`)
  const mod = await import(pathToFileURL(p).href)
  assertIsAdapter(mod, `CASEY_EXTERNAL_SYNC_ADAPTER module at ${p}`)
  return mod
}

export const adapter = await resolveAdapter()
