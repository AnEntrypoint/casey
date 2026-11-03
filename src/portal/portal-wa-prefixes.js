const DAY_MS = 24 * 3600e3
const FETCH_TIMEOUT_MS = 20e3
export const WA_MIN_PREFIXES = 20
const RIPE_ANNOUNCED = 'https://stat.ripe.net/data/announced-prefixes/data.json'

const octetOk = (text) => /^\d{1,3}$/.test(text) && Number(text) <= 255

export function isIpv4Cidr(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(value))
  if (!match) return false
  const [, a, b, c, d, mask] = match
  return [a, b, c, d].every(octetOk) && Number(mask) <= 32
}

export function announcedIpv4(body) {
  const entries = body?.data?.prefixes
  if (!Array.isArray(entries)) return null
  return [...new Set(entries.map(entry => entry?.prefix).filter(isIpv4Cidr))].sort()
}

export const waPrefixesText = (prefixes) => prefixes.join('\n') + '\n'

export function createWaPrefixSource({ fetchImpl = fetch, now = Date.now, ttlMs = DAY_MS } = {}) {
  const cache = new Map()
  return async function waPrefixes(asn) {
    if (!/^AS\d+$/.test(asn)) throw new Error('wa_asn must look like AS32934')
    const cached = cache.get(asn)
    if (cached && now() - cached.fetchedAt < ttlMs) return cached.prefixes
    try {
      const res = await fetchImpl(`${RIPE_ANNOUNCED}?resource=${asn}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`RIPEstat answered ${res.status}`)
      const prefixes = announcedIpv4(await res.json())
      if (!prefixes || prefixes.length < WA_MIN_PREFIXES) throw new Error(`only ${prefixes?.length ?? 0} IPv4 prefixes`)
      cache.set(asn, { prefixes, fetchedAt: now() })
      return prefixes
    } catch (error) {
      if (cached) return cached.prefixes
      throw error
    }
  }
}
