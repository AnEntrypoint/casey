import { word, hasWord, wordsIn } from './words.js';

export function glossary() {
    const out = {};
    for (const k of Object.keys(wordsIn('glossary'))) out[k] = word('glossary.' + k);
    return out;
}

export function glossaryLookup(key) {
    return hasWord('glossary.' + key) ? word('glossary.' + key) : '';
}
