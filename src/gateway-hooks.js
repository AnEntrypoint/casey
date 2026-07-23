// gateway-hooks.js -- casey's inbound handler for the freddie Gateway.
//
// freddie's built-in Gateway.handleInbound runs a context-free runTurn and
// sends the result. casey needs the agent turn to carry full case context and
// have the case_* tools, and needs every step on the thatcher timeline. So
// instead of layering hooks around freddie's turn (which would run a second,
// context-free turn), casey REPLACES handleInbound with makeCaseHandler():
//
//   inbound message
// -> find/create case (thatcher)
// -> log inbound event
// -> agent turn with case context + case tools (runTurn)
// -> log outbound event
// -> send reply via the channel adapter
//
// All writes go through the CaseStore, so the dashboard observes everything and
// an operator can override case state at any time.
//
// THIS FILE IS A THIN RE-EXPORT BARREL. The actual implementation lives in
// hooks/*.js, split by concern (prompt construction, pure-text heuristics,
// media enrichment, the main handler, and webhook notifiers) -- see each
// file's own header comment and AGENTS.md's Source map for the split
// rationale. Trimmed to the 5 symbols with a REAL importer through this
// barrel (grep-confirmed: casey.js and dashboard/server.js) -- every other
// symbol this file used to re-export (caseSystemPrompt, sanitizeOutboundRef,
// isStockAck, jargonHits, guessLang, stripChannelMarkup, detectContactIntent,
// canAgentAct, stageNote, intentReply, conversationKey, replyTarget) has zero
// real callers going through gateway-hooks.js; every actual consumer already
// imports them directly from their owning hooks/*.js file.

export {
  makeCaseHandler,
} from './hooks/handler.js'

export {
  makeTransitionNotifier,
  discordHandoffNotifier,
  getWebhookDeliveryStatus,
  breachNotifier,
} from './hooks/notifiers.js'
