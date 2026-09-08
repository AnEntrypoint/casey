// One row of the full report list.
//
// The row LEADS with what makes it urgent. It used to lead with an id and a
// timestamp -- ref, priority, stage, owner, "3h ago" -- and buried what the
// report was actually about on the second line behind the channel name. An
// operator scanning a duty roster needs "a person was asked for and no one has
// replied" first and "CASE-1268" second, not the other way round.
//
// The urgency itself is NOT derived here. It is looked up from the same
// server-ranked attention list (attn.js's score + plain reason) the queue above
// reads, banded through map-model.js's urgencyBand -- the one shared ladder the
// map's pins use too. The dot this row used to paint came from format.js's
// attn() instead, a third, unrelated predicate (autonomy observe/assisted, or a
// needs-human tag) that could and did mark a row urgent that the queue above it
// did not list at all.
//
// Checkbox for bulk-select; guardrail boilerplate is collapsed into a single
// Chip that expands the full list on click; health/intake tags render as
// distinct visual layers from operator/owner tags.

import * as webjsx from 'webjsx';
import { Chip, Pill } from 'ds/components/shell.js';
import { state, toggleBulkSelect, setActiveId } from '../../state.js';
import { rel, fmtTime, tagList, stageLabel, stageTone, healthLabel } from '../../format.js';
import { urgencyBand, URGENCY_BAND_LABEL } from '../../map-model.js';
import { pushHash } from '../../route.js';
const h = webjsx.createElement;

const HEALTH_TAG_PREFIX = 'health:';
const INTERNAL_TAGS = new Set(['needs-human', 'draft-pending', 'unsent_draft', 'ai-offline', 'degraded-turn-seen']);

// id -> attention row, rebuilt only when setAttention() swaps the array in.
// Built per row instead would be quadratic over a 200-row page; keyed on array
// identity rather than a timestamp so a re-render with unchanged data is free.
let attnIndex = { src: null, byId: new Map() };
function attentionFor(id) {
  const src = state.attention || [];
  if (attnIndex.src !== src) {
    const byId = new Map();
    for (const a of src) if (a && a.id != null) byId.set(a.id, a);
    attnIndex = { src, byId };
  }
  return attnIndex.byId.get(id) || null;
}

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

function GuardrailChip({ c, expanded }) {
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

export function CaseRow({ c, expandedGuardrails, onToggleGuardrails }) {
  const selected = state.bulkSelected.has(c.id);
  const active = c.id === state.activeId;
  // j/k keyboard triage (main.js moveFocus) walks the list via state._focusRowId
  // with no visible indicator anywhere it was previously read -- Enter
  // (openHighlighted) and 'c' (claim) both already act on the correct row,
  // so the state was right, the row just never painted which one that was.
  const kbdFocused = c.id === state._focusRowId;
  const src = intakeSourceTag(c);
  const owner = c.assignee && c.assignee !== 'agent' ? c.assignee : '';
  const mine = owner && state.currentUser && owner === state.currentUser.username;

  const a = attentionFor(c.id);
  const band = a ? urgencyBand(Number(a.score)) : 0;
  const subject = c.subject || '(no subject)';
  // The lead line answers "why should I touch this one". When the guardrails
  // are chasing the case that is their own plain-English reason; otherwise it
  // is what the report is about, which is still a better opening than its id.
  const lead = a && a.reason ? a.reason : subject;

  const open = () => { setActiveId(c.id); pushHash({ caseId: c.id }); };

  // Deliberately NOT the kit's Row, and the reason is specific rather than
  // stylistic, so it does not get re-litigated: Row aliases `selected` onto
  // `active` for backward compatibility (isActive = active || selected), and
  // this row needs the two to look DIFFERENT. There are three states here and
  // an operator has to tell them apart at a glance -- `active` is the case
  // currently open in the detail pane, `selected` is one of several ticked for
  // a bulk action, and `kbd-focused` is the row j/k has highlighted and Enter
  // would open. Collapsing the first two would make keyboard triage ambiguous
  // exactly when several rows are ticked, which is when it matters.
  //
  // The timeline row DID move to the kit (LogRow), and the report field row
  // too (DetailRow) -- those had no such conflict. This one waits for Row to
  // separate the two props, which is a change to a shared primitive other
  // consumers depend on, not something to force from here.
  return h('div', {
    key: c.id,
    class: 'case-row' + (band ? ' band-' + band : '')
      + (active ? ' active' : '') + (selected ? ' selected' : '') + (kbdFocused ? ' kbd-focused' : ''),
    'data-id': c.id, role: 'listitem', tabindex: '0',
    'aria-selected': selected ? 'true' : 'false',
    // The stripe is a colour; this is the same fact in words, for a screen
    // reader and for anyone who cannot separate the two warm bands.
    'aria-label': c.ref + ': ' + (band ? (URGENCY_BAND_LABEL[band] + ' -- ') : '') + lead,
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
      h('div', { key: 'lead', class: 'case-row-lead' }, lead),
      h('div', { key: 'top', class: 'case-row-top' },
        h('span', { key: 'ref', class: 'case-row-ref' }, c.ref),
        Chip({ key: 'stage', tone: stageTone(c.status), size: 'sm', children: stageLabel(c.status) }),
        // Only when it is actually raised: a "normal" chip on every row is
        // noise that makes the raised ones harder to spot.
        c.priority === 'urgent' || c.priority === 'high'
          ? Chip({ key: 'pri', tone: 'warn', size: 'sm', children: c.priority })
          : null,
        owner ? Chip({ key: 'own', tone: mine ? 'accent' : '', size: 'sm', children: mine ? 'you' : owner }) : null,
        h('span', { key: 'when', class: 'case-row-when', title: fmtTime(c.updated_at || c.created_at) }, rel(c.updated_at || c.created_at))
      ),
      h('div', { key: 'sub', class: 'case-row-sub' },
        src ? Chip({ key: 'src', tone: src.tone, size: 'sm', tag: true, children: src.label }) : null,
        // The subject still shows when the lead line was given to the reason,
        // so no row ever hides what the report is actually about.
        h('span', { key: 'meta' }, lead === subject ? c.channel : c.channel + ' - ' + subject),
        fillPill(c.fill_rate),
        GuardrailChip({ c, expanded: expandedGuardrails })
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
