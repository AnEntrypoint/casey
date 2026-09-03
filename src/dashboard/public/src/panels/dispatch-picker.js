// Field-worker dispatch picker: a small imperative modal (not webjsx --
// raised alongside the map's own imperative Leaflet driver, see
// map-leaflet.js) letting an operator suggest a worker for a case. Split out
// of map-leaflet.js: distinct responsibility (a picker dialog) from map
// rendering, and kept map-leaflet.js under the 200-line component cap.

import { toast } from '../toasts.js';
import { postDispatch } from '../api.js';

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function showWorkerPicker(title, message, workers) {
    return new Promise((resolve) => {
        function mk(tag, cls, txt) { const el = document.createElement(tag); if (cls) el.className = cls; if (txt != null) el.textContent = txt; return el; }
        const overlay = mk('div', 'ds-dialog-backdrop');
        overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
        const card = mk('div', 'ds-dialog-panel');
        const head = mk('div', 'ds-dialog-head');
        head.appendChild(mk('h3', 'ds-dialog-title', title));
        card.appendChild(head);
        card.appendChild(mk('p', 'ds-dialog-message', message));
        const sel = document.createElement('select');
        sel.className = 'casey-dispatch-select';
        for (const w of workers) {
            const o = document.createElement('option'); o.value = w.id;
            o.textContent = (w.display_name || 'field worker') + (w.km != null ? ` (${w.km.toFixed(1)}km${w.stale ? ', stale' : ''})` : (w.stale ? ' (stale)' : ''));
            sel.appendChild(o);
        }
        card.appendChild(sel);
        card.appendChild(mk('label', 'casey-dispatch-label', 'Optional note for the team'));
        const noteInp = document.createElement('textarea'); noteInp.rows = 2;
        noteInp.className = 'casey-dispatch-note';
        card.appendChild(noteInp);
        const row = mk('div', 'ds-dialog-foot-row');
        const cancelBtn = mk('button', 'casey-dispatch-cancel', 'Cancel');
        const okBtn = mk('button', 'casey-dispatch-ok', 'Suggest dispatch');
        row.appendChild(cancelBtn); row.appendChild(okBtn); card.appendChild(row);
        overlay.appendChild(card); document.body.appendChild(overlay);
        const close = (confirmed) => { overlay.remove(); resolve(confirmed ? { workerId: sel.value, note: noteInp.value || '' } : null); };
        okBtn.onclick = () => close(true);
        cancelBtn.onclick = () => close(false);
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
        setTimeout(() => sel.focus(), 60);
    });
}

export async function openDispatchPicker(mapState, caseId, caseLat, caseLon) {
    const workers = mapState.workers || [];
    if (!workers.length) {
        toast('No field-worker locations loaded yet -- turn on the worker overlay first so there is someone to pick from.', 'warn');
        return;
    }
    const withDist = workers.map((w) => ({ ...w, km: (caseLat != null && caseLon != null && Number.isFinite(w.lat) && Number.isFinite(w.lon)) ? haversineKm(caseLat, caseLon, w.lat, w.lon) : null }))
        .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
    const picked = await showWorkerPicker(
        'Dispatch a worker to this case',
        'This only records a suggestion -- casey never messages a worker unprompted. They will hear about it the next time they message in.',
        withDist);
    if (!picked) return;
    const worker = withDist.find((w) => w.id === picked.workerId);
    try {
        await postDispatch(caseId, { worker_id: picked.workerId, note: picked.note });
        toast('Dispatch suggested -- ' + ((worker && worker.display_name) || 'the worker') + ' will hear about it on their own next reply-in', 'ok');
    } catch (e) { toast('Dispatch error: ' + e.message, 'err'); }
}
