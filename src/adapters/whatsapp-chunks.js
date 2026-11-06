export const CHUNK_MAX = 3800
const NUMBER_PREFIX_RESERVE = 8
const LEVELS = [
  { split: /\n[ \t]*\n+/, join: '\n\n' },
  { split: /\n/, join: '\n' },
  { split: /(?<=[.!?])\s+/, join: ' ' },
  { split: /\s+/, join: ' ' },
]

function pack(text, max, level = 0) {
  if (text.length <= max) return [text]
  if (level >= LEVELS.length) throw new Error(`whatsapp chunking: a single word of ${text.length} characters cannot be split without breaking it (limit ${max})`)
  const { split, join } = LEVELS[level]
  const parts = text.split(split).map(p => p.trim()).filter(Boolean)
  const units = parts.length > 1 ? parts : [text]
  const out = []
  let cur = ''
  for (const unit of units) {
    const pieces = unit.length > max ? pack(unit, max, level + 1) : [unit]
    for (const piece of pieces) {
      if (cur && cur.length + join.length + piece.length <= max) cur += join + piece
      else { if (cur) out.push(cur); cur = piece }
    }
  }
  if (cur) out.push(cur)
  return out
}

export function splitForWhatsapp(text, max = CHUNK_MAX) {
  const body = String(text ?? '').trim()
  if (body.length <= max) return [body]
  const plain = pack(body, max)
  if (plain.length <= 2) return plain
  const chunks = pack(body, max - NUMBER_PREFIX_RESERVE)
  return chunks.map((c, i) => `${i + 1}/${chunks.length} ${c}`)
}
