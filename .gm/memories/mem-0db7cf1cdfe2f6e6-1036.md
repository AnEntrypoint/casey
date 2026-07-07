---
key: mem-0db7cf1cdfe2f6e6-1036
ns: default
created: 1783421423574
updated: 1783421423574
---

## Resolved mutable: mut-guesslang-gap-witness

Direct-imported real gateway-hooks.js and called guessLang() against Sesotho and Portuguese sample text; both returned 'en' (no cues in LANG_CUES for st/tn/pt). Read LANG_CUES definition: only af/zu/xh keys plus ar/hi via separate unicode-range regex tests before the cue-scoring loop. Read caseSystemPrompt lines ~123-126 and ~215-221: the prompt explicitly instructs the model to detect and record language_detected as one of English/Afrikaans/isiZulu/isiXhosa/Sesotho/Setswana, and to reply in the SAME language including Sesotho/Setswana. The LLM's own free-composed replies are independent of guessLang (unaffected), but guessLang is the sole input to intentReply/refTail, the ~4 deterministic STOP/HUMAN/resume canned acknowledgement strings meant to work even when the LLM backend is down -- these always render in English for Sesotho/Setswana/Portuguese speakers, contradicting the stated multi-language intent for exactly the layer designed to be language-robust without a model.
