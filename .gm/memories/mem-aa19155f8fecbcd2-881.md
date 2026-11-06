---
key: mem-aa19155f8fecbcd2-881
ns: default
created: 1787321591232
updated: 1787321591232
---

## Resolved mutable: mut-1787321445716

node live exec against file:///C:/dev/casey/src/hooks/handler.js's real makeCaseHandler: 3 concurrent calls (msg1/msg2/msg3, same external_id BC:burstuser) via Promise.all. msg1 processed synchronously (inFlight claimed atomically pre-await); msg2/msg3 hit inFlight.has()===true, buffered into pendingBuffer (buffered:true,skipped:true returned immediately). Post-settle (300ms), recordInbound was called exactly 3 times with distinct texts ['msg1','msg2','msg3'] in that order -- proving the trailing drain block (handler.js line ~1400-1420, this.handleInbound(platform,next) fired after each turn completes) recursively replayed msg2 then msg3, each getting its own real inbound event. No message lost; no duplicate. Matches AGENTS.md's burst-buffer-and-replay design principle exactly. No code change needed -- mechanism already correct.
