// sim/scenarios.js  --  named multi-turn personas for low-literacy contacts.
//
// casey's contacts are not power users. They message over WhatsApp in broken
// English, in another language, with one word, with only emoji, while
// frustrated, or while asking for a real person. These personas let
// `casey sim --scenario <name>` and the test suite replay those conversations
// against the stub LLM so we can prove casey always answers, stays plain, cites
// a reference, and offers a person when asked.
//
// Each persona is { name, description, lines:[...] } where `lines` is an array
// of contact messages injected in order, exactly like the default sim script.
// Keep these deterministic: no randomness, fixed lines.

export const SCENARIOS = {
  'confused-elderly': {
    name: 'confused-elderly',
    description: 'Vague, polite, one-word replies. Unsure what is going on.',
    lines: ['hello', 'my thing is not working', 'yes', 'thank you dear'],
  },
  'non-english-spanish': {
    name: 'non-english-spanish',
    description: 'Writes only in Spanish. Reporting a late order.',
    lines: ['hola, mi pedido no ha llegado', 'lo necesito pronto por favor', 'gracias'],
  },
  'emoji-only': {
    name: 'emoji-only',
    description: 'Communicates almost entirely with emoji and punctuation.',
    lines: ['????', 'sad sad sad', '???'],
  },
  'impatient': {
    name: 'impatient',
    description: 'Frustrated. Repeats "any update" with rising urgency.',
    lines: ['hi my order is late', 'any update', 'still waiting', 'how long more'],
  },
  'asks-for-human': {
    name: 'asks-for-human',
    description: 'Does not want a bot. Asks to talk to a real person.',
    lines: ['i need help', 'can i talk to a real person', 'i want a human please'],
  },
  'broken-grammar-order-late': {
    name: 'broken-grammar-order-late',
    description: 'Non-native, broken grammar, order is late.',
    lines: ['order no come yet many day', 'when it arrive me', 'please you help fast'],
  },
  'full-lifecycle': {
    name: 'full-lifecycle',
    description: 'End-to-end: intake, a status check, then asks for a human. The operator side is driven by the test via the dashboard API.',
    lines: ['hi my parcel never arrived', 'any update please', 'i want to speak to a real person'],
  },
  'false-positive-guard': {
    name: 'false-positive-guard',
    description: 'Real complaints that merely contain trigger substrings (personal/stopped/updated). With word-boundary intent matching these must reach the agent, never a stop/handoff shortcut.',
    lines: ['my personal details are wrong on the order', 'the website stopped my payment', 'the courier updated nothing and lost my package'],
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
