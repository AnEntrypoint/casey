---
key: mem-1e6e55fd1aafce3b-670
ns: default
created: 1782674363677
updated: 1782674363677
---

gm-method (witnessed): a deterministic per-field intake-drive can have TWO independent code paths that both run in one turn (an empty-model fallback branch and a precedence gate that is NOT its else). Because the first path appends an append-only marker that the second path's re-read of the event log then sees, the second path advances to the NEXT field and overwrites the reply -- recording field A asked-once while never delivering its question. The fix is a same-turn flag (droveIntake) guarding the second path. Lesson: when two branches both mutate then re-read shared append-only state in one turn, gate the later branch on whether the earlier one already acted.
