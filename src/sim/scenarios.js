// sim/scenarios.js  --  named multi-turn personas for low-literacy farmers and
// field workers reporting sick animals over WhatsApp.
//
// casey's contacts are remote South African farmers. They message in broken
// English, in an SA language, one word at a time, with a photo only, while
// worried, or while asking for a real person. These personas let
// `casey sim --scenario <name>` and the test suite replay those conversations
// so we can prove casey always answers, stays plain and calm, never alarms or
// diagnoses, cites a reference, offers a person when asked, and quietly gathers
// the report without interrogating.
//
// Each persona is { name, description, lines:[...] } where `lines` is an array
// of contact messages injected in order, exactly like the default sim script.
// Keep these deterministic: no randomness, fixed lines.

export const SCENARIOS = {
  'confused-elderly': {
    name: 'confused-elderly',
    description: 'Vague, polite, one-word replies. An older farmer unsure how to explain.',
    lines: ['hello', 'my cows are not well', 'yes', 'thank you my child'],
  },
  'fmd-cattle': {
    name: 'fmd-cattle',
    description: 'Classic foot-and-mouth signs in cattle, told over several short messages.',
    lines: ['my cattle are drooling badly and limping', 'some have blisters in the mouth', 'about ten of them', 'thank you'],
  },
  'sudden-deaths': {
    name: 'sudden-deaths',
    description: 'Sudden livestock deaths -- the bot must record, stay calm, and never diagnose or alarm.',
    lines: ['three of my goats died in the night', 'they were fine yesterday', 'what is happening'],
  },
  'afrikaans-farmer': {
    name: 'afrikaans-farmer',
    description: 'Writes in Afrikaans. Reporting sick cattle.',
    lines: ['my beeste is siek, hulle kwyl baie', 'twee het vannag gevrek', 'dankie'],
  },
  'isizulu-farmer': {
    name: 'isizulu-farmer',
    description: 'Writes in isiZulu. Reporting sick cattle.',
    lines: ['izinkomo zami ziyagula, zikhipha amathe', 'ngicela usizo', 'ngiyabonga'],
  },
  'photo-only': {
    name: 'photo-only',
    description: 'Sends a photo of an animal with almost no words. casey must acknowledge the photo warmly.',
    lines: ['[image]', 'see this', '[image]'],
  },
  'location-logistics': {
    name: 'location-logistics',
    description: 'Far in the bush: gives a vague location and is hard to reach on arrival.',
    lines: ['my sheep are sick', 'i am far past Musina near the river', 'i wont be home tomorrow, call my brother on the other number'],
  },
  'asks-for-human': {
    name: 'asks-for-human',
    description: 'Wants a real person, not a bot.',
    lines: ['i need help with my animals', 'can i talk to a real person', 'i want a human please'],
  },
  'full-lifecycle': {
    name: 'full-lifecycle',
    description: 'End-to-end: report intake, a status check, then asks for a human. The operator side is driven by the test via the dashboard API.',
    lines: ['my cattle are sick and some died', 'any news please', 'i want to speak to a real person'],
  },
  'false-positive-guard': {
    name: 'false-positive-guard',
    description: 'Reports that merely contain trigger substrings (personal/stopped/updated). With word-boundary intent matching these must reach the agent, never a stop/handoff shortcut.',
    lines: ['my personal herd is the one affected', 'the cow stopped eating completely', 'nothing updated since the sickness started'],
  },
  'one-question-at-a-time': {
    name: 'one-question-at-a-time',
    description: 'Two key facts (species and location) are both missing after the first message. The agent must ask at most one question per reply, never a list. Verifiable: each agent reply must contain at most one question mark.',
    lines: ['some of my animals are very sick', 'cattle', 'near Bela-Bela on the farm road'],
  },
  'language-mirror-zulu': {
    name: 'language-mirror-zulu',
    description: 'Contact writes in isiZulu throughout. Agent must reply in isiZulu, not switch to English. Verifiable: replies must not be pure English when isiZulu words are in the input.',
    lines: ['izinkomo zami ziyagula kakhulu', 'ziyakhipha amathe futhi zikhomba imizwa yobuhlungu', 'ngiyabonga'],
  },
  'language-mirror-afrikaans': {
    name: 'language-mirror-afrikaans',
    description: 'Contact writes in Afrikaans. Agent must reply in Afrikaans.',
    lines: ['my beeste is baie siek vandag', 'hulle eet nie meer nie en staan net stil', 'dankie broer'],
  },
  'mixed-language': {
    name: 'mixed-language',
    description: 'Contact switches between isiZulu and broken English mid-conversation. Agent mirrors each message in the language it was written in.',
    lines: ['izinkomo zami ziyagula', 'they drooling a lot and some are limping', 'ngiyabonga ngomuntu ozosiza'],
  },
  'vc-collection': {
    name: 'vc-collection',
    description: 'Starts with one vague line; reveals species, location, symptoms, and visit logistics across five messages. Verifies the agent asks for missing VC fields one at a time, never repeats a gathered field, and closes warmly once all six visit-critical fields are in.',
    lines: [
      'my cattle are sick',
      'they are drooling and not eating',
      'the farm is on the R33 road near Marble Hall, look for the blue gate',
      'yes i will be here all day, my number is this one',
      'no other contact but my wife is also here',
    ],
  },
}

// Return a persona by name (case-insensitive), or null.
export function getScenario(name) {
  if (!name) return null
  const key = Object.keys(SCENARIOS).find(k => k.toLowerCase() === String(name).toLowerCase())
  return key ? SCENARIOS[key] : null
}

// All persona names, for help text and listing.
export function scenarioNames() {
  return Object.keys(SCENARIOS)
}
