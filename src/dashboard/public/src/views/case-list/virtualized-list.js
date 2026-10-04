import * as webjsx from 'webjsx';
import { CaseRow } from './case-row.js';
import { schedule } from '../../state.js';
import { EntityLabelPlural } from '../../vocabulary.js';
const h = webjsx.createElement;

const ROW_HEIGHT = 64;
const OVERSCAN = 6;

const scrollTops = new Map();
const CONTAINER_KEY = 'case-list';

export function VirtualizedCaseList({ cases, containerHeight = 560, expandedGuardrails, onToggleGuardrails }) {
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

  const refFn = (el) => {
    if (!el) return;
    if (Math.abs(el.scrollTop - approxScrollTop) > ROW_HEIGHT) el.scrollTop = approxScrollTop;
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
