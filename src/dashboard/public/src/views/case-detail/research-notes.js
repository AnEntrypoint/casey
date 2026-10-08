import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section, Spinner, Alert } from '/design/src/components/content.js';
import { Icon } from '/design/src/components/shell.js';
import { schedule } from '../../state.js';
import { fetchRunNotes } from '../../api.js';
import { word } from '../../words.js';
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
        _notes = data ? data.notes : null;
        _notesFor = caseId;
    } catch (e) {
        _error = (e && e.message) || 'Could not load research notes.';
    }
    _loading = false; schedule();
}

function notePreview(text) {
    const stripped = String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    const firstLine = stripped.split('\n').find(l => l.trim()) || word('ui.research_notes_empty');
    return firstLine.replace(/^#+\s*/, '').slice(0, 120);
}

function NoteRow({ note, key } = {}) {
    const isOpen = _expanded.has(note.name);
    if (note.error) {
        return h('div', { key, class: 'casey-research-note casey-research-note--error' },
            Alert({ kind: 'error', children: word('ui.research_notes_read_error', { error: note.error }) }));
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
    if (_notesFor !== c.id) return null;
    if (_error) return null;
    if (_notes == null) return null;
    if (_notes.length === 0) return null;

    return h('div', { key, class: 'casey-research-notes' },
        Section({
            title: word('ui.research_notes_title', { count: _notes.length }),
            children: _loading
                ? Spinner({ label: word('ui.research_notes_loading') })
                : h('div', { class: 'casey-research-notes-list' }, ..._notes.map((note, i) => NoteRow({ note, key: note.name || i }))),
        })
    );
}
