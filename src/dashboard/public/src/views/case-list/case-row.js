import * as webjsx from 'webjsx';
import { Chip, Pill } from 'ds/components/shell.js';
import { state, toggleBulkSelect, setActiveId } from '../../state.js';
import { rel, fmtTime, tagList, stageLabel, stageTone, healthLabel, channelLabel, priorityLabel } from '../../format.js';
import { urgencyBand, URGENCY_BAND_LABEL } from '../../map-model.js';
import { entityLabel } from '../../vocabulary.js';
import { word } from '../../words.js';
import { pushHash } from '../../route.js';
import { teamRoster } from '../../api-roles.js';
const h = webjsx.createElement;

const HEALTH_TAG_PREFIX = 'health:';
const INTERNAL_TAGS = new Set(['needs-human', 'draft-pending', 'unsent_draft', 'ai-offline', 'degraded-turn-seen']);

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
      children: [h('span', { key: 'gc' }, checkCount(tags.length))],
    });
  }
  return h('span', { key: 'grd-x', class: 'ds-guardrail-expanded' },
    ...tags.map((t, i) => Chip({ key: 'g' + i, tone: 'warn', size: 'sm', children: healthLabel(t) })));
}

function checkCount(n) {
  return word(n === 1 ? 'ui.check_count_one' : 'ui.check_count_many', { n });
}

function flagWords(c, expanded) {
  const words = [];
  if (c.priority === 'urgent' || c.priority === 'high') words.push(priorityLabel(c.priority));
  const tags = guardrailTags(c);
  if (tags.length) {
    words.push(expanded
      ? tags.map((t) => healthLabel(t)).join(', ')
      : checkCount(tags.length));
  }
  return words;
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

const ownerName = (key) => { const hit = teamRoster().find((m) => m.key === key); return hit ? hit.name : key; };

export function CaseRow({ c, expandedGuardrails, onToggleGuardrails }) {
  const selected = state.bulkSelected.has(c.id);
  const active = c.id === state.activeId;
  const kbdFocused = c.id === state._focusRowId;
  const src = intakeSourceTag(c);
  const owner = c.assignee && c.assignee !== 'agent' ? c.assignee : '';
  const mine = owner && state.currentUser && owner === state.currentUser.username;

  const a = attentionFor(c.id);
  const band = a ? urgencyBand(Number(a.score)) : 0;
  const subject = c.subject || word('ui.case_row_no_subject');
  const lead = a && a.reason ? a.reason : subject;

  const open = () => { setActiveId(c.id); pushHash({ caseId: c.id }); };

  const guardrailToggle = guardrailTags(c).length
    ? h('button', {
      key: 'grd-toggle', type: 'button', class: 'btn-link ds-guardrail-toggle-btn',
      'aria-expanded': expandedGuardrails ? 'true' : 'false',
      onclick: (e) => { e.stopPropagation(); onToggleGuardrails && onToggleGuardrails(c.id); },
    }, expandedGuardrails ? word('ui.checks_hide') : word('ui.checks_show'))
    : null;

  return h('div', {
    key: c.id,
    class: 'case-row' + (band ? ' band-' + band : '')
      + (active ? ' active' : '') + (selected ? ' selected' : '') + (kbdFocused ? ' kbd-focused' : ''),
    role: 'listitem',
    onclick: (e) => { if (e.target.closest && e.target.closest('.case-row-cbwrap, .ds-guardrail-toggle-btn')) return; open(); },
  },
    h('label', { key: 'cbw', class: 'case-row-cbwrap', onclick: (e) => e.stopPropagation() },
      h('input', {
        type: 'checkbox', class: 'case-row-cb', title: word('ui.case_row_select_title'),
        'aria-label': word('ui.case_row_select_aria', { entity: entityLabel(), ref: c.ref }),
        checked: selected,
        onclick: (e) => { e.stopPropagation(); toggleBulkSelect(c.id, e.target.checked); },
      })),
    h('div', {
      key: 'main', class: 'case-row-main', role: 'group', tabindex: '0',
      'data-id': c.id,
      'aria-current': active ? 'true' : undefined,
      'aria-label': word('ui.case_row_aria_label', {
        ref: c.ref,
        parts: [
          band ? URGENCY_BAND_LABEL[band] : '',
          stageLabel(c.status),
          owner ? (mine ? word('ui.case_row_you') : ownerName(owner)) : '',
        ].concat(flagWords(c, expandedGuardrails)).filter(Boolean).join(word('ui.case_row_sep_comma')),
      }),
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
        else if ((e.key === ' ' || e.key === 'Spacebar') && e.target === e.currentTarget) { e.preventDefault(); open(); }
      },
    },
      h('div', { key: 'body', class: 'case-row-body' },
        h('div', { key: 'lead', class: 'case-row-lead' }, lead),
        h('div', { key: 'top', class: 'case-row-top' },
          h('span', { key: 'ref', class: 'case-row-ref' }, c.ref),
          Chip({ key: 'stage', tone: stageTone(c.status), size: 'sm', children: stageLabel(c.status) }),
          c.priority === 'urgent' || c.priority === 'high'
            ? Chip({ key: 'pri', tone: 'warn', size: 'sm', children: priorityLabel(c.priority) })
            : null,
          owner ? Chip({ key: 'own', tone: mine ? 'accent' : '', size: 'sm', children: mine ? word('ui.case_row_you') : ownerName(owner) }) : null,
          h('span', { key: 'when', class: 'case-row-when', title: fmtTime(c.updated_at || c.created_at) }, rel(c.updated_at || c.created_at))
        ),
        h('div', { key: 'sub', class: 'case-row-sub' },
          src ? Chip({ key: 'src', tone: src.tone, size: 'sm', tag: true, children: src.label }) : null,
          h('span', { key: 'meta' }, lead === subject ? channelLabel(c.channel) : word('ui.case_row_channel_subject', { channel: channelLabel(c.channel), subject })),
          fillPill(c.fill_rate),
          GuardrailChip({ c, expanded: expandedGuardrails })
        )
      )
    ),
    guardrailToggle
  );
}
