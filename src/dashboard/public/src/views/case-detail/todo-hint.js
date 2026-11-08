import { ageHoursOf } from '../../format.js';
import { state } from '../../state.js';
import { brandName } from '../../vocabulary.js';
import { word } from '../../words.js';

function tagList(c) { return String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean); }

export function todoHintText(c) {
    const brand = brandName();
    const tags = tagList(c);
    if (tags.includes('opted-out')) return word('ui.todo_hint_opted_out');
    if (c.status === 'closed') return word('ui.todo_hint_closed');
    if (tags.includes('needs-human')) return word('ui.todo_hint_needs_human');
    if (tags.includes('draft-pending')) return word('ui.todo_hint_draft', { brand });
    if (tags.includes('health:unanswered_handoff_escalated')) return word('ui.todo_hint_escalated');
    if (tags.includes('health:unanswered_handoff')) return word('ui.todo_hint_handoff');
    if (tags.includes('health:incomplete_critical')) return word('ui.todo_hint_incomplete');
    if (tags.includes('health:abandoned_intake')) return word('ui.todo_hint_abandoned');
    if (c.status === 'waiting' && ageHoursOf(c) >= 24) return word('ui.todo_hint_waiting_day');
    if (tags.includes('health:stuck')) return word('ui.todo_hint_stuck');
    if (tags.includes('health:stale')) return word('ui.todo_hint_stale');
    if (c.autonomy === 'observe') return word('ui.todo_hint_observe', { brand });
    if (c.autonomy === 'assisted') return word('ui.todo_hint_assisted', { brand });
    if (c.status === 'resolved') return word('ui.todo_hint_resolved');
    if (c.status === 'waiting') return word('ui.todo_hint_waiting');
    if (c.status === 'new' || c.status === 'triaging') return word('ui.todo_hint_new', { brand });
    return word('ui.todo_hint_default', { brand });
}
