// research-notes.js -- read-only panel showing a research run's accumulated
// notes folder (freddie's contribute()/contributeRaw()-written markdown
// notes: search results, agent-contributed observations). This is the
// dashboard surface the collected research data had NONE of until this
// existed -- casey's own case-detail view only ever rendered report fields
// and a one-line audit-log summary per research action, never the actual
// note bodies. Only reachable when a deployer mounts a /api/runs/:id/notes
// route (e.g. serpent's dashboard-routes.js) -- absent that route (casey's
// own default, uhh), fetchRunNotes 404s and this panel renders nothing,
// matching report-sections.js's own per-run-config degrade discipline.

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section, Spinner, Alert } from '/design/src/components/content.js';
import { Btn, Icon } from '/design/src/components/shell.js';
import { state, schedule } from '../../state.js';
import { fetchRunNotes } from '../../api.js';
const h = webjsx.createElement;

let _notesFor = null;
let _notes = null;
let _loading = false;
let _error = null;
let _expanded = new Set();

function toggleExpanded(name) {
    if (_expanded.has(name)) _expanded.delete(name); else _expanded.add(name);
    schedule();
}

export async function loadResearchNotes(caseId) {
    _loading = true; _error = null; schedule();
    try {
        const data = await fetchRunNotes(caseId);
        // null means the route doesn't exist on this deployment (casey's own
        // default, uhh) -- never an error, just nothing to render.
        _notes = data ? data.notes : null;
        _notesFor = caseId;
    } catch (e) {
        _error = (e && e.message) || 'Could not load research notes.';
    }
    _loading = false; schedule();
}

// Strips the machine-readable HTML-comment header (contributorId/ts, or the
// research route's own markdown structure) down to a short one-line preview
// for the collapsed row -- the full body still renders in full once expanded.
function notePreview(text) {
    const stripped = String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    const firstLine = stripped.split('\n').find(l => l.trim()) || '(empty note)';
    return firstLine.replace(/^#+\s*/, '').slice(0, 120);
}

function NoteRow({ note, key } = {}) {
    const isOpen = _expanded.has(note.name);
    if (note.error) {
        return h('div', { key, class: 'casey-research-note casey-research-note--error' },
            Alert({ kind: 'error', children: `Could not read this note: ${note.error}` }));
    }
    return h('div', { key, class: 'casey-research-note' },
        h('button', {
            type: 'button', class: 'casey-research-note-toggle',
            onclick: () => toggleExpanded(note.name),
        }, h('span', { class: 'casey-research-note-caret' }, Icon(isOpen ? 'chevron-down' : 'chevron-right', { size: 13 })), notePreview(note.text)),
        isOpen ? h('pre', { class: 'casey-research-note-body' }, note.text) : null
    );
}

export function ResearchNotesPanel({ case: c, key } = {}) {
    if (_notesFor !== c.id && !_loading) loadResearchNotes(c.id);
    if (_notesFor !== c.id) return null; // no flash of stale content from the prior case
    if (_error) return null; // network hiccup -- degrade silently, matches fetchRunConfig discipline
    if (_notes == null) return null; // route absent on this deployment (casey's own default, uhh)
    if (_notes.length === 0) return null; // nothing collected yet -- no empty panel clutter

    return h('div', { key, class: 'casey-research-notes' },
        Section({
            title: `Research notes (${_notes.length})`,
            children: _loading
                ? Spinner({ label: 'loading notes' })
                : h('div', { class: 'casey-research-notes-list' }, ..._notes.map((note, i) => NoteRow({ note, key: note.name || i }))),
        })
    );
}
