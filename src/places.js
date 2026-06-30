// places.js -- South African place understanding for worker enquiries.
//
// A worker asks "any cases in kzn" / "anything in the eastern cape" / "reports in
// margate". memobot must understand that kzn = KwaZulu-Natal (a province), that
// margate is a KZN town, and answer from the case store -- not deflect with a canned
// "I do not have that to hand". This module owns the SA province vocabulary (every
// common abbreviation/nickname + major towns) and a resolver that turns a free-text
// place into the set of location substrings to match a case's free-text location
// against. Pure, dependency-free, ASCII -- no geocoder, no network.
//
// STRONG vs WEAK terms govern when a bare place (no "cases"/"reports" word) is enough
// to read the message as an enquiry: a province name/alias (>=3 chars or multi-word)
// is STRONG and stands alone ("eastern cape"); a short 2-char alias (pe/ec/...) or a
// single common-word town (springs/douglas/middelburg) is WEAK and matched
// word-boundary-only so it never fires inside unrelated prose ("specimen", "recent").

const PROVINCES = {
  'KwaZulu-Natal': {
    aliases: ['kzn', 'kwazulu natal', 'kwazulu-natal', 'kwa zulu', 'kwa-zulu', 'natal', 'kn'],
    towns: ['durban', 'ethekwini', 'pietermaritzburg', 'pmb', 'maritzburg', 'newcastle',
            'richards bay', 'ladysmith', 'margate', 'port shepstone', 'ulundi', 'empangeni',
            'estcourt', 'vryheid', 'kokstad', 'howick', 'eshowe', 'dundee'],
  },
  'Eastern Cape': {
    aliases: ['ec', 'e cape', 'e.cape', 'eastern cape', 'transkei', 'ciskei'],
    towns: ['gqeberha', 'port elizabeth', 'pe', 'east london', 'mthatha', 'umtata', 'bhisho', 'bisho',
            "king william's town", 'qonce', 'grahamstown', 'makhanda', 'queenstown', 'komani',
            'uitenhage', 'kariega', 'butterworth', 'cradock', 'aliwal north', 'graaff-reinet',
            'port st johns', 'mdantsane', 'middelburg'],
  },
  'Gauteng': {
    aliases: ['gp', 'gauteng', 'gt', 'pwv', 'egoli'],
    towns: ['johannesburg', 'joburg', 'jozi', 'jhb', 'pretoria', 'tshwane', 'soweto', 'vereeniging',
            'vanderbijlpark', 'benoni', 'boksburg', 'germiston', 'kempton park', 'krugersdorp',
            'mogale city', 'randburg', 'sandton', 'midrand', 'roodepoort', 'springs', 'centurion'],
  },
  'Western Cape': {
    aliases: ['wc', 'w cape', 'w.cape', 'western cape', 'wp'],
    towns: ['cape town', 'kaapstad', 'cpt', 'stellenbosch', 'paarl', 'george', 'worcester',
            'mossel bay', 'knysna', 'oudtshoorn', 'beaufort west', 'hermanus', 'saldanha',
            'vredenburg', 'caledon', 'swellendam', 'malmesbury'],
  },
  'North West': {
    aliases: ['nw', 'n west', 'n.west', 'north west', 'north-west', 'nwp'],
    towns: ['mahikeng', 'mafikeng', 'mmabatho', 'rustenburg', 'potchefstroom', 'potch', 'klerksdorp',
            'brits', 'lichtenburg', 'vryburg', 'zeerust', 'wolmaransstad', 'schweizer-reneke',
            'ventersdorp'],
  },
  'Free State': {
    aliases: ['fs', 'free state', 'freestate', 'ofs', 'vrystaat'],
    towns: ['bloemfontein', 'bloem', 'mangaung', 'welkom', 'bethlehem', 'kroonstad', 'sasolburg',
            'phuthaditjhaba', 'qwaqwa', 'harrismith', 'parys', 'virginia', 'ladybrand', 'ficksburg',
            'botshabelo', 'frankfort'],
  },
  'Mpumalanga': {
    aliases: ['mp', 'mpuma', 'mpumalanga', 'et'],
    towns: ['mbombela', 'nelspruit', 'witbank', 'emalahleni', 'middelburg', 'secunda', 'ermelo',
            'standerton', 'barberton', 'sabie', 'white river', 'bethal', 'komatipoort', 'hazyview',
            'piet retief', 'emkhondo', 'lydenburg', 'mashishing'],
  },
  'Limpopo': {
    aliases: ['lp', 'limpopo', 'np', 'nt'],
    towns: ['polokwane', 'pietersburg', 'musina', 'messina', 'tzaneen', 'thohoyandou', 'mokopane',
            'potgietersrus', 'bela-bela', 'warmbaths', 'modimolle', 'nylstroom', 'lephalale',
            'ellisras', 'phalaborwa', 'giyani', 'louis trichardt', 'makhado', 'hoedspruit',
            'burgersfort'],
  },
  'Northern Cape': {
    aliases: ['nc', 'n cape', 'n.cape', 'northern cape'],
    towns: ['kimberley', 'upington', 'kuruman', 'de aar', 'springbok', 'kathu', 'postmasburg',
            'colesberg', 'calvinia', 'douglas', 'hartswater', 'prieska', 'kakamas'],
  },
}

// term -> Set(province): every alias + town + the canonical province name (lowercased)
// points at the province(s) it belongs to (an ambiguous town like 'middelburg' points
// at two). province -> [all its terms]: the expansion used to match case locations.
const TERM_TO_REGIONS = new Map()
const REGION_TERMS = new Map()
for (const [region, { aliases, towns }] of Object.entries(PROVINCES)) {
  const terms = [region.toLowerCase(), ...aliases, ...towns]
  REGION_TERMS.set(region, terms)
  for (const term of terms) {
    if (!TERM_TO_REGIONS.has(term)) TERM_TO_REGIONS.set(term, new Set())
    TERM_TO_REGIONS.get(term).add(region)
  }
}
// Terms sorted longest-first so a multi-word match ('eastern cape') is preferred over
// a contained short one ('ec' would never be tested first).
const TERMS_BY_LEN = [...TERM_TO_REGIONS.keys()].sort((a, b) => b.length - a.length)

// A term is STRONG (stands alone as an enquiry signal without a "cases"/"reports"
// word) when it is unambiguous enough: a multi-word term, OR a canonical province
// name, OR a province alias of >= 3 chars. A <= 2-char alias (pe/ec/mp/...) or a
// single-word common-noun town (springs/douglas/middelburg) is WEAK -- it needs the
// "cases"/"reports" context (or a boundary hit in a place query) to count.
const CANONICAL = new Set(Object.keys(PROVINCES).map(r => r.toLowerCase()))
const ALIAS_SET = new Set(Object.values(PROVINCES).flatMap(p => p.aliases))
function isStrong(term) {
  if (term.includes(' ')) return true
  if (CANONICAL.has(term)) return true
  if (ALIAS_SET.has(term) && term.length >= 3) return true
  return false
}

// Word-boundary contains: pad both sides with a space and test for ` term `, so a
// short term never substring-matches inside a longer word ('pe' in 'specimen', 'ec'
// in 'recent', 'natal' in 'prenatal'). Non-letter separators in the haystack are
// normalised to spaces first so 'durban,' or 'in-kzn' still hit.
export function containsTerm(hay, term) {
  if (!hay || !term) return false
  const h = ' ' + String(hay).toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ') + ' '
  return h.includes(' ' + term + ' ')
}

// Resolve a free-text place to the regions it names and the full set of match terms.
// Returns null when nothing matched. matchedAlias is the longest matched term (a
// TERM_TO_REGIONS key) so a caller can re-expand it. strong is true when ANY matched
// term is STRONG (lets a bare 'eastern cape' classify as an enquiry on its own).
export function resolvePlace(text) {
  const t = String(text || '').toLowerCase()
  if (!t.trim()) return null
  const regions = new Set()
  let matchedAlias = null
  let strong = false
  for (const term of TERMS_BY_LEN) {
    if (!containsTerm(t, term)) continue
    for (const r of TERM_TO_REGIONS.get(term)) regions.add(r)
    if (matchedAlias == null) matchedAlias = term   // longest, by sort order
    if (isStrong(term)) strong = true
  }
  if (!regions.size) return null
  const terms = [...new Set([...regions].flatMap(r => REGION_TERMS.get(r)))]
  return { regions: [...regions], terms, matchedAlias, strong }
}

// A human label for the resolved regions: 'KwaZulu-Natal', or 'Mpumalanga / Eastern
// Cape' for an ambiguous town that spans two.
export function placeRegionLabel(regions) {
  if (!Array.isArray(regions) || !regions.length) return ''
  return regions.join(' / ')
}

export { PROVINCES }
