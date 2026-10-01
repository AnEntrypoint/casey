// pin-estimate.js -- every case with a place on it gets a pin and a confidence for it.
//
// The agent is asked to give lat/lon and location_confidence itself when someone names a place (case_report). When
// it did not, this does it as ONE narrow model call from the model's own knowledge of the place: nothing is looked
// up, and the result is always marked 'estimated' with the confidence the model gave. A real reading (gps) or a
// confirmed pin is never touched, and a case a person has taken over (observe) is left alone.
import { isValidLatLon } from './case-tools-shared.js'
import { pinConfidence, placeText } from './pin-confidence.js'
export { placeText }

const AREA_HINT = () => String(process.env.CASEY_REGION_HINT || '').trim().slice(0, 120)

export async function estimatePin(callLLM, text) {
  const hint = AREA_HINT()
  const prompt = [
    'Estimate where a place is, from your own knowledge only (nothing can be looked up).',
    hint ? `The reports come from this area: ${hint}.` : null,
    `PLACE AS THE PERSON DESCRIBED IT: ${text}`,
    'Give your single best coordinates for the place, and how sure you are as a whole percentage: a named town or village you know well can be 60-90, a named farm, dip tank or school you can only place roughly 20-50, a description with no real place name 5-15.',
    hint ? 'If the description holds no place you can identify at all, give the centre of that area with a confidence of 1-5: a pin is always required.' : null,
    hint ? 'Respond with ONLY JSON: {"lat": <number>, "lon": <number>, "confidence": <1-99>}' : 'Respond with ONLY JSON: {"lat": <number>, "lon": <number>, "confidence": <1-99>}, or {"unknown": true} if it cannot be placed at all.',
  ].filter(Boolean).join('\n')
  const raw = String((await callLLM({ messages: [{ role: 'user', content: prompt }], tools: [] }))?.content || '')
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  const j = JSON.parse(m[0])
  if (j.unknown) return null
  const lat = Number(j.lat), lon = Number(j.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isValidLatLon(lat, lon) || (lat === 0 && lon === 0)) return null
  return { lat, lon, confidence: pinConfidence('estimated', j.confidence) }
}

// Gives this case a pin when it has a place and no pin, and REDOES an estimated pin when the place words have changed since it
// was worked out (the person gave a better description). A real reading (gps) or a confirmed pin is never touched.
// Returns the pin written, or null. Never throws.
export async function ensurePin({ store, callLLM, log, caseId }) {
  try {
    const c = await store.getCase(caseId)
    if (!c) return null
    const text = placeText(c)
    if (!text || typeof callLLM !== 'function') return null
    if (c.location_source === 'gps' || c.location_source === 'confirmed') return null
    const hasPin = c.lat != null && c.lon != null
    if (hasPin && c.location_basis === text) return null
    // A pin that holds no recorded basis was written by the agent with the place words as they stood: keep it, record the basis.
    if (hasPin && !c.location_basis) { await store.updateCaseChecked(caseId, { location_basis: text }).catch(() => {}); return null }
    const pin = await estimatePin(callLLM, text)
    if (!pin) return null
    const res = await store.updateCaseChecked(caseId, { lat: pin.lat, lon: pin.lon, location_source: 'estimated', location_confidence: pin.confidence, location_basis: text })
    if (res?.error) return null
    await store.appendEvent(caseId, { kind: 'observation', actor: 'system', text: `PIN ${hasPin ? 'REDONE' : 'ESTIMATED'}: lat ${pin.lat.toFixed(4)}, lon ${pin.lon.toFixed(4)}, ${pin.confidence}% sure, from the place as described ("${text.slice(0, 120)}"). A guess from general knowledge, not a reading.` })
    return pin
  } catch (e) {
    log?.warn?.('[casey] pin estimate failed', { caseId, error: e.message })
    return null
  }
}
