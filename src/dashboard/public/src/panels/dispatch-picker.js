import * as webjsx from '/design/vendor/webjsx/index.js';
import { Select, TextField } from '/design/src/components/content/fields.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { toast } from '../toasts.js';
import { postDispatch } from '../api.js';
import { brandName } from '../vocabulary.js';

const brand = brandName;
const h = webjsx.createElement;

function openerSignature(el) {
    return [
        el.tagName,
        (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        (el.className || '').toString(),
    ].join('|');
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function showWorkerPicker(title, message, workers) {
    return new Promise((resolve) => {
        let workerId = workers[0] ? workers[0].id : '', note = '';
        const returnFocus = document.activeElement;
        const returnSig = returnFocus && returnFocus.tagName ? openerSignature(returnFocus) : '';
        const titleId = 'dispatch-picker-title';
        const overlay = document.createElement('div');
        overlay.className = 'ds-dialog-backdrop';
        overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', titleId);
        const close = (confirmed) => {
            overlay.remove();
            let target = returnFocus;
            if (target && !target.isConnected) target = [...document.querySelectorAll(returnFocus.tagName)].find((c) => openerSignature(c) === returnSig) || null;
            if (target && typeof target.focus === 'function') target.focus();
            resolve(confirmed ? { workerId, note } : null);
        };
        const workerLabel = (w) => (w.display_name || 'field worker')
            + (w.km != null ? ` (${w.km.toFixed(1)}km${w.stale ? ', stale' : ''})` : (w.stale ? ' (stale)' : ''));
        webjsx.applyDiff(overlay, h('div', { class: 'ds-dialog-panel' },
            h('div', { key: 'head', class: 'ds-dialog-head' }, h('h3', { id: titleId, class: 'ds-dialog-title' }, title)),
            h('p', { key: 'msg', class: 'ds-dialog-message' }, message),
            Select({ key: 'who', label: 'Who should go', name: 'worker', value: workerId, options: workers.map((w) => ({ value: w.id, label: workerLabel(w) })), onChange: (v) => { workerId = v; } }),
            TextField({ key: 'note', label: 'Optional note for the team', name: 'note', multiline: true, rows: 2, value: '', onInput: (v) => { note = v; } }),
            h('div', { key: 'foot', class: 'ds-dialog-foot-row' },
                Btn({ variant: 'ghost', children: 'Cancel', onClick: () => close(false) }),
                Btn({ variant: 'primary', children: 'Suggest dispatch', onClick: () => close(true) }))));
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(false); return; }
            if (e.key !== 'Tab') return;
            const focusable = [...overlay.querySelectorAll('button, select, textarea, input, [href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        });
        document.body.appendChild(overlay);
        setTimeout(() => { const sel = overlay.querySelector('select'); if (sel) sel.focus(); }, 60);
    });
}

export async function openDispatchPicker(mapState, caseId, caseLat, caseLon) {
    const workers = mapState.workers || [];
    if (!workers.length) {
        toast('No field-worker locations loaded yet. Turn on the Workers overlay first, so there is someone to pick from.', 'warn');
        return;
    }
    const withDist = workers.map((w) => ({ ...w, km: (caseLat != null && caseLon != null && Number.isFinite(w.lat) && Number.isFinite(w.lon)) ? haversineKm(caseLat, caseLon, w.lat, w.lon) : null }))
        .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
    const picked = await showWorkerPicker(
        'Dispatch a worker to this case',
        'This only records a suggestion. ' + brand() + ' never messages a worker unprompted; they will hear about it the next time they message in.',
        withDist);
    if (!picked) return;
    const worker = withDist.find((w) => w.id === picked.workerId);
    try {
        await postDispatch(caseId, { worker_id: picked.workerId, note: picked.note });
        toast('Dispatch suggested. ' + ((worker && worker.display_name) || 'The worker') + ' will hear about it on their own next reply-in.', 'ok');
    } catch (e) { toast('The suggestion was not recorded, so nobody has been told. Try again, or contact the worker directly.', 'err'); }
}
