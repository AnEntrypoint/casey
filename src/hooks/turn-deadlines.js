import { caseyText } from '../deployment-text.js';


export const TURN_SOFT_DEADLINE_MS = Number(process.env.CASEY_TURN_SOFT_DEADLINE_MS) || 25000

export const TURN_HARD_DEADLINE_MS = Number(process.env.CASEY_TURN_HARD_DEADLINE_MS) || 120000

export const STILL_WORKING_TEXT = caseyText("src/hooks/turn-deadlines.js#s0")
export const TURN_TIMEOUT_TEXT = caseyText("src/hooks/turn-deadlines.js#0")
