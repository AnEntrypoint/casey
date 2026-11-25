export function inheritedSockets(env, pid) {
  if (env.LISTEN_PID !== String(pid)) return []
  const count = Number(env.LISTEN_FDS || 0)
  const names = String(env.LISTEN_FDNAMES || '').split(':')
  const out = []
  for (let i = 0; i < count; i++) {
    const name = names[i] || ''
    if (/^\d+$/.test(name)) out.push({ fd: 3 + i, port: Number(name) })
  }
  return out
}

export function childSocketEnv(env, sockets) {
  const out = { ...env }
  for (const k of ['LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES']) delete out[k]
  if (sockets.length) out.CASEY_INHERITED_LISTEN = sockets.map((s) => `${s.port}=${s.fd}`).join(',')
  return out
}
