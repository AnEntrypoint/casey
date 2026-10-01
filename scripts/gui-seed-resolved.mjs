

const DISEASES = [
  ['Foot and mouth disease', 30], ['Anthrax', 8], ['Lumpy skin disease', 26], ['Newcastle disease', 14],
  ['Brucellosis', 9], ['Heartwater', 16], ['Pulpy kidney', 6], ['Rift Valley fever', 3], ['Ticks and tick-borne disease', 12],
]
const AREAS = [
  ['Upper Lambasi', -31.55, 29.35, 22], ['Lower Lambasi', -31.62, 29.42, 16], ['Ngqeleni', -31.68, 29.03, 18],
  ['Libode', -31.55, 29.04, 12], ['Port St Johns', -31.63, 29.54, 14], ['Lusikisiki', -31.36, 29.58, 10],
  ['Bizana', -30.85, 29.86, 7], ['Flagstaff', -31.08, 29.49, 2],
]
const SPECIES = ['cattle', 'goats', 'sheep', 'chickens', 'pigs']
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
    const report = { species, symptoms: 'sores and limping', location: 'Near the ' + area + ' clinic, call 0' + (820000000 + i), association: area }
    const noLoc = bucket > 0.9
    await store.mergeReport(c.id, report, { id: 'seed', role: 'agent' })
    await store.updateCase(c.id, noLoc ? {} : { lat: lat + (R() - 0.5) * 0.15, lon: lon + (R() - 0.5) * 0.15, location_source: 'estimated' }, admin)
    if (noLoc) made.noLocation++
    if (bucket < 0.5) {

      await store.mergeReport(c.id, { identified_disease: disease, recommended_resolution: 'Vaccinate the herd and move no animals for 14 days' }, { id: 'aht', role: 'operator' }, { bypassObserve: true, autoAssign: false })
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
