// Windowed row rendering (ux-perf-list-virtualization): renders only rows
// within the scroll viewport +/- an overscan band into a fixed-height
// scroll container, wrapping case-row.js. No external virtualizer library --
// a plain fixed-row-height window over a scrollTop tracked per container.

import * as ds from '/design/dist/247420.js';
import { CaseRow } from './case-row.js';
import { schedule } from '../../state.js';
const h = ds.h;

const ROW_HEIGHT = 64;      // px, matches .case-row's min-height in app.css
const OVERSCAN = 6;         // extra rows rendered above/below the viewport

// Module-level scroll offset per mount -- webjsx re-invokes the whole view
// function tree on every schedule(), so this cannot live in view-local state.
// Keyed by a stable container id (not the element itself, since applyDiff
// may swap the node when the row count changes the child shape) so the next
// render's window computation can read back where the user actually
// scrolled to instead of resetting to the top on every state change.
const scrollTops = new Map();
const CONTAINER_KEY = 'case-list';

export function VirtualizedCaseList({ cases, containerHeight = 560, expandedGuardrails, onToggleGuardrails }) {
  if (!cases.length) return h('div', { class: 'ds-case-list-empty empty' }, 'No cases match your filter.');

  const total = cases.length;
  const totalHeight = total * ROW_HEIGHT;

  let rerenderQueued = false;
  const onScroll = (e) => {
    scrollTops.set(CONTAINER_KEY, e.currentTarget.scrollTop);
    if (rerenderQueued) return;
    rerenderQueued = true;
    requestAnimationFrame(() => { rerenderQueued = false; schedule(); });
  };

  const approxScrollTop = scrollTops.get(CONTAINER_KEY) || 0;
  const startIdx = Math.max(0, Math.floor(approxScrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(total, startIdx + visibleCount);
  const topPad = startIdx * ROW_HEIGHT;

  const rows = cases.slice(startIdx, endIdx).map((c) => CaseRow({
    c, expandedGuardrails: expandedGuardrails === c.id, onToggleGuardrails,
  }));

  // Only force scrollTop back when it has drifted from our tracked value by
  // more than a row (e.g. the container was just recreated) -- writing it on
  // every re-render would fight the browser's own native momentum scroll,
  // which fires MANY scroll events per user gesture.
  const refFn = (el) => {
    if (!el) return;
    if (Math.abs(el.scrollTop - approxScrollTop) > ROW_HEIGHT) el.scrollTop = approxScrollTop;
  };

  return h('div', {
    class: 'ds-case-list-scroll', style: 'max-height:' + containerHeight + 'px',
    role: 'list', 'aria-label': 'Cases', ref: refFn, onscroll: onScroll,
  },
    h('div', { key: 'spine', class: 'ds-case-list-spine', style: 'height:' + totalHeight + 'px' },
      h('div', { key: 'window', style: 'transform:translateY(' + topPad + 'px)' },
        ...rows
      )
    )
  );
}

// Simpler, non-windowed fallback used automatically by case-list-view.js when
// the list is small enough that virtualization overhead isn't worth it (a
// short list renders every row directly -- no scroll-window bookkeeping).
export function PlainCaseList({ cases, expandedGuardrails, onToggleGuardrails }) {
  if (!cases.length) return h('div', { class: 'ds-case-list-empty empty' }, 'No cases match your filter.');
  return h('div', { class: 'ds-case-list-plain', role: 'list', 'aria-label': 'Cases' },
    ...cases.map((c) => CaseRow({ c, expandedGuardrails: expandedGuardrails === c.id, onToggleGuardrails })));
}

export const VIRTUALIZE_THRESHOLD = 60;
