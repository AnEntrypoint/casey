// case-tools-lookup.js  --  the two case-lookup tools: fetch one, or search many.
//
// case_get is the ownership-scoped single-case read; case_list is the
// cross-case enquiry surface (status/channel/assignee/place/proximity), always
// projected PII-free. Split out of case-tools.js verbatim -- names,
// descriptions, parameter schemas and handler bodies are unchanged.

import { normalizeLocation } from './location-normalize.js'
import {
  defTool, str, ownsCase, slimCase, slimEvent, enquiryRow, haversineKm,
} from './case-tools-shared.js'

export function buildLookupTools(store, { stageValues }) {
  return [
    defTool('case_get', 'cases',
      'Fetch a case by id, including its recent timeline events. Use to refresh your view before acting.',
      { type: 'object', properties: { id: str('Case id') }, required: ['id'] },
      async ({ id }, ctx) => {
        const c = await store().getCase(id)
        if (!c) return { error: `no case ${id}` }
        // case_get's `id` param is agent-chosen -- the model can ask about ANY
        // case, not just the asking worker's own (a status ask like "how is
        // CASE-1234 going" names a ref the model resolves to some id). Ownership
        // scoping (same check as mineRows) decides which projection is safe: the
        // worker's OWN case gets the full slimCase (report incl. owner_name/
        // owner_contact -- their own case, their own data), a case belonging to
        // SOMEONE ELSE gets the PII-free enquiryRow, same as case_list/case_mine.
        // Without this, any worker asking about any case ref (even by typo/
        // overheard) got another contact's phone number and free-text account.
        const author = ctx?.author || ctx?.principal?.id
        // Fail CLOSED: no author on ctx means we cannot prove ownership, so treat
        // as not-owned (PII-free) rather than defaulting to full access.
        const owns = ownsCase(c.external_id, author)
        const events = owns ? await store().listEvents(id, { limit: 30 }) : []
        return { case: owns ? slimCase(c) : enquiryRow(c), events: events.map(slimEvent) }
      }),
    defTool('case_list', 'cases',
      'List cases, optionally filtered by status/channel/assignee/location. Use `location` (a town, area, or place a person mentions) to find reports in a place -- this is the place-enquiry tool. Use `near` (your own best-estimate lat/lon for the place the worker said they are at) to find the NEAREST reports -- this is the "closest case" / "cases near me" tool; it returns rows sorted by distance with a distance_km on each, so you can answer "the nearest on record is CASE-xxxx at <place>, about N km away" from the real result, never from memory. Returns most-recently-active first (or nearest-first when `near` is given), PII-free.',
      {
        type: 'object',
        properties: {
          status: str('Filter by workflow status', { enum: stageValues }),
          channel: str('Filter by channel'),
          assignee: str('Filter by assignee'),
          location: str('A place name (town/area) to match reports whose location contains it'),
          near: {
            type: 'object',
            description: 'Your own best-estimate latitude/longitude for the place the worker said they are at (a named town/farm/landmark you can place). Returns cases nearest that point, sorted by distance, each with distance_km. Coordinates are model-estimated, so this is a best-effort "nearest we have on record", not a surveyed exact distance. Leave cases with no recorded coordinate out of the ranking.',
            properties: {
              lat: { type: 'number', description: 'Latitude of the place the worker described' },
              lon: { type: 'number', description: 'Longitude of the place the worker described' },
              radius_km: { type: 'number', description: 'Optional cap: only return cases within this many km (e.g. 100). Omit to rank all coordinate-bearing cases by distance.' },
            },
          },
          limit: { type: 'number', default: 25 },
        },
      },
      async ({ status, channel, assignee, location, near, limit = 25 }) => {
        const where = {}
        if (status) where.status = status
        if (channel) where.channel = channel
        if (assignee) where.assignee = assignee
        // A place enquiry: location lives in the free-text report JSON, not a queryable
        // column, so pull a wider window and JS-filter on the report location substring.
        const pull = location ? Math.max(limit * 20, 500) : limit
        let rows = await store().listCases(where, { limit: pull })
        if (location) {
          // Shared normalization (case-fold, trim, collapse whitespace/punctuation
          // noise) so "eMalahleni," "eMalahleni.", and "emalahleni  " all match the
          // same needle -- consistent with the normalized_location derived field
          // (case-store.js), never a gazetteer/alias table.
          const needle = normalizeLocation(location)
          rows = rows.filter(c => {
            let loc = ''
            try { loc = (c.report ? JSON.parse(c.report) : {}).location || '' } catch { loc = '' }
            return normalizeLocation(loc).includes(needle)
          }).slice(0, limit)
        }
        // A proximity enquiry ("closest case" / "cases near me"): rank by great-circle
        // distance from the worker's stated place (the model's own best estimate). Only
        // cases that carry an agent-estimated lat/lon can be ranked; cases without a
        // coordinate are excluded from the near result (they cannot be placed). This is
        // best-effort because coordinates are model-estimated, not surveyed -- the
        // prompt frames the answer as "nearest we have on record".
        if (near && typeof near.lat === 'number' && typeof near.lon === 'number') {
          if (typeof near.radius_km === 'number' && Number.isFinite(near.radius_km) && near.radius_km < 0) {
            return { error: `radius_km must be >= 0, got ${near.radius_km}` }
          }
          const origLat = near.lat, origLon = near.lon
          const radius = typeof near.radius_km === 'number' && Number.isFinite(near.radius_km) ? near.radius_km : null
          const withDist = []
          for (const c of rows) {
            const clat = Number(c.lat), clon = Number(c.lon)
            if (!Number.isFinite(clat) || !Number.isFinite(clon)) continue
            const d = haversineKm(origLat, origLon, clat, clon)
            if (radius != null && d > radius) continue
            withDist.push({ c, distance_km: Math.round(d * 10) / 10 })
          }
          withDist.sort((a, b) => a.distance_km - b.distance_km)
          const top = withDist.slice(0, limit)
          return { count: top.length, cases: top.map(({ c, distance_km }) => enquiryRow(c, distance_km)) }
        }
        // A LIST spans cases the asker may not own, so project each row PII-FREE
        // (enquiryRow: ref/status/species/location only) -- NEVER the full slimCase
        // report, which carries owner_name/contact_fallback/other-worker contact text.
        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),
  ]
}
