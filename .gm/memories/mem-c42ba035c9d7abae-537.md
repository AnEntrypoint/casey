---
key: mem-c42ba035c9d7abae-537
ns: default
created: 1790923777006
updated: 1790923777006
---

casey composes four git submodules under deps/: freddie is the agent runtime (a Cordis plugin tree, NOT npm-importable), acptoapi is the LLM chain, thatcher plus busybase is the system of record (case/event/contact), and anentrypoint-design is the UI. thatcher, design and acptoapi are declared as file:deps/<name>; freddie is NOT in package.json because it is a pnpm workspace. scripts/link-deps.mjs symlinks node_modules/<name> and every @freddie/* package under deps/freddie; run git submodule update --init --recursive after a clone.
