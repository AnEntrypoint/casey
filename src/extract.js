// extract.js -- deterministic, dependency-free field extraction from a plain
// contact message. Shared by the live inbound handler (gateway-hooks.js) and the
// offline stub model (sim/stub-llm.js) so both use IDENTICAL extraction.
//
// Why this exists in the LIVE path, not just the sim: the production model is a
// small local model (llama3.1-8B) that does NOT reliably call the case_report
// tool, so left to the model a real conversation logs an empty case. casey runs
// extractFields on EVERY inbound turn and records whatever the contact plainly
// stated, so a case is never an empty shell even when the model drives nothing.
//
// Deterministic and shallow on purpose -- it captures only what is unambiguous in
// the words. The real model still does the rich extraction when it cooperates;
// this is the floor, not the ceiling. Additive merging is the caller's job.

// Hard bound on the text we scan. Contact input is adversarial in the live path;
// a multi-kilobyte message must not feed the regexes an unbounded string (cheap
// ReDoS guard -- the patterns are linear but the input should still be bounded).
const MAX_SCAN = 2000

// Greeting/help words that must never be mistaken for a location or name. A
// message like "Hi Casey" must not yield location/contact_name = "Casey".
const STOP_WORDS = new Set([
  'hi', 'hey', 'hello', 'hallo', 'molo', 'sawubona', 'help', 'casey', 'memobot',
  'please', 'thanks', 'thank', 'good', 'morning', 'afternoon', 'evening',
])

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractFields(text) {
  const raw = (text || '').slice(0, MAX_SCAN)
  const t = raw.toLowerCase()
  const f = {}
  if (!t.trim()) return f

  // Species -- English, Afrikaans (beeste=cattle, skape=sheep, varke=pigs,
  // perd=horse, esel=donkey, hoender=chicken), isiZulu/isiXhosa
  // (izinkomo/iinkomo=cattle, izimvu/iimvu=sheep, imbongolo=donkey,
  // inkukhu=chicken). Horse/donkey/chicken/poultry are commonly reported in this
  // surveillance context and were silently dropped, so intake kept re-asking
  // "which animals" for an animal the farmer had already named.
  const SPECIES = ['cattle', 'cow', 'cows', 'sheep', 'goat', 'goats', 'pig', 'pigs',
    'horse', 'horses', 'donkey', 'donkeys', 'chicken', 'chickens', 'poultry',
    'beeste', 'skape', 'varke', 'perd', 'esel', 'hoender',
    'izinkomo', 'iinkomo', 'izimvu', 'iimvu', 'imbongolo', 'inkukhu']
  const species = SPECIES.find(s => new RegExp(`\\b${s}\\b`).test(t))
  if (species) f.species = species

  // Symptoms -- single words plus common multi-word signs a farmer describes.
  // Eye/discharge/swelling phrases were missing and are real signs ("blue eyes",
  // "cloudy eyes", "swollen", "discharge"); include them so a symptom-only
  // message ("blue eyes") is captured, not dropped.
  const SYMPTOM_PHRASES = [
    'blue eye', 'blue eyes', 'cloudy eye', 'cloudy eyes', 'red eye', 'watery eye',
    'eye discharge', 'discharge', 'swollen', 'swelling', 'bleeding', 'foaming',
    'foam at the mouth', 'not eating', 'not drinking', 'eet nie', 'cant walk',
    "can't walk", 'falling over', 'coughing', 'diarrhoea', 'diarrhea', 'fever',
  ]
  const SYMPTOM_WORDS = ['drool', 'blister', 'limp', 'lame', 'died', 'dying', 'sick',
    'siek', 'gula', 'kwyl', 'kreupel', 'amathe']
  const phrase = SYMPTOM_PHRASES.find(s => t.includes(s))
  // Stem match: a farmer writes "limping", "drooling", "blisters" -- match the
  // stem at a word boundary so the inflected form is still captured, not dropped.
  const word = SYMPTOM_WORDS.find(s => new RegExp(`\\b${escapeRe(s)}`).test(t))
  if (phrase) f.symptoms = phrase
  else if (word) f.symptoms = word

  // Counts -- numbers written as digits or common English words. Collect ALL of
  // them WITH their character offsets, because a single message often states two
  // distinct facts -- a herd total and a smaller death count ("I have 100 cattle
  // and 3 died"). Taking the first number for dead_count recorded the herd size
  // as deaths and dropped the real count, a WRONG visit-critical fact that then
  // stopped intake from asking. So when there is a death word and >=2 numbers,
  // bind dead_count to the number nearest the death word and affected_count to
  // another. With exactly one number the original behaviour is preserved.
  const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  const nums = []   // { value: string, at: charOffset }
  for (const m of t.matchAll(/\b(\d+)\b/g)) nums.push({ value: m[1], at: m.index })
  for (const [w, v] of Object.entries(WORD_NUMS)) {
    const m = new RegExp(`\\b${w}\\b`).exec(t)
    if (m) nums.push({ value: String(v), at: m.index })
  }
  nums.sort((a, b) => a.at - b.at)
  const deathMatch = /\b(died|dead|dood|gevrek)\b/.exec(t)
  const isDeath = !!deathMatch
  if (isDeath && nums.length >= 2) {
    // Number closest to the death word is the death count; the earliest remaining
    // number (typically the herd total, stated first) is the affected count.
    const deathAt = deathMatch.index
    const nearest = nums.reduce((best, n) =>
      Math.abs(n.at - deathAt) < Math.abs(best.at - deathAt) ? n : best)
    f.dead_count = nearest.value
    const other = nums.find(n => n !== nearest)
    if (other) f.affected_count = other.value
  } else if (nums.length) {
    const num = nums[0].value
    if (isDeath) f.dead_count = num
    else f.affected_count = num
  }
  if (isDeath) f.dead_count = f.dead_count || 'some'

  // Location -- "near X", "farm X", "on the R\d+ road", "X area", "past X". Reject
  // a captured token that is only a greeting/help word ("in Casey" from "Hi Casey").
  const locPat = /\b(?:near|past|from|at|on the|in|by)\s+([A-Z][a-zA-Z\s\-]{2,30}?)(?:\s*,|\s*\.|$)/
  const locMatch = raw.match(locPat)
  if (locMatch && !STOP_WORDS.has(locMatch[1].trim().toLowerCase())) {
    // Cut the captured place at the first temporal/clause word so a run-on like
    // "Musina since Monday" yields the place "Musina", not the whole tail.
    f.location = locMatch[1]
      .split(/\s+(?:since|started|from|near|past|and|but|because|they|we|it|my)\b/i)[0]
      .trim()
      // Drop a trailing place-type noun so "Greenvalley farm" stores as the bare
      // place "Greenvalley" -- the locPat branch pre-empts the farmMatch branch
      // below, so without this the generic suffix leaked into the stored location
      // and into any later equality/cluster matching on it.
      .replace(/\s+(?:farm|area|plaas|dorp)$/i, '')
      .trim()
  }
  if (!f.location) {
    const farmMatch = raw.match(/\b([A-Z][a-zA-Z\s]{2,20})\s+(?:farm|area|dorp|plaas)\b/i)
    if (farmMatch && !STOP_WORDS.has(farmMatch[1].trim().toLowerCase())) {
      f.location = farmMatch[1].trim()
    }
  }

  // Onset -- "started yesterday", "since Monday", "X days ago", "last week".
  const onsetPat = /\b(?:since|started|since last|from)\s+(yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|last\s+\w+|\d+\s+days?\s+ago)/i
  const onsetMatch = raw.match(onsetPat)
  if (onsetMatch) f.onset = onsetMatch[1].trim()
  else if (/\b\d+\s+days?\s+ago\b/i.test(raw)) {
    f.onset = (raw.match(/(\d+\s+days?\s+ago)/i) || [])[1]
  } else if (/\byesterday\b/.test(t)) f.onset = 'yesterday'

  // Contact name -- "my name is X", "I am X", "This is X". Reject a stop-word.
  const namePat = /(?:my name is|i am|this is|naam is)\s+([A-Z][a-zA-Z]{1,20}(?:\s+[A-Z][a-zA-Z]{1,20})?)/i
  const nameMatch = raw.match(namePat)
  if (nameMatch && !STOP_WORDS.has(nameMatch[1].trim().toLowerCase())) {
    f.contact_name = nameMatch[1].trim()
  }

  return f
}
