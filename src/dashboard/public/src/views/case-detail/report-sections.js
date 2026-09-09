// report-sections.js -- report field display split into Section()-grouped
// clusters (ux-case-detail-report-field-sections), section titles/fields
// declared by the active config package's report-fields.yml and served via
// /api/config -- replaces the legacy flat REPORT_FIELDS list. Field-source
// and field-note derivation ported byte-for-byte in logic from the old
// app.js fieldSources()/fieldNotes().

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section, Alert } from '/design/src/components/content.js';
import { ReportField } from './report-field.js';
import { state } from '../../state.js';
const h = webjsx.createElement;

// [key, plain-language label, section] -- driven by the live /api/config
// payload (report_sections/visit_critical, see dashboard/routes/operations.js
// and store/report-shape.js) so this view renders whatever field vocabulary
// the active config package declares, instead of a hardcoded animal-health
// field-label table. Empty array (config not yet fetched) renders no
// sections rather than throwing.
//
// state.runConfig (see fetchRunConfig/case-detail-view.js's loadCaseDetail)
// is a per-case override for a deployment where concurrent cases can carry
// genuinely different field vocabularies (e.g. serpent's per-run schema) --
// it takes priority over the global state.config when set, and is null on a
// plain casey/uhh deployment or before the per-case fetch resolves, in which
// case this falls back to the global config exactly as before this existed.
const activeConfig = () => state.runConfig || state.config;
const reportSections = () => activeConfig()?.report_sections || [];
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

    // EXCEPTION-ONLY, like health-notices.js: this banner exists to say a
    // visit cannot go ahead yet, and when it can, it says nothing at all.
    //
    // There used to be a standing green "Has what a field visit needs." on
    // every complete report. Three arguments against it, and the third is the
    // one that matters. It is unfalsifiable praise -- the six visit-critical
    // keys being non-blank is not the same claim as a visit being possible,
    // and "Where: somewhere near Warden" satisfies the check. It appears on
    // the ordinary case, which is the definition of noise. And an operator
    // who sees a green banner on every healthy report stops reading the
    // banner, which is precisely the reading habit the amber one depends on.
    const readyBanner = (any && missingVC.length)
        ? Alert({ kind: 'warn', title: 'Still missing for a visit', children: missingVC.map(([, l]) => l).join(', ') + ' -- ask now while still reachable.' })
        : null;

    const audioVal = has(r, 'audio') ? String(r.audio).trim() : '';
    const audioBanner = audioVal && audioVal.toLowerCase() !== 'no'
        ? Alert({ kind: 'warn', title: 'Voice note on record', children: audioVal + ' -- listen and update the fields below from what you hear.' })
        : null;

    // The per-field source marker stays -- see report-field.js for why a
    // marker earns its shape on a row of a 28-row list where the header of
    // this same block does not. What went was the LEGEND that used to sit
    // here: a line reading "Fields from:" followed by one chip per value the
    // rows below already spell out in full, directly above the rows that
    // spell them out. Chrome explaining chrome, in the position a reader
    // gives most weight to, restating nothing they had not already been told
    // two lines later.

    const entityLabel = activeConfig()?.entity_label || 'report';
    return h('div', { key, class: 'casey-report' },
        h('div', { class: 'casey-report-head' }, `${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} details`),
        any ? null : h('p', { class: 'casey-hint' }, 'Nothing has been recorded on this ' + entityLabel + ' yet. Tap any line below to fill it in.'),
        readyBanner, audioBanner,
        ...sections.map(sec => h('div', { key: sec.title }, Section({
            title: sec.title,
            children: sec.keys.map(([k, label, multiline]) => ReportField({
                key: k, caseId: c.id, k, label, value: has(r, k) ? String(r[k]) : '',
                source: src[k], notes: fnotes[k], multiline, onSaved,
                // The head already says the whole report is blank. Repeating
                // "not given yet" on all 28 rows two inches below it states
                // one fact twice in two different phrasings; the ruled
                // writing space stays either way, so an empty row is still
                // visibly a row you can fill in.
                sayMissing: any,
            }))
        })))
    );
}
