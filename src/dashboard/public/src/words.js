// words.js -- the dashboard's read of the deployment's vocabulary file
// (config/vocabulary.yml, see src/config-loader.js and docs/vocabulary-guide.md).
//
// The server writes the words into the shell it serves (<script type="application/json"
// id="casey-vocab">), so they are here on the first line of the first render, need no
// login, and are carried offline by the service worker's cached shell. Nothing in the
// dashboard spells a sentence a person reads for the team to edit; it asks for the word.
//
// Placeholders {brand}, {entity} and {entity_plural} are filled from the same config
// vocabulary.js reads; any other {name} comes from the caller's `vars`.

import { brandName, entityLabel, entityLabelPlural } from './vocabulary.js';

let table = null;
function words() {
  if (table) return table;
  table = {};
  try {
    const el = document.getElementById('casey-vocab');
    if (el && el.textContent) table = JSON.parse(el.textContent) || {};
  } catch { /* an unreadable table leaves every word to degrade to its key's last part */ }
  return table;
}

/** @returns {boolean} whether the vocabulary holds this key. */
export function hasWord(key) { return Object.prototype.hasOwnProperty.call(words(), key); }

/** @returns {Object<string,string>} every word under a section, keyed by the rest of the name. */
export function wordsIn(section) {
  const out = {};
  const p = section + '.';
  for (const [k, v] of Object.entries(words())) if (k.startsWith(p)) out[k.slice(p.length)] = Array.isArray(v) ? v.join(' ') : String(v);
  return out;
}

function fill(s, vars) {
  return s.replace(/\{([a-z_]+)\}/g, (m, name) => {
    if (vars && vars[name] != null) return String(vars[name]);
    if (name === 'brand') return brandName();
    if (name === 'entity_plural') return entityLabelPlural();
    if (name === 'entity') return entityLabel();
    return m;
  });
}

/**
 * @param {string} key - e.g. 'ui.offline_title'
 * @param {Object} [vars] - values for extra {placeholders}
 * @returns {string} the deployment's wording; an unknown key reads as its own last part, so a typo is visible rather than blank.
 */
export function word(key, vars) {
  const v = words()[key];
  if (v == null) return key.split('.').pop().replace(/_/g, ' ');
  return fill(Array.isArray(v) ? v.join(' ') : String(v), vars);
}
