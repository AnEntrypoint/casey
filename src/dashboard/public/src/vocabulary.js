// vocabulary.js -- the two words this deployment uses for the two nouns every
// operator-facing surface has to name: the PRODUCT and the RECORD. Both are
// config-driven and neither may be spelled literally in a view.
//
// This exists for the reason map-model.js's QUEUE_NAME exists, and it is the
// same failure arriving through a different door. QUEUE_NAME was five names for
// one list; this was twelve independent copies of one config read, plus three
// surfaces that skipped the read entirely and shipped the literal word "casey"
// to an operator on a deployment that has never used it.
//
// THE PRODUCT NAME IS NOT "casey" ON ANY DEPLOYMENT AN OPERATOR LOGS INTO.
// "casey" is the software this dashboard is built on; the name of the thing
// somebody is signed into comes from dashboard_ui.brand (on this deployment,
// "Herd Health"). The literal is a last-resort fallback for a config that has
// not arrived yet, never a word to type into a sentence.
//
// THE RECORD'S NAME IS entity_label, AND IT IS NOT "case". report-fields.yml
// declares it -- "report" on uhh, "ticket" on casey's own bundled helpdesk demo
// -- and routes/operations.js serves it on /api/config. A view that hardcodes
// "report" is wrong on the helpdesk demo; a view that hardcodes "case" is wrong
// on both, and it also contradicts the help card, which teaches the operator
// the word the config chose. Ask for the label; never spell it.

import { state } from './state.js';

// The per-case override wins when one is loaded. A deployment where concurrent
// records carry genuinely different field vocabularies (serpent's per-run
// schema) fetches one per case; it is null on a plain casey/uhh deployment and
// before that fetch resolves, in which case the global config answers.
export function activeConfig() { return state.runConfig || state.config; }

/** @returns {string} this deployment's product name, e.g. "Herd Health". */
export function brandName() { return activeConfig()?.dashboard_ui?.brand || state.config?.dashboard_ui?.brand || 'casey'; }

/** @returns {string} the record's name in lower case, e.g. "report". */
export function entityLabel() { return activeConfig()?.entity_label || 'report'; }

/** @returns {string} the record's name capitalised, for the start of a sentence or a button. */
export function EntityLabel() {
  const s = entityLabel();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// Naive suffixing is correct for every value entity_label is actually declared
// with (report/ticket/case/record) and for any other regular English noun a
// deployer would reasonably choose. A deployer whose label pluralises
// irregularly needs a second config field, not a guess table here.
/** @returns {string} the record's name, plural and lower case, e.g. "reports". */
export function entityLabelPlural() { return entityLabel() + 's'; }

/** @returns {string} the record's name, plural and capitalised, e.g. "Reports". */
export function EntityLabelPlural() { return EntityLabel() + 's'; }

// "3 reports" / "1 report" -- the count and the noun agreed, in one place.
//
// Eight surfaces wrote this as "report(s)" instead, which is a developer
// declining to decide in front of the operator. Two others (case-list-view.js,
// map-panel.js) already did it properly with their own inline ternary, so the
// dashboard shipped both spellings of the same idea on the same screen.
/**
 * @param {number} n
 * @param {string} [one] - singular noun; defaults to this deployment's record label.
 * @param {string} [many] - plural noun; defaults to the singular plus "s".
 * @returns {string} e.g. "1 report", "4 reports"
 */
export function countOf(n, one, many) {
  const k = Number(n) || 0;
  const s = one || entityLabel();
  return k === 1 ? `${k} ${s}` : `${k} ${many || (s + 's')}`;
}

// THE CONTACT ACCESS LADDER, lowest rung to highest -- the browser-side mirror of
// casey's src/contact-tiers.js TIER_ORDER, and the third noun this file exists
// for. Two copies, one vocabulary: this bundle has no import path into casey's
// server modules (the same split timestamp.js's tagList documents), so the order
// is stated here and must be changed in both places or neither.
//
// The stored VALUES are the ladder. What each rung is CALLED is config, served
// resolved on /api/config as `tier_labels` (report-shape.js derives it from
// dashboard_ui.tier_labels with casey's own generic labels as the fallback), so
// this deployment's "Eco Ranger" reaches the screen without any rename of the
// value underneath it. A view that spells "field worker" is wrong the moment a
// deployment renames the rung; ask for the label, never spell it.
export const TIER_ORDER = ['reporter', 'field_worker', 'animal_health_technician'];

/** @returns {string} the stored rung, coerced to a real one (fail-closed to the lowest). */
export function tierValue(tier) {
  return TIER_ORDER.includes(tier) ? tier : TIER_ORDER[0];
}

/** @returns {string} what this deployment calls that rung, e.g. "Eco Ranger". */
export function tierLabel(tier) {
  const t = tierValue(tier);
  const labels = activeConfig()?.tier_labels || state.config?.tier_labels || null;
  if (labels && typeof labels[t] === 'string' && labels[t].trim()) return labels[t].trim();
  // Last-resort fallback for a config that has not arrived yet -- same role the
  // literal 'casey' plays in brandName above, never a word to build a sentence
  // around. Derived from the value so a rung added server-side still renders as
  // something readable here before this file is updated.
  return t.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

/** @returns {string|null} the rung one step up, or null at the top. */
export function tierAbove(tier) {
  const i = TIER_ORDER.indexOf(tierValue(tier));
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** @returns {string|null} the rung one step down, or null at the bottom. */
export function tierBelow(tier) {
  const i = TIER_ORDER.indexOf(tierValue(tier));
  return i > 0 ? TIER_ORDER[i - 1] : null;
}
