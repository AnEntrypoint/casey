import { evData } from './safe.js'
import { loadDomainConfig } from './config-loader.js'
import { atLeast, TIER_ANIMAL_HEALTH_TECHNICIAN } from './contact-tiers.js'

const OWN_CASE_CAP = 20

const ownCases = (store, contact) => store.listCases({ channel: contact.channel, external_id: contact.external_id }, { limit: OWN_CASE_CAP })

export async function firstTimeStaff(store, contact) {
  if (!contact?.id) return false
  if (contact.last_location_at) return false
  for (const c of await ownCases(store, contact)) {
    if ((await store.listEvents(c.id)).some(e => evData(e).onboarded === true)) return false
  }
  return true
}

export async function markOnboarded(store, contact) {
  const own = (await ownCases(store, contact))[0]
  if (!own) throw new Error('markOnboarded: this contact has no conversation to record the onboarding on')
  await store.appendEvent(own.id, { kind: 'observation', actor: 'system', text: 'ONBOARDING shown to this team member', data: { onboarded: true, contact_id: contact.id }, touch: false })
}

const asList = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean)

export function helpFor(tier) {
  const { persona } = loadDomainConfig()
  const examples = atLeast(tier, TIER_ANIMAL_HEALTH_TECHNICIAN) ? persona.helpTechnician : persona.helpRanger
  if (!examples) throw new Error('persona.helpRanger/helpTechnician missing: add bot.help_ranger and bot.help_technician to vocabulary.yml')
  return { examples: asList(examples), onboarding: persona.helpOnboarding ? String(asList(persona.helpOnboarding).join(' ')) : '' }
}
