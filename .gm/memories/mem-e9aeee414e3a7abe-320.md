---
key: mem-e9aeee414e3a7abe-320
ns: default
created: 1783680910027
updated: 1783680910027
---

casey src/case-store.js mergeReport: retry-on-conflict now passes expectedVersion on every retry attempt (bounded, MERGE_RETRY_LIMIT=3), not just the first -- a prior version fell back to an unconditional write on the second conflict, able to silently clobber a third concurrent writer. Fixed 2026-07-10, commit 4cd7784.
