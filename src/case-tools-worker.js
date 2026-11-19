

import { defTool, str, boundCase, isValidLatLon } from './case-tools-shared.js'
import { searchCases } from './case-tools-search.js'
import { toStorable } from './store/guards.js'
import { caseyText } from './deployment-text.js';

export function buildWorkerTools(store) {
  return [
    defTool('case_mine', 'cases',
      caseyText("src/case-tools-worker.js#0"),
      { type: 'object', properties: { limit: { type: 'number', description: 'Rows, default 8, max 25' } } },
      async ({ limit }, ctx) => searchCases(store(), ctx, { scope: 'mine', state: 'open', limit })),
    defTool('case_today', 'cases',
      caseyText("src/case-tools-worker.js#1"),
      { type: 'object', properties: { limit: { type: 'number', description: 'Rows, default 8, max 25' } } },
      async ({ limit }, ctx) => searchCases(store(), ctx, { scope: 'mine', state: 'open', limit })),

    defTool('case_checkin', 'cases',
      caseyText("src/case-tools-worker.js#2"),
      {
        type: 'object',
        properties: {
          lat: { type: 'number', description: caseyText("src/case-tools-worker.js#3") },
          lon: { type: 'number', description: caseyText("src/case-tools-worker.js#s0") },
          location_source: str(
            caseyText("src/case-tools-worker.js#4") +
            caseyText("src/case-tools-worker.js#5") +
            caseyText("src/case-tools-worker.js#6") +
            caseyText("src/case-tools-worker.js#7") +
            caseyText("src/case-tools-worker.js#8"),
            { enum: ['gps', 'estimated', 'confirmed'] },
          ),
        },
        required: ['lat', 'lon'],
      },
      async ({ lat, lon, location_source }, ctx) => {
        if (!isValidLatLon(lat, lon)) {
          return { error: caseyText("src/case-tools-worker.js#9") }
        }

        const LOCATION_SOURCE_VALUES = new Set(['gps', 'estimated', 'confirmed'])
        if (location_source != null && !LOCATION_SOURCE_VALUES.has(location_source)) {
          return { error: caseyText("src/case-tools-worker.js#s1", [location_source]), allowed: [...LOCATION_SOURCE_VALUES] }
        }
        const resolvedLocationSource = location_source || 'estimated'
        const author = ctx?.author || ctx?.principal?.id
        if (!author) return { error: caseyText("src/case-tools-worker.js#10") }
        const contact = ctx?.store?.findOrCreateContactLocked
          ? await ctx.store.findOrCreateContactLocked({ channel: ctx.channel || 'other', external_id: author })
          : null
        if (!contact?.id) return { error: caseyText("src/case-tools-worker.js#11") }
        await store().t.update('contact', contact.id, toStorable({
          last_location_lat: lat, last_location_lon: lon, last_location_at: new Date().toISOString(),
          last_location_source: resolvedLocationSource,
        }), { id: 'casey-agent', role: 'agent' })
        return { ok: true }
      }),

    defTool('case_idle', 'cases',

      caseyText("src/case-tools-worker.js#12"),
      { type: 'object', properties: { note: str(caseyText("src/case-tools-worker.js#13")) } },
      async ({ note }, ctx) => {
        const id = boundCase(ctx).id
        if (!id) return { error: caseyText("src/case-tools-worker.js#14") }
        const text = note ? `IDLE ${note}` : 'IDLE'
        await store().appendEvent(id, { kind: 'observation', actor: 'agent', text })
        return { ok: true }
      }),
  ]
}
