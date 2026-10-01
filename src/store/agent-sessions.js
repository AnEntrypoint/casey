
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function decodeAgentDirName(name) {
  return String(name).replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

export function freddieSessionsRoot() {
  return process.env.FREDDIE_HOME
    ? path.join(process.env.FREDDIE_HOME, 'sessions')
    : path.join(os.homedir(), '.freddie', 'sessions')
}

export function findCaseSessionDirs(caseIds, root = freddieSessionsRoot()) {
  const wanted = new Set(caseIds.map(id => `case:${id}`))
  const out = []
  let projects = []
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const projectDir = path.join(root, p.name)
    let agents = []
    try { agents = fs.readdirSync(projectDir, { withFileTypes: true }) } catch { continue }
    for (const a of agents) {
      if (!a.isDirectory()) continue
      if (wanted.has(decodeAgentDirName(a.name).replace(/#\d+$/, ''))) out.push(path.join(projectDir, a.name))
    }
  }
  return out
}

const epochs = new Map()
export const agentKeyFor = (sessionKey) => (epochs.get(sessionKey) ? `${sessionKey}#${epochs.get(sessionKey)}` : sessionKey)

export function eraseCaseSessions(caseIds, { log = console, root = freddieSessionsRoot() } = {}) {
  const removed = []
  const failed = []
  for (const id of caseIds) epochs.set(`case:${id}`, (epochs.get(`case:${id}`) || 0) + 1)
  for (const dir of findCaseSessionDirs(caseIds, root)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir) }
    catch (e) {
      failed.push(dir)
      log?.error?.('[casey] could not erase stored conversation -- contact content remains on disk', { dir, error: e.message })
    }
  }
  return { removed, failed }
}
