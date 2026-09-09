// The fourth place a contact's words are held, and the one no erasure reached.
//
// freddie's base bundle mounts a session-persistence plugin that writes one
// `session.jsonl.zstd` per agent under `<freddie home>/sessions/<project>/<agent
// id>/`. casey's agent ids are `case:<case id>` (src/agent/run-turn.js), so
// every conversation casey has ever had sits on disk keyed by case, VERBATIM
// and OUTSIDE the project's own data/ directory -- witnessed on this machine as
// ~/.freddie/sessions/_no-cwd/case~003A<case id>/session.jsonl.zstd, whose
// first line reads {"type":"session","id":"case:<case id>",...}.
//
// Three consequences, and the first is the reason this module exists:
//   * eraseContact scrubbed the contact row, the case row, the report blob and
//     the event log, and left the whole conversation here. A right-to-erasure
//     request is about what is held, and this is held.
//   * It is outside data/, so any backup or escrow scoped to data/ misses it,
//     and an unnoticed copy of contact content lives somewhere nobody looks.
//   * It is now load-bearing rather than incidental: run-turn.js resumes an
//     evicted agent from this file, so deleting one is deleting real state, not
//     tidying a cache. That is correct for an erasure and wrong for anything
//     else, which is why nothing here deletes on any other trigger.
//
// The directory name is matched by DECODING it rather than by re-implementing
// freddie's escaping. `case:` becomes `case~003A`, and guessing at that rule
// would break silently the day freddie changes it; reading the id back out of
// the name we are looking at cannot.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// `~003A` and friends: freddie percent-ish-escapes a path-unsafe character as
// `~` plus its four-digit hex code point.
function decodeAgentDirName(name) {
  return String(name).replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

export function freddieSessionsRoot() {
  return process.env.FREDDIE_HOME
    ? path.join(process.env.FREDDIE_HOME, 'sessions')
    : path.join(os.homedir(), '.freddie', 'sessions')
}

// Every on-disk session directory for the given case ids, across every project
// subdirectory -- a deployment that has run from more than one cwd has more than
// one project segment, and an erasure has to reach all of them.
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
      if (wanted.has(decodeAgentDirName(a.name))) out.push(path.join(projectDir, a.name))
    }
  }
  return out
}

// Remove the stored conversations for these cases. Best-effort per directory:
// the thatcher-side erasure has already succeeded by the time this runs, and a
// filesystem failure here must not undo or fail it -- it must be REPORTED
// instead, which is why the return value names what was left behind rather than
// only what was removed.
export function eraseCaseSessions(caseIds, { log = console, root = freddieSessionsRoot() } = {}) {
  const removed = []
  const failed = []
  for (const dir of findCaseSessionDirs(caseIds, root)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(dir) }
    catch (e) {
      failed.push(dir)
      log?.error?.('[casey] could not erase stored conversation -- contact content remains on disk', { dir, error: e.message })
    }
  }
  return { removed, failed }
}
