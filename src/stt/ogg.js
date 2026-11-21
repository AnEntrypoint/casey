const OPUS_RATE = 48000

export function oggOpusDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.toString('latin1', 0, 4) !== 'OggS') return null
  const head = buffer.indexOf('OpusHead')
  if (head < 0 || head > 200) return null
  const preSkip = buffer.readUInt16LE(head + 10)
  let page = buffer.lastIndexOf('OggS')
  while (page >= 0 && !(buffer[page + 4] === 0 && page + 14 <= buffer.length)) page = page > 0 ? buffer.lastIndexOf('OggS', page - 1) : -1
  if (page < 0) return null
  const granule = buffer.readBigInt64LE(page + 6)
  if (granule < 0n) return null
  return Math.max(0, (Number(granule) - preSkip) / OPUS_RATE)
}
