// Resolves CASEY_EXTERNAL_SYNC_ADAPTER the same way bin/worker-dashboard.js
// resolves CASEY_EXTRA_DASHBOARD_ROUTES: a deployer-set env var (never
// contact-influenced), validated EAGERLY at module load so a misconfigured
// deployment fails loud at boot rather than on the first sync attempt.
// Unset resolves to none.js, and behavior is then byte-identical to before
// this file existed -- nothing imports this module unless something asks
// for a sync adapter.
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

// Top-level await, matching this being an ES module: a misconfigured path
// or a module missing the contract throws the moment anything imports this
// file, not on the first fetchRemoteRecords/pushLocalUpdate call.
export const adapter = await resolveAdapter()
