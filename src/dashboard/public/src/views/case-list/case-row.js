// Single case list row. Checkbox for bulk-select; guardrail boilerplate is
// collapsed into a single Chip that expands the full list on click
// (ux-case-list-guardrail-boilerplate-collapse); health/intake tags render
// as distinct visual layers from operator/owner tags
// (ux-internal-tags-visual-layer-separation).

import * as ds from '/design/dist/247420.js';
import { state, toggleBulkSelect, setActiveId } from '../../state.js';
import { rel, fmtTime, tagList, attn, stageLabel, stageTone, healthLabel } from '../../format.js';
import { pushHash } from '../../route.js';
const { Chip, Badge, Pill } = ds.components;
const h = ds.h;

const HEALTH_TAG_PREFIX = 'health:';
const INTERNAL_TAGS = new Set(['needs-human', 'draft-pending', 'unsent_draft', 'ai-offline', 'degraded-turn-seen']);

function guardrailTags(c) {
  return tagList(c).filter((t) => t.startsWith(HEALTH_TAG_PREFIX) || INTERNAL_TAGS.has(t));
}

function intakeSourceTag(c) {
  const tg = tagList(c);
  if (tg.includes('intake_mode:manual')) return { label: 'Manual', tone: 'muted' };
  if (tg.includes('intake_mode:public_form')) return { label: 'Form', tone: 'accent' };
  if (tg.includes('intake_mode:channel')) return { label: 'AI', tone: 'accent' };
  return null;
}

function GuardrailChip({ c, expanded, onToggle }) {
  const tags = guardrailTags(c);
  if (!tags.length) return null;
  if (!expanded) {
    return Chip({
      key: 'grd', tone: 'warn', size: 'sm',
      children: [h('span', { key: 'gc' }, tags.length + ' guardrail flag' + (tags.length === 1 ? '' : 's'))],
    });
  }
  return h('span', { key: 'grd-x', class: 'ds-guardrail-expanded' },
    ...tags.map((t, i) => Chip({ key: 'g' + i, tone: 'warn', size: 'sm', children: healthLabel(t) })));
}

function fillPill(rfr) {
  if (!rfr) return null;
  const low = rfr.visit_critical_filled < rfr.visit_critical_total;
  const ok = rfr.filled === rfr.total_fields;
  return Pill({
    key: 'fill', tone: ok ? 'accent' : (low ? '' : 'muted'),
    children: rfr.filled + '/' + rfr.total_fields + ' fields' + (low ? ' (' + rfr.visit_critical_filled + '/' + rfr.visit_critical_total + ' essential)' : ''),
  });
}

export function CaseRow({ c, expandedGuardrails, onToggleGuardrails, onOpenIntake }) {
  const selected = state.bulkSelected.has(c.id);
  const active = c.id === state.activeId;
  // j/k keyboard triage (main.js moveFocus) walks the list via state._focusRowId
  // with no visible indicator anywhere it was previously read -- Enter
  // (openHighlighted) and 'c' (claim) both already act on the correct row,
  // so the state was right, the row just never painted which one that was.
  const kbdFocused = c.id === state._focusRowId;
  const needsAttn = attn(c);
  const src = intakeSourceTag(c);
  const owner = c.assignee && c.assignee !== 'agent' ? c.assignee : '';
  const mine = owner && state.currentUser && owner === state.currentUser.username;

  const open = () => { setActiveId(c.id); pushHash({ caseId: c.id }); };

  return h('div', {
    key: c.id, class: 'case-row' + (active ? ' active' : '') + (selected ? ' selected' : '') + (kbdFocused ? ' kbd-focused' : ''),
    'data-id': c.id, role: 'listitem', tabindex: '0',
    'aria-selected': selected ? 'true' : 'false',
    onclick: (e) => { if (e.target.closest && e.target.closest('.case-row-cb')) return; open(); },
    onkeydown: (e) => { if (e.key === 'Enter') open(); },
  },
    h('input', {
      key: 'cb', type: 'checkbox', class: 'case-row-cb', title: 'Select for a bulk action',
      'aria-label': 'Select case ' + c.ref + ' for a bulk action',
      checked: selected,
      onclick: (e) => { e.stopPropagation(); toggleBulkSelect(c.id, e.target.checked); },
    }),
    h('div', { key: 'body', class: 'case-row-body' },
      h('div', { key: 'top', class: 'case-row-top' },
        needsAttn ? h('span', { key: 'dot', class: 'ds-dot ds-dot-on', role: 'img', 'aria-label': 'needs attention (autonomy: ' + c.autonomy + ')' }) : null,
        h('span', { key: 'ref', class: 'case-row-ref' }, c.ref),
        Badge({ key: 'pri', tone: c.priority === 'urgent' || c.priority === 'high' ? 'warn' : 'neutral', children: c.priority }),
        Chip({ key: 'stage', tone: stageTone(c.status), size: 'sm', children: stageLabel(c.status) }),
        owner ? Chip({ key: 'own', tone: mine ? 'accent' : '', size: 'sm', children: mine ? 'you' : owner }) : null,
        h('span', { key: 'when', class: 'case-row-when', title: fmtTime(c.updated_at || c.created_at) }, rel(c.updated_at || c.created_at))
      ),
      h('div', { key: 'sub', class: 'case-row-sub' },
        src ? Chip({ key: 'src', tone: src.tone, size: 'sm', tag: true, children: src.label }) : null,
        h('span', { key: 'meta' }, c.channel + ' - ' + (c.subject || '(no subject)')),
        fillPill(c.fill_rate),
        GuardrailChip({ c, expanded: expandedGuardrails, onToggle: onToggleGuardrails })
      ),
      guardrailTags(c).length
        ? h('button', {
          key: 'grd-toggle', type: 'button', class: 'ds-guardrail-toggle-btn',
          'aria-expanded': expandedGuardrails ? 'true' : 'false',
          onclick: (e) => { e.stopPropagation(); onToggleGuardrails && onToggleGuardrails(c.id); },
        }, expandedGuardrails ? 'Hide flags' : 'Show flags')
        : null
    )
  );
}
