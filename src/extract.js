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

  // Species -- English, Afrikaans (beeste=cattle, skape=sheep, varke=pigs),
  // isiZulu/isiXhosa (izinkomo/iinkomo=cattle, izimvu=sheep).
  const SPECIES = ['cattle', 'cow', 'cows', 'sheep', 'goat', 'goats', 'pig', 'pigs',
    'beeste', 'skape', 'varke', 'izinkomo', 'iinkomo', 'izimvu']
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
  const word = SYMPTOM_WORDS.find(s => new RegExp(`\\b${escapeRe(s)}\\b`).test(t))
  if (phrase) f.symptoms = phrase
  else if (word) f.symptoms = word

  // Counts -- numbers written as digits or common English words.
  const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  let num = null
  const digitMatch = (t.match(/\b(\d+)\b/) || [])[1]
  if (digitMatch) {
    num = digitMatch
  } else {
    const wordMatch = Object.keys(WORD_NUMS).find(w => new RegExp(`\\b${w}\\b`).test(t))
    if (wordMatch) num = String(WORD_NUMS[wordMatch])
  }
  const isDeath = /\b(died|dead|dood|gevrek)\b/.test(t)
  if (num && isDeath) f.dead_count = num
  else if (num) f.affected_count = num
  if (isDeath) f.dead_count = f.dead_count || 'some'

  // Location -- "near X", "farm X", "on the R\d+ road", "X area", "past X". Reject
  // a captured token that is only a greeting/help word ("in Casey" from "Hi Casey").
  const locPat = /\b(?:near|past|from|at|on the|in|by)\s+([A-Z][a-zA-Z\s\-]{2,30}?)(?:\s*,|\s*\.|$)/
  const locMatch = raw.match(locPat)
  if (locMatch && !STOP_WORDS.has(locMatch[1].trim().toLowerCase())) {
    f.location = locMatch[1].trim()
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
