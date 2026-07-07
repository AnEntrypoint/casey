---
key: mem-d03e5eda0ed022cd-378
ns: default
created: 1780947869171
updated: 1780947869171
---

## Resolved mutable: thatcher-public-count-exists

node_modules/thatcher/src/index.js:288-318 public Thatcher exposes list/get/create/update/delete/search but NO count. query-engine.js:154 count() exists internally; methods use await import(resolveModule(...)) so adding a count method to Thatcher shares the same module singleton (no DB fork). Fix: add count to Thatcher class.
