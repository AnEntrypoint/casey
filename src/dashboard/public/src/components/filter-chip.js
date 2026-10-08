import * as webjsx from 'webjsx';
import { Btn } from 'ds/components/shell/atoms.js';
import { word } from '../words.js';
const h = webjsx.createElement;

export function FilterChip({ key, label, count, on, onClick, title }) {
  return PillButton({
    key, title, active: on, empty: count === 0, onClick,
    children: [h('span', { key: 'n', class: 'ds-fchip-n' }, String(count)), h('span', { key: 'l' }, label)],
  });
}

export function PillButton({ key, active, empty, title, onClick, class: cls, children }) {
  return h('button', {
    key, type: 'button', title,
    class: 'ds-filter-pill' + (active ? ' active' : '') + (empty ? ' is-empty' : '') + (cls ? ' ' + cls : ''),
    'aria-pressed': active === undefined ? undefined : (active ? 'true' : 'false'),
    onclick: onClick,
  }, ...(Array.isArray(children) ? children : [children]));
}

export function ClearChip({ onClick }) {
  return Btn({ key: 'clr', variant: 'link', size: 'sm', onClick, children: word('ui.filter_chip_clear') });
}

export function QueueMore({ key, onClick, children }) {
  return Btn({ key, variant: 'ghost', size: 'sm', class: 'ds-queue-more', onClick, children });
}
