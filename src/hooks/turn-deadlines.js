

export const TURN_SOFT_DEADLINE_MS = Number(process.env.CASEY_TURN_SOFT_DEADLINE_MS) || 25000

export const TURN_HARD_DEADLINE_MS = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 120000

export const STILL_WORKING_TEXT = "Still working on this -- one moment."
export const TURN_TIMEOUT_TEXT = "Sorry, I'm having trouble right now. Please try again in a little while, or send your message again."
