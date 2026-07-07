---
key: mem-fed3d3e18dca7f41-529
ns: default
created: 1783421119837
updated: 1783421119837
---

## Resolved mutable: mut-shim-staleness

thatcher git log commit f751ffa 'feat(query): operator where, array sort, and row-access on the list read path', released as v1.0.30 per chore(release) chain. Installed casey/node_modules/thatcher/package.json version=1.0.37 (7 releases past). thatcher/src/lib/busybase-store.js:88-147 implements $ne/$gte/$lte/$in/$or operator compiler, confirmed live. Shim (_thatcherSupportsOperators, casey/src/case-store.js:556-565) is permanently dead-true against casey's actual npm-latest install.
