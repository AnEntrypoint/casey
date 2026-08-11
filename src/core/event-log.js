// core/event-log.js -- names the raw observation log as the SYSTEM OF
// RECORD for casey's new provenance subsystem, and everything else
// (aggregates, dashboard views, per-subject summaries) as REBUILDABLE
// PROJECTIONS off it. This module contains no new storage of its own --
// it is a thin, explicitly-named API surface over core/raw-log.js so
// callers reason about "the event log" rather than reaching into RawLog's
// file-backed internals directly. Corrections are new events (new
// Observations with correctsId set), never mutations -- see
// core/observation.js.

import { RawLog } from './raw-log.js'

export class ObservationEventLog {
  constructor({ dataDir }) {
    this._raw = new RawLog({ dataDir })
  }

  // The only way an event enters the log -- delegates to RawLog.append,
  // which itself has no update/delete. Prefer core/write-path.js's
  // writeObservation() as the actual entrypoint (it adds the no-silent-
  // inference gate and per-subject locking); this method exists for a
  // caller that has already produced a fully-formed, synced Observation
  // (e.g. replaying from a sync payload).
  appendEvent(observation) { return this._raw.append(observation) }

  // Rebuild ANY projection (a per-subject summary, an aggregate table, a
  // dashboard cache) from this method alone -- the entire "delete the
  // aggregate store and recompute" guarantee rests on every projection
  // being expressible as projectionFn(this.allEvents()).
  allEvents() { return this._raw.all() }

  eventsForSubject(subjectId) { return this._raw.bySubject(subjectId) }

  eventCount() { return this._raw.count() }

  corruptEventCount() { return this._raw.corruptLineCount() }
}

// Given a projector function (events[] -> anything) and the log, rebuild
// the projection from scratch -- the literal implementation of "you should
// be able to drop the aggregate store and recompute it entirely as a
// routine operation." A caller that stores this result in a cache is
// responsible for treating that cache as disposable, never authoritative.
export function rebuildProjection(eventLog, projectorFn) {
  return projectorFn(eventLog.allEvents())
}
