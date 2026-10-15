const LOGGED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ID_LIKE_SEGMENT = /\d|^.{20,}$/

export function routeTemplate(req) {
  const base = req.baseUrl || ''
  if (typeof req.route?.path === 'string') return `${base}${req.route.path}`.slice(0, 200)
  const pathOnly = String(req.originalUrl || req.url || '').split('?')[0]
  return pathOnly
    .split('/')
    .map(seg => (ID_LIKE_SEGMENT.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 200)
}

export function guiActionLogger() {
  return (req, res, next) => {
    if (!LOGGED_METHODS.has(req.method)) return next()
    const startedAt = Date.now()
    res.once('finish', () => {
      try {
        console.log(JSON.stringify({
          t: new Date().toISOString(), level: 'info', component: 'dashboard', msg: 'gui_action',
          method: req.method,
          route: routeTemplate(req),
          status: res.statusCode,
          operator: req.caseyAccount?.username ?? null,
          duration_ms: Date.now() - startedAt,
        }))
      } catch {}
    })
    next()
  }
}
