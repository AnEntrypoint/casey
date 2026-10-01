

import {
  defTool, str, enquiryRow, mineRows, boundCase, isValidLatLon,
} from './case-tools-shared.js'
import { toStorable } from './store/guards.js'

export function buildWorkerTools(store) {
  return [
    defTool('case_mine', 'cases',
      "List the asking worker's OWN open cases (their itinerary). PII-free.",
      { type: 'object', properties: { limit: { type: 'number', default: 25 } } },
      async ({ limit = 25 }, ctx) => {

        const rows = await mineRows(store(), ctx, limit)
        if (rows?.error) return rows
        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),
    defTool('case_today', 'cases',
      "List cases active today for the asking worker (today's list). PII-free.",
      { type: 'object', properties: { limit: { type: 'number', default: 25 } } },
      async ({ limit = 25 }, ctx) => {

        const rows = await mineRows(store(), ctx, limit)
        if (rows?.error) return rows
        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),

    defTool('case_checkin', 'cases',
      "Record the FIELD WORKER's own current location (not an animal report's location) -- call this when they say where they are now, e.g. 'I'm at the clinic', 'just arrived at the Bela-Bela farm', or share GPS. Shows them on the team's map and lets a later 'anything near me' question use this as the starting point.",
      {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude of where the worker is now (their own best estimate for a described place, or exact if they shared GPS)' },
          lon: { type: 'number', description: 'Longitude of where the worker is now' },
          location_source: str(
            'REQUIRED. "gps" ONLY if they read out exact coordinates. Otherwise "estimated" -- your own ' +
            'best-effort guess from a place name they said, not yet confirmed with them. After you voice ' +
            'the estimate back and they agree, call again with "confirmed" and any refined lat/lon. ' +
            'Never guess "confirmed" -- it means they actually agreed. The operator map draws an estimate ' +
            'differently from a real fix, so this is what stops a guess being dispatched to as if it were one.',
            { enum: ['gps', 'estimated', 'confirmed'] },
          ),
        },
        required: ['lat', 'lon'],
      },
      async ({ lat, lon, location_source }, ctx) => {
        if (!isValidLatLon(lat, lon)) {
          return { error: 'lat/lon must be finite numbers in range (lat -90..90, lon -180..180)' }
        }

        const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed'])
        if (location_source != null && !LOCATION_SOURCE_VALUES.has(location_source)) {
          return { error: `invalid location_source: ${location_source}`, allowed: [...LOCATION_SOURCE_VALUES] }
        }
        const resolvedLocationSource = location_source || 'estimated'
        const author = ctx?.author || ctx?.principal?.id
        if (!author) return { error: 'no author on this turn -- cannot attribute a check-in' }
        const contact = ctx?.store?.findOrCreateContactLocked
          ? await ctx.store.findOrCreateContactLocked({ channel: ctx.channel || 'other', external_id: author })
          : null
        if (!contact?.id) return { error: 'could not resolve the contact record for this check-in' }
        await store().t.update('contact', contact.id, toStorable({
          last_location_lat: lat, last_location_lon: lon, last_location_at: new Date().toISOString(),
          last_location_source: resolvedLocationSource,
        }), { id: 'casey-agent', role: 'agent' })
        return { ok: true }
      }),

    defTool('case_idle', 'cases',

      "Record that the worker has nothing to work on right now. Call this when a worker says they have no cases, nothing to do, or asks what they should do next -- this flags them for follow-up by other staff. Recording it is invisible to them, so still reply warmly in your own words.",
      { type: 'object', properties: { note: str('Optional: what the worker said about their availability') } },
      async ({ note }, ctx) => {
        const id = boundCase(ctx).id
        if (!id) return { error: 'no active case to record an idle observation on' }
        const text = note ? `IDLE ${note}` : 'IDLE'
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),
  ]
}
