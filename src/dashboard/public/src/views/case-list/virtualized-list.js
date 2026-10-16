import * as webjsx from 'webjsx';
import { CaseRow } from './case-row.js';
import { schedule } from '../../state.js';
import { EntityLabelPlural } from '../../vocabulary.js';
const h = webjsx.createElement;

const ROW_HEIGHT = 64;
const OVERSCAN = 6;

const scrollTops = new Map();
const CONTAINER_KEY = 'case-list';
const rowHeights = new Map();
const rowIds = new WeakMap();
let rowObserver = null;

function observeRow(row, caseId) {
  if (typeof ResizeObserver === 'undefined') return;
  if (!rowObserver) {
    rowObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = rowIds.get(entry.target);
        const px = entry.target.offsetHeight;
        if (id === undefined || !(px > 0) || rowHeights.get(id) === px) continue;
        rowHeights.set(id, px);
        changed = true;
      }
      if (changed) requestAnimationFrame(schedule);
    });
  }
  rowIds.set(row, caseId);
  rowObserver.observe(row);
}

function measureRendered(scrollEl, cases, start) {
  const win = scrollEl.firstElementChild && scrollEl.firstElementChild.firstElementChild;
  if (!win) return;
  let changed = false;
  Array.from(win.children).forEach((row, i) => {
    const c = cases[start + i];
    if (!c) return;
    observeRow(row, c.id);
    const px = row.offsetHeight;
    if (px > 0 && rowHeights.get(c.id) !== px) { rowHeights.set(c.id, px); changed = true; }
  });
  if (changed) requestAnimationFrame(schedule);
}

function lowerBound(offsets, x) {
  let lo = 0, hi = offsets.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function upperBound(offsets, x) {
  let lo = 0, hi = offsets.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

function layoutWindow(cases, scrollTop, viewport) {
  const total = cases.length;
  const offsets = new Array(total + 1);
  offsets[0] = 0;
  for (let i = 0; i < total; i++) offsets[i + 1] = offsets[i] + (rowHeights.get(cases[i].id) ?? ROW_HEIGHT);
  const firstVisible = Math.min(Math.max(0, upperBound(offsets, scrollTop) - 1), Math.max(0, total - 1));
  const pastVisible = Math.min(total, lowerBound(offsets, scrollTop + viewport));
  const start = Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(total, Math.max(pastVisible, firstVisible + 1) + OVERSCAN);
  return { offsets, start, end, totalHeight: offsets[total] };
}

export function VirtualizedCaseList({ cases, containerHeight = 560, expandedGuardrails, onToggleGuardrails }) {
  let rerenderQueued = false;
  const onScroll = (e) => {
    scrollTops.set(CONTAINER_KEY, e.currentTarget.scrollTop);
    if (rerenderQueued) return;
    rerenderQueued = true;
    requestAnimationFrame(() => { rerenderQueued = false; schedule(); });
  };

  const approxScrollTop = scrollTops.get(CONTAINER_KEY) || 0;
  const { offsets, start, end, totalHeight } = layoutWindow(cases, approxScrollTop, containerHeight);
  const topPad = offsets[start];

  const rows = cases.slice(start, end).map((c) => CaseRow({
    c, expandedGuardrails: expandedGuardrails === c.id, onToggleGuardrails,
  }));

  const refFn = (el) => {
    if (!el) return;
    if (Math.abs(el.scrollTop - approxScrollTop) > ROW_HEIGHT) el.scrollTop = approxScrollTop;
    measureRendered(el, cases, start);
  };

  return h('div', {
    class: 'ds-case-list-scroll', style: 'max-height:' + containerHeight + 'px',
    role: 'list', 'aria-label': EntityLabelPlural(), ref: refFn, onscroll: onScroll,
  },
    h('div', { key: 'spine', class: 'ds-case-list-spine', style: 'height:' + totalHeight + 'px' },
      h('div', { key: 'window', style: 'transform:translateY(' + topPad + 'px)' },
        ...rows
      )
    )
  );
}

export function PlainCaseList({ cases, expandedGuardrails, onToggleGuardrails }) {
  return h('div', { class: 'ds-case-list-plain', role: 'list', 'aria-label': EntityLabelPlural() },
    ...cases.map((c) => CaseRow({ c, expandedGuardrails: expandedGuardrails === c.id, onToggleGuardrails })));
}

export const VIRTUALIZE_THRESHOLD = 60;
