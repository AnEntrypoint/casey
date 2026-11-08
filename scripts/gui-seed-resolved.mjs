import { readFileSync } from 'node:fs'
import path from 'node:path'

const FX = JSON.parse(readFileSync(path.join(process.env.CASEY_CONFIG_DIR, 'gui-check', 'fixtures.json'), 'utf8'))
const DISEASES = FX.resolved.diseases
const AREAS = FX.resolved.areas
const ADVICE = FX.resolved.advice
const SPECIES = FX.resolved.species
const pick = (list, r) => { let t = r * list.reduce((s, x) => s + x[list[0].length - 1], 0); for (const x of list) { t -= x[x.length - 1]; if (t <= 0) return x } return list[list.length - 1] }

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296

export async function seedResolved(store, { n = 300, prefix = '2779', now = Math.floor(Date.now() / 1000) } = {}) {
  const R = rng(7)
  const admin = { id: 'casey-system', role: 'admin' }
  const made = { resolved: 0, closedNoDx: 0, open: 0, noLocation: 0 }
  for (let i = 0; i < n; i++) {
    const ext = prefix + String(1000000 + i)
    const { case: c } = await store.findOrCreateCase({ channel: 'whatsapp', external_id: ext, contact: { name: 'Seed Farmer ' + i, phone: ext }, subject: 'Seed report ' + i })
    const [area, lat, lon] = pick(AREAS, R())
    const [disease] = pick(DISEASES, R())
    const species = SPECIES[Math.floor(R() * SPECIES.length)]
    const bucket = R()
    const report = { species, symptoms: FX.resolved.symptoms, location: FX.resolved.locationPrefix + area + FX.resolved.locationSuffix + (820000000 + i), association: area }
    const noLoc = bucket > 0.9
    await store.mergeReport(c.id, report, { id: 'seed', role: 'agent' })
    await store.updateCase(c.id, noLoc ? {} : { lat: lat + (R() - 0.5) * 0.15, lon: lon + (R() - 0.5) * 0.15, location_source: 'estimated' }, admin)
    if (noLoc) made.noLocation++
    if (bucket < 0.5) {

      await store.mergeReport(c.id, { identified_disease: disease, recommended_resolution: ADVICE[i % ADVICE.length] }, { id: 'aht', role: 'operator' }, { bypassObserve: true, autoAssign: false })
      await store.transition(c.id, 'triaging', { user: admin, reason: 'seed' })
      await store.transition(c.id, 'in_progress', { user: admin, reason: 'seed' })
      await store.transition(c.id, 'resolved', { user: admin, reason: 'signed off' })
      const daysAgo = Math.floor(R() * 330)
      const evs = await store.listEvents(c.id)
      for (const e of evs) await store.t.update('event', e.id, { created_at: now - daysAgo * 86400 }, admin).catch(() => {})
      await store.t.update('case', c.id, { created_at: now - (daysAgo + 3) * 86400 }, admin).catch(() => {})
      made.resolved++
    } else if (bucket < 0.6) {
      await store.transition(c.id, 'triaging', { user: admin, reason: 'seed' })
      await store.transition(c.id, 'resolved', { user: admin, reason: 'seed' })
      await store.transition(c.id, 'closed', { user: admin, reason: 'closed from the console, no diagnosis' })
      made.closedNoDx++
    } else {
      if (bucket > 0.8) await store.transition(c.id, 'triaging', { user: admin, reason: 'seed' }).catch(() => {})
      await store.t.update('case', c.id, { created_at: now - Math.floor(R() * 200) * 86400 }, admin).catch(() => {})
      made.open++
    }
  }
  return made
}
