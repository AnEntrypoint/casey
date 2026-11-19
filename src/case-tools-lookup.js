

import { normalizeLocation } from './location-normalize.js'
import { parseReport } from './timestamp.js'
import { findCase, deskAuthorityOn, maskNumberFields, scrubNumbers } from './case-tools-team-shared.js'
import { canQueryCases } from './contact-tiers.js'
import {
  defTool, str, ownsCase, slimCase, slimEvent, enquiryRow, haversineKm,
} from './case-tools-shared.js'
import { caseyText } from './deployment-text.js';

const EVENT_PAGE = 30

export function buildLookupTools(store, { stageValues }) {
  return [
    defTool('case_get', 'cases',
      caseyText("src/case-tools-lookup.js#0"),
      { type: 'object', properties: { id: str(caseyText("src/case-tools-lookup.js#s0")), events_before: { type: 'number', description: caseyText("src/case-tools-lookup.js#1") } }, required: ['id'] },
      async ({ id, events_before }, ctx) => {
        const c = await findCase(store(), id)
        if (!c) return { error: caseyText("src/case-tools-lookup.js#s1", [id]) }
        id = c.id
        const author = ctx?.author || ctx?.principal?.id
        const own = ownsCase(c.external_id, author)
        const full = own || canQueryCases(ctx?.tier)
        if (!full) return { case: enquiryRow(c), events: [] }
        const held = own || !!deskAuthorityOn(ctx, c)
        if (events_before != null && !Number.isFinite(Number(events_before))) return { error: caseyText("src/case-tools-lookup.js#2") }
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

      caseyText("src/case-tools-lookup.js#3"),
      {
        type: 'object',
        properties: {
          status: str(caseyText("src/case-tools-lookup.js#s2"), { enum: stageValues }),
          channel: str(caseyText("src/case-tools-lookup.js#s3")),
          assignee: str(caseyText("src/case-tools-lookup.js#s4")),
          location: str(caseyText("src/case-tools-lookup.js#4")),
          near: {
            type: 'object',
            description: caseyText("src/case-tools-lookup.js#5"),
            properties: {
              lat: { type: 'number', description: caseyText("src/case-tools-lookup.js#6") },
              lon: { type: 'number', description: caseyText("src/case-tools-lookup.js#7") },
              radius_km: { type: 'number', description: caseyText("src/case-tools-lookup.js#8") },
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
            return { error: caseyText("src/case-tools-lookup.js#s5", [near.radius_km]) }
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
