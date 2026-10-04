import * as webjsx from 'webjsx';
const h = webjsx.createElement;

export const VIEW_TITLE_ID = 'ds-view-title';

export function ViewTitle(text, className = 'sr-only') {
  return h('h1', { id: VIEW_TITLE_ID, class: className }, text);
}
