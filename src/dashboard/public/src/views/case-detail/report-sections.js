import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section, Alert } from '/design/src/components/content.js';
import { ReportField } from './report-field.js';
import { state } from '../../state.js';
import { word } from '../../words.js';
import { EntityLabel } from '../../vocabulary.js';
const h = webjsx.createElement;

const activeConfig = () => state.runConfig || state.config;
const hiddenKeys = () => new Set(activeConfig()?.hidden_fields || []);
const reportSections = () => {
    const hide = hiddenKeys();
    return (activeConfig()?.report_sections || [])
        .map(sec => ({ ...sec, keys: sec.keys.filter(([k]) => !hide.has(k)) }))
        .filter(sec => sec.keys.length);
};
const visitCritical = () => (activeConfig()?.visit_critical || []).map(f => [f.key, f.label]);

const has = (r, k) => r[k] != null && String(r[k]).trim() !== '';

export function fieldSources(events) {
    const src = {};
    for (const e of (events || [])) {
        if (e.kind !== 'action') continue;
        const isAgent = e.actor === 'agent', isOp = e.actor === 'operator';
        if (!isAgent && !isOp) continue;
        const m = (e.text || '').match(/(?:recorded|updated) report fields?(?:[^:]*)?:[ ]*(.+)/i);
        if (!m) continue;
        const keys = m[1].split(',').map(s => s.trim()).filter(Boolean);
        for (const k of keys) {
            if (isAgent) src[k] = src[k] === 'manual' ? 'both' : 'ai';
            else src[k] = src[k] === 'ai' ? 'both' : 'manual';
        }
    }
    return src;
}

export function fieldNotes(events) {
    const notes = {};
    for (const e of (events || [])) {
        if (e.kind !== 'note' || !e.data || !e.data.field) continue;
        if (!notes[e.data.field]) notes[e.data.field] = [];
        notes[e.data.field].push({ text: e.text, created_at: e.created_at });
    }
    return notes;
}

function parseReport(raw) {
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function ReportSections({ c, events, onSaved, key } = {}) {
    const r = parseReport(c.report);
    const src = fieldSources(events);
    const fnotes = fieldNotes(events);
    const sections = reportSections();
    const any = sections.some(sec => sec.keys.some(([k]) => has(r, k)));
    const missingVC = visitCritical().filter(([k]) => !has(r, k));

    const readyBanner = (any && missingVC.length)
        ? Alert({ kind: 'warn', title: word('ui.missing_for_visit_title'), children: missingVC.map(([, l]) => l).join(', ') + ' ' + word('ui.missing_for_visit_hint') })
        : null;

    const audioVal = has(r, 'audio') ? String(r.audio).trim() : '';
    const audioBanner = audioVal && audioVal.toLowerCase() !== 'no'
        ? Alert({ kind: 'warn', title: 'Voice note on record', children: audioVal + ' -- listen and update the fields below from what you hear.' })
        : null;

    const entityLabel = activeConfig()?.entity_label || 'report';
    return h('div', { key, class: 'casey-report' },
        h('div', { class: 'casey-report-head' }, `${EntityLabel()} ${word('ui.details_heading_suffix')}`),
        any ? null : h('p', { class: 'casey-hint' }, 'Nothing has been recorded on this ' + entityLabel + ' yet. Tap any line below to fill it in.'),
        readyBanner, audioBanner,
        ...sections.map(sec => h('div', { key: sec.title }, Section({
            title: sec.title,
            children: sec.keys.map(([k, label, multiline]) => ReportField({
                key: k, caseId: c.id, k, label, value: has(r, k) ? String(r[k]) : '',
                source: src[k], notes: fnotes[k], multiline, onSaved,
                sayMissing: any,
            }))
        })))
    );
}
