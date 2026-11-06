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

const ISSUES_GROUP_URL = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/

export function issuesGroupUrl(env = process.env) {
  const url = String(env.CASEY_ISSUES_GROUP_URL || '').trim()
  return ISSUES_GROUP_URL.test(url) ? url : ''
}

export async function issuesInviteDue(store, contact) {
  if (!contact?.id || !issuesGroupUrl()) return false
  const cases = await ownCases(store, contact)
  if (!cases.length) return false
  for (const c of cases) {
    if ((await store.listEvents(c.id)).some(e => evData(e).issues_invited === true)) return false
  }
  return true
}

export async function markIssuesInvited(store, contact) {
  const own = (await ownCases(store, contact))[0]
  if (!own) throw new Error('markIssuesInvited: this contact has no conversation to record the invite on')
  await store.appendEvent(own.id, { kind: 'observation', actor: 'system', text: 'ISSUES GROUP invite shown to this team member', data: { issues_invited: true, contact_id: contact.id }, touch: false })
}

const asList = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean)

export function helpFor(tier) {
  const { persona } = loadDomainConfig()
  const examples = atLeast(tier, TIER_ANIMAL_HEALTH_TECHNICIAN) ? persona.helpTechnician : persona.helpRanger
  if (!examples) throw new Error('persona.helpRanger/helpTechnician missing: add bot.help_ranger and bot.help_technician to vocabulary.yml')
  return { examples: asList(examples), onboarding: persona.helpOnboarding ? String(asList(persona.helpOnboarding).join(' ')) : '' }
}
