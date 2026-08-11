// core/subject.js -- Subject identity linking: repeat observations about the
// same herd/household/site link to one Subject id, preventing double-
// counting in aggregates. This is additive metadata alongside thatcher's
// existing `case` entity -- a Subject is NOT a replacement for a case; a
// case's own id (case-store.js) doubles as the anchor subjectId that
// core/observation.js's mkObservation expects, so no second id scheme is
// introduced for casey's existing conversation flow. This module exists for
// the harder linking problem: TWO DIFFERENT cases (two different
// conversations, e.g. a neighbour later reporting the same herd) that turn
// out to describe the same real-world subject, which thatcher's case
// entity has no native concept of.

import fs from 'node:fs'
import path from 'node:path'

export class SubjectLinks {
  constructor({ dataDir } = {}) {
    if (!dataDir) throw new Error('SubjectLinks: dataDir is required')
    this.dir = path.resolve(dataDir, 'raw-log')
    fs.mkdirSync(this.dir, { recursive: true })
    this.file = path.join(this.dir, 'subject-links.json')
    this._links = null   // caseId -> canonicalSubjectId
  }

  _load() {
    if (this._links) return this._links
    if (fs.existsSync(this.file)) {
      try { this._links = JSON.parse(fs.readFileSync(this.file, 'utf8')) }
      catch { this._links = {} }
    } else {
      this._links = {}
    }
    return this._links
  }

  _persist() {
    fs.writeFileSync(this.file, JSON.stringify(this._links, null, 2), 'utf8')
  }

  // A case's canonical subject is itself until explicitly linked to another.
  canonicalSubjectId(caseId) {
    const links = this._load()
    let cur = caseId
    const seen = new Set()
    while (links[cur] && !seen.has(cur)) {
      seen.add(cur)
      cur = links[cur]
    }
    return cur
  }

  // Link caseId's observations into targetSubjectId's aggregate identity.
  // This is a DECLARED human/agent judgment (a dashboard operator noticing
  // two reports are the same herd), never automatic/inferred -- the record
  // of who linked it and when belongs in the append-only event log the
  // caller already writes to (case-store.js appendEvent), not duplicated
  // here. This module only stores the resulting graph.
  link(caseId, targetSubjectId, { linkedBy, reason } = {}) {
    if (!linkedBy || !reason) throw new Error('SubjectLinks.link: linkedBy and reason are both required -- a subject merge must be attributable and explained')
    if (caseId === targetSubjectId) throw new Error('SubjectLinks.link: cannot link a subject to itself')
    const links = this._load()
    links[caseId] = targetSubjectId
    this._persist()
    return { caseId, targetSubjectId, linkedBy, reason }
  }

  // All case ids that resolve to the same canonical subject as caseId
  // (including caseId itself) -- used to pull every observation across a
  // linked group without double-counting the same real-world subject twice.
  groupMembers(caseId) {
    const canonical = this.canonicalSubjectId(caseId)
    const links = this._load()
    const members = new Set([canonical])
    for (const id of Object.keys(links)) {
      if (this.canonicalSubjectId(id) === canonical) members.add(id)
    }
    return [...members]
  }
}
