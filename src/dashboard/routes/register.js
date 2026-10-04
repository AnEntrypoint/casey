export function mountRoutes(app, deps, routes) {
  for (const [method, path, factory, opts] of routes) {
    const handler = factory(deps)
    app[method](path, opts && opts.raw ? handler : deps.wrap(handler))
  }
}
