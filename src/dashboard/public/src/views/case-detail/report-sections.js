// report-sections.js -- report field display split into Section()-grouped
// clusters (ux-case-detail-report-field-sections): Visit critical / Animal &
// symptoms / People on site / Notes & media -- replaces the legacy flat
// REPORT_FIELDS list. Field-source and field-note derivation ported
// byte-for-byte in logic from the old app.js fieldSources()/fieldNotes().

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section, Alert } from '/design/src/components/content.js';
import { Chip } from '/design/src/components/shell.js';
import { ReportField } from './report-field.js';
const h = webjsx.createElement;

// [key, plain-language label, section] -- section groups replace the legacy
// single flat list while keeping the exact same field set and labels.
const REPORT_SECTIONS = [
    {
        title: 'Visit critical', keys: [
            ['species', 'Animals'], ['symptoms', 'Signs'], ['location', 'Where'],
            ['how_to_find', 'How to find the place'], ['farmer_available', 'Farmer available?'],
            ['contact_fallback', 'Other contact'],
        ]
    },
    {
        title: 'Animal & symptoms', keys: [
            ['affected_count', 'How many affected'], ['dead_count', 'How many died'],
            ['onset', 'When it started'], ['suspected_disease', 'Suspected disease'],
            ['recent_movement', 'Recent movement'], ['access_notes', 'Access / travel'],
            ['identifying_traits', 'Identifying the animals'],
        ]
    },
    {
        title: 'People on site', keys: [
            ['present_person', 'Who is with the animals'], ['present_person_relation', 'Their link to the owner'],
            ['owner_name', 'Owner name'], ['owner_contact', 'Owner contact'],
        ]
    },
    {
        title: 'Notes & media', keys: [
            ['photos', 'Photos'], ['audio', 'Voice notes'], ['notes', 'Other notes'],
            ['language_detected', 'Language detected'], ['sites', 'Other sites in this visit'],
        ]
    },
];

const VISIT_CRITICAL = [
    ['species', 'what animals'], ['symptoms', 'the signs'], ['location', 'where'],
    ['how_to_find', 'how to find the place'], ['farmer_available', 'if the farmer will be there'],
    ['contact_fallback', 'another contact'],
];

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
    const any = REPORT_SECTIONS.some(sec => sec.keys.some(([k]) => has(r, k)));
    const missingVC = VISIT_CRITICAL.filter(([k]) => !has(r, k));

    const readyBanner = any
        ? (missingVC.length
            ? Alert({ kind: 'warn', title: 'Still missing for a visit', children: missingVC.map(([, l]) => l).join(', ') + ' -- ask now while still reachable.' })
            : Alert({ kind: 'success', children: 'Has what a field visit needs.' }))
        : null;

    const audioVal = has(r, 'audio') ? String(r.audio).trim() : '';
    const audioBanner = audioVal && audioVal.toLowerCase() !== 'no'
        ? Alert({ kind: 'warn', title: 'Voice note on record', children: audioVal + ' -- listen and update the fields below from what you hear.' })
        : null;

    const srcVals = Object.values(src);
    const srcLegend = srcVals.length
        ? h('div', { class: 'casey-rep-src-legend' },
            'Fields from: ',
            srcVals.some(v => v === 'ai' || v === 'both') ? Chip({ size: 'sm', tone: 'accent', children: 'AI collected' }) : null,
            srcVals.some(v => v === 'manual' || v === 'both') ? Chip({ size: 'sm', tone: 'ok', children: 'Operator entered' }) : null)
        : null;

    return h('div', { key, class: 'casey-report' },
        h('div', { class: 'casey-report-head' }, 'Report from the field', any ? null : h('span', { class: 'casey-rep-missing' }, ' (nothing recorded yet)')),
        srcLegend, readyBanner, audioBanner,
        ...REPORT_SECTIONS.map(sec => h('div', { key: sec.title }, Section({
            title: sec.title,
            children: sec.keys.map(([k, label]) => ReportField({
                key: k, caseId: c.id, k, label, value: has(r, k) ? String(r[k]) : '',
                source: src[k], notes: fnotes[k], onSaved
            }))
        })))
    );
}
