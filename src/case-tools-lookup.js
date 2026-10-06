

import { normalizeLocation } from './location-normalize.js'
import { parseReport } from './timestamp.js'
import { findCase, deskAuthorityOn, maskNumberFields, scrubNumbers } from './case-tools-team-shared.js'
import { canQueryCases } from './contact-tiers.js'
import {
  defTool, str, ownsCase, slimCase, slimEvent, enquiryRow, haversineKm,
} from './case-tools-shared.js'

const EVENT_PAGE = 30

export function buildLookupTools(store, { stageValues }) {
  return [
    defTool('case_get', 'cases',
      'Fetch a case by id or reference, including its recent timeline events (the latest 30). To read older events pass events_before: the events_older_than value of the previous result, which returns the 30 before it. Reporter phone numbers are not shown for a report that is not assigned to the asking team member. Use to refresh your view before acting.',
      { type: 'object', properties: { id: str('Case id or reference'), events_before: { type: 'number', description: 'Position of the oldest event already seen (events_older_than from the previous result); returns the 30 events before it' } }, required: ['id'] },
      async ({ id, events_before }, ctx) => {
        const c = await findCase(store(), id)
        if (!c) return { error: `no case ${id}` }
        id = c.id
        const author = ctx?.author || ctx?.principal?.id
        const own = ownsCase(c.external_id, author)
        const full = own || canQueryCases(ctx?.tier)
        if (!full) return { case: enquiryRow(c), events: [] }
        const held = own || !!deskAuthorityOn(ctx, c)
        if (events_before != null && !Number.isFinite(Number(events_before))) return { error: 'events_before must be the events_older_than number from the previous result' }
        const all = await store().listEvents(id)
        const end = events_before == null ? all.length : Math.min(Math.max(Math.floor(Number(events_before)), 0), all.length)
        const start = Math.max(0, end - EVENT_PAGE)
        const slim = slimCase(c)
        const events = all.slice(start, end).map(slimEvent)
        if (!held) {
          slim.report = maskNumberFields(slim.report)
          slim.subject = scrubNumbers(slim.subject)
          slim.summary = scrubNumbers(slim.summary)
          for (const e of events) e.text = scrubNumbers(e.text)
        }
        return { case: slim, events, events_total: all.length, ...(start > 0 ? { events_older_than: start } : {}) }
      }),
    defTool('case_list', 'cases',

      'Simple lookup only: list cases by status/channel/assignee or one place. For free text, flags (no photo, sent back), dates, my cases, sorting or paging use case_search instead. Use `location` (a town, area, or place a person mentions) to find reports in a place -- this is the place-enquiry tool. Use `near` (your own best-estimate lat/lon for the place the worker said they are at) to find the NEAREST reports -- this is the "closest case" / "cases near me" tool; it returns rows sorted by distance with a distance_km on each. Answer only from the ref, place and distance_km the result actually returns, never from memory, and write the sentence around them yourself. Returns most-recently-active first (or nearest-first when `near` is given), PII-free.',
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

        const pull = location ? Math.max(limit * 20, 500) : limit
        let rows = await store().listCases(where, { limit: pull })
        if (location) {

          const needle = normalizeLocation(location)
          rows = rows.filter(c => {
            let loc = parseReport(c).location || ''
            return normalizeLocation(loc).includes(needle)
          }).slice(0, limit)
        }

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

        return { count: rows.length, cases: rows.map(enquiryRow) }
      }),
  ]
}
