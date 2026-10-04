import { brandName, entityLabel, entityLabelPlural } from './vocabulary.js';

let table = null;
function words() {
  if (table) return table;
  table = {};
  try {
    const el = document.getElementById('casey-vocab');
    if (el && el.textContent) table = JSON.parse(el.textContent) || {};
  } catch {  }
  return table;
}

export function hasWord(key) { return Object.prototype.hasOwnProperty.call(words(), key); }

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

export function word(key, vars) {
  const v = words()[key];
  if (v == null) return key.split('.').pop().replace(/_/g, ' ');
  return fill(Array.isArray(v) ? v.join(' ') : String(v), vars);
}
