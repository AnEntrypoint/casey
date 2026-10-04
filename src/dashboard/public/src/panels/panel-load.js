import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { schedule } from '../state.js';
import { panelError } from './panel-error.js';

export function createPanelLoader({ what, label, fetch, apply }) {
    const resolve = (v) => (typeof v === 'function' ? v() : v);
    let loaded = false;
    let loading = false;
    let error = null;
    let generation = 0;

    function run() {
        const gen = ++generation;
        loading = true;
        Promise.resolve().then(fetch).then((j) => {
            if (gen !== generation) return;
            apply(j);
            loaded = true; loading = false; error = null; schedule();
        }).catch((e) => {
            if (gen !== generation) return;
            loaded = true; loading = false; error = panelError(resolve(what), e); schedule();
        });
    }

    return {
        ensureLoaded() {
            if (loaded || loading) return;
            run();
        },

        reload() {
            loaded = false;
            schedule();
            run();
        },

        pending() { return loading && !loaded; },

        error() { return error; },

        slot(content) {
            if (loading && !loaded) return Spinner({ label: resolve(label) });
            if (error) return Alert({ kind: 'error', children: error });
            return content();
        },
    };
}
