// gazetteer.js -- MAP-ONLY approximate coordinates for South African towns/areas,
// used solely to place a case pin when the report carries no explicit lat/lon.
//
// This is NOT the chat-routing gazetteer AGENTS.md forbids (no province->town
// lookup drives what the agent says or how case_list matches a location -- that
// stays a literal $ilike substring match, per the layering mandate). This table
// only turns a free-text location into an approximate point for the map view; it
// never feeds the conversation or a tool response the contact sees. A miss is
// never guessed -- the caller buckets it into the "unknown" group, exactly like
// geo.js's existing hotspot rollup.
//
// Coordinates are town-centroid approximations (a few km of slop), adequate for
// an area-level map, never precise enough to pinpoint a farm -- the case's own
// `lat`/`lon` fields (thatcher.config.yml case entity) take priority when a
// worker has actually given GPS; this is only the fallback.

import { tokens } from './correlate.js'

// [lat, lon] centroids for South African provinces/major towns most likely to
// appear in a livestock report's free-text location. Deliberately small and
// hand-curated -- add towns as real reports surface them, never auto-scraped.
const TOWNS = {
  // Provinces (coarsest fallback bucket)
  limpopo: [-23.4013, 29.4179],
  mpumalanga: [-25.5653, 30.5279],
  gauteng: [-26.2708, 28.1123],
  kwazulunatal: [-28.5305, 30.8958],
  'kwazulu-natal': [-28.5305, 30.8958],
  kzn: [-28.5305, 30.8958],
  freestate: [-28.4541, 26.7968],
  'free-state': [-28.4541, 26.7968],
  easterncape: [-32.2968, 26.4194],
  'eastern-cape': [-32.2968, 26.4194],
  westerncape: [-33.2278, 21.8569],
  'western-cape': [-33.2278, 21.8569],
  northerncape: [-29.0467, 21.8569],
  'northern-cape': [-29.0467, 21.8569],
  northwest: [-26.6639, 25.2838],
  'north-west': [-26.6639, 25.2838],
  // Towns
  musina: [-22.3283, 30.0448],
  polokwane: [-23.9045, 29.4689],
  tzaneen: [-23.8330, 30.1633],
  giyani: [-23.3062, 30.7183],
  thohoyandou: [-22.9484, 30.4844],
  louistrichardt: [-23.0417, 29.9017],
  makhado: [-23.0417, 29.9017],
  nelspruit: [-25.4753, 30.9694],
  mbombela: [-25.4753, 30.9694],
  witbank: [-25.8707, 29.2344],
  emalahleni: [-25.8707, 29.2344],
  standerton: [-26.9333, 29.2500],
  ermelo: [-26.5333, 29.9833],
  pretoria: [-25.7479, 28.2293],
  tshwane: [-25.7479, 28.2293],
  johannesburg: [-26.2041, 28.0473],
  soweto: [-26.2678, 27.8585],
  durban: [-29.8587, 31.0218],
  ethekwini: [-29.8587, 31.0218],
  pietermaritzburg: [-29.6006, 30.3794],
  newcastle: [-27.7574, 29.9317],
  ladysmith: [-28.5578, 29.7808],
  richardsbay: [-28.7830, 32.0378],
  ulundi: [-28.3350, 31.4166],
  vryheid: [-27.7686, 30.7911],
  bloemfontein: [-29.0852, 26.1596],
  welkom: [-27.9769, 26.7314],
  bethlehem: [-28.2308, 28.3122],
  kroonstad: [-27.6528, 27.2350],
  eastlondon: [-33.0292, 27.8546],
  'east-london': [-33.0292, 27.8546],
  portelizabeth: [-33.9608, 25.6022],
  gqeberha: [-33.9608, 25.6022],
  mthatha: [-31.5889, 28.7844],
  queenstown: [-31.8976, 26.8753],
  komani: [-31.8976, 26.8753],
  capetown: [-33.9249, 18.4241],
  paarl: [-33.7342, 18.9621],
  worcester: [-33.6461, 19.4486],
  george: [-33.9628, 22.4619],
  beaufortwest: [-32.3567, 22.5811],
  kimberley: [-28.7282, 24.7499],
  upington: [-28.4478, 21.2561],
  springbok: [-29.6644, 17.8865],
  mahikeng: [-25.8560, 25.6403],
  mafikeng: [-25.8560, 25.6403],
  klerksdorp: [-26.8523, 26.6667],
  rustenburg: [-25.6672, 27.2424],
  potchefstroom: [-26.7145, 27.0980],
}

// Resolve a free-text location string to an approximate [lat, lon], or null if
// no token matches. tokens() splits on whitespace, so a two-word town name
// ("Louis Trichardt") never appears as a single token -- try every adjacent
// bigram (joined with no separator, matching this table's key style) before
// falling back to single tokens, so multi-word town names resolve too.
// Bigrams tried before single tokens so a specific two-word town wins over a
// coarser single-word province substring within the same string.
export function geocodeApprox(locationText) {
  const toks = [...tokens(locationText)]
  if (!toks.length) return null
  for (let i = 0; i < toks.length - 1; i++) {
    const bigram = toks[i] + toks[i + 1]
    if (TOWNS[bigram]) return TOWNS[bigram]
  }
  for (const t of toks) {
    if (TOWNS[t]) return TOWNS[t]
  }
  return null
}

export { TOWNS }
