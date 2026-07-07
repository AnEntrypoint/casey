---
key: mem-b357e94b90eadeea-991
ns: default
created: 1782756318610
updated: 1782756318610
---

gm-method (witnessed): when one bad fallback output (a 'we are done here' close-out) is reached by MULTIPLE routes, fixing one route does not kill it -- the same dead-end output reappears via the next uncovered route (here: first via the enquiry route, then the question route, then the chitchat/greeting route, each landing on the same complete-report exit). The durable fix is to make the dead-end OUTPUT itself impossible (replace the close-out reply with a re-opener at the function that produces it), not to guard each inbound route. Lesson: when the SAME wrong output recurs under different inputs, grep for every caller of the function that emits it and fix the emitter, not the callers one at a time. Also: confirm WHICH process serves the live surface before claiming a fix is live -- a persistent identifier (a case id / session that survives your restarts) is the tell that the running process is not the one you rebuilt; check the live store for that id to prove local-vs-remote.
