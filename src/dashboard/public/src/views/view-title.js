// The page's own name: exactly one <h1> per screen, and the thing the <main>
// landmark is named by.
//
// Three mounts swap what sits under the app chrome -- the map home view, the
// case-list home view and a content-swap panel -- and only one is ever on
// screen, so the id below is unique by construction. It lives here rather than
// in app-view.js because both home views need it too, and importing it back
// from app-view.js would close an import cycle (app-view.js imports them).
//
// Why a heading at all: the rendered accessibility tree of the map home view
// carried no heading of any level, so a screen-reader user landing on this
// deployment's home screen had no outline to navigate by and no statement of
// what the page even was. The chrome's brand/breadcrumb is not that statement
// -- it names the deployment, not the screen.
//
// Default class is `sr-only` (the kit's own visually-hidden utility): on a
// home view the name is carried visibly by the chrome and the pane headings
// under it, so a second visible copy would be read out twice by anyone using
// both channels. A panel page, which has no such visible name of its own,
// passes its real class and renders it.

import * as webjsx from 'webjsx';
const h = webjsx.createElement;

export const VIEW_TITLE_ID = 'ds-view-title';

export function ViewTitle(text, className = 'sr-only') {
  return h('h1', { id: VIEW_TITLE_ID, class: className }, text);
}
