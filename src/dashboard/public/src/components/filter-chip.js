// The counted filter chip, defined once.
//
// A chip states a count AND applies it, so pressing it can never produce a
// different number than the one on its face. Both home views use it -- the
// map's rail (panels/map-panel.js) and the case list (views/case-list-view.js)
// -- and until this module existed each carried its own character-identical
// copy of the renderer plus its own copy of the Clear control beside it.
//
// That is the same failure shape AGENTS.md records for the urgency ladder and
// the filter predicate, one layer up: the map and the queue are two views of
// one dataset on one screen, and every time a derivation was written twice the
// two halves drifted and said different things at the same moment. The
// derivations were unified into map-model.js; the control that RENDERS them
// was left duplicated across the same two surfaces, so a change to the chip's
// affordance, its pressed state or its empty treatment could still land on one
// home view and not the other while both claimed to be the same control.
//
// Why the count is text and not only a colour: `is-empty` dims a zero-count
// chip, and dimming is the only thing that channel does. The number itself is
// always written out, so a low-vision or colourblind operator reads the same
// fact a sighted one does -- no state here is carried by hue alone.

import * as webjsx from 'webjsx';
const h = webjsx.createElement;

export function FilterChip({ key, label, count, on, onClick, title }) {
  return h('button', {
    key, type: 'button', title,
    class: 'ds-fchip' + (on ? ' is-on' : '') + (count === 0 ? ' is-empty' : ''),
    'aria-pressed': on ? 'true' : 'false',
    onclick: onClick,
  }, h('span', { class: 'ds-fchip-n' }, String(count)), h('span', { class: 'ds-fchip-l' }, label));
}

// Only rendered when something is actually filtered, by both callers: a Clear
// control that is always present is one an operator has to read to find out
// whether it applies.
export function ClearChip({ onClick }) {
  return h('button', { key: 'clr', type: 'button', class: 'ds-fchip-clear', onclick: onClick }, 'Clear');
}
