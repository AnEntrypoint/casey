// Mounts a declarative route table onto the Express app.
//
// Every route module used to be one exported register* function holding every
// handler for that surface inside a single closure -- 570 lines for operations,
// 358 for reports -- which is what put the load-bearing PII projections in the
// same scope as the twenty handlers that must use them, and is the arrangement
// that let PATCH /api/cases/:id ship a raw thatcher row past a green lint. A
// module is now a set of module-level named handler factories plus one of these
// tables, so a projection is a single named module-level definition a handler
// has to reach for deliberately rather than a binding that happens to be in
// scope.
//
// A table entry is [method, path, factory] plus an optional
// { raw: true } for a handler that owns its own try/catch envelope instead of
// deps.wrap's 500-on-throw one -- the account/contact mutation routes answer
// 400 with the error message, so wrapping them would change their status code.
// factory(deps) returns the real (req, res) handler; deps is the shared closure
// surface server.js assembles, so injection still happens at registration time
// and no module-level global state is introduced.
export function mountRoutes(app, deps, routes) {
  for (const [method, path, factory, opts] of routes) {
    const handler = factory(deps)
    app[method](path, opts && opts.raw ? handler : deps.wrap(handler))
  }
}
