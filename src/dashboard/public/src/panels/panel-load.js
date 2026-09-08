// One lazy-load cell for a panel: fetch once per page load, show the skeleton
// only on the FIRST load, and say the same operator-facing sentence on every
// failure.
//
// This existed as eleven hand-copied variations before it existed as a module.
// Every copy carried the same four lines, and the copies had drifted into four
// shapes and three force-reload spellings that all produced the SAME screen:
//
//   V1 plain            clusters, distribution, geo, stats, team
//   V2 plain + a post-success side effect or derived state
//                       offline (setOfflineQueueCount), settings (draft),
//                       metrics (three fetches composed into one object)
//   V3 split load()/ensureLoaded(), parameterised by a filter
//                       secretary
//   V4 no `loaded` flag at all, a separate `started` boolean instead
//                       activity
//
//   R1  loaded = false; ensureLoaded()   contacts (x2), handover, settings
//   R2  loaded = false; load()           secretary's filter buttons
//   R3  load()                           activity's filter selects
//
// The four shapes differ only in WHAT is fetched and what happens to the
// answer, which is two callbacks. The three reload spellings differ only in
// which function they re-enter through, and they render identically: each one
// clears the "we have content" flag, so the skeleton replaces the stale table
// in all three. None of the eleven kept stale content on a forced reload --
// that behaviour lives only in map-panel.js, which is a different mechanism
// (an `inFlight` latch around an imperative Leaflet driver) and is deliberately
// not built on this.
//
// Two subtleties are the reason this is worth having in one place at all:
//
//   1. `loaded` is set to true in the FAILURE path too. It does not mean "we
//      have data", it means "the first attempt has finished". Panels call
//      ensureLoaded() from inside their own render function, so a failed load
//      that left `loaded` false would refetch on the very next render and spin
//      forever against a server that is down.
//   2. The skeleton is gated on `loading && !loaded`, not on `loading`. A panel
//      that has content on screen and is refetching should not be able to flash
//      a spinner in place of a table an operator is reading.
//
// The one thing that is NOT a straight transcription of the eleven copies is
// the generation counter. R1 re-entered through ensureLoaded(), whose in-flight
// guard silently DROPPED a forced reload that arrived while the first load was
// still running -- for secretary that meant clicking "Mine" during the opening
// fetch left the old filter's rows on screen under the new filter's highlight,
// with nothing left to correct it. R2/R3 had the opposite failure: they always
// refetched, so two overlapping loads raced and whichever answered last won,
// which is not necessarily the one the operator asked for last. reload() here
// always refetches, and a response from a superseded request is discarded, so
// the newest request is the one that lands.

import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { schedule } from '../state.js';
import { panelError } from './panel-error.js';

// what   the noun panelError() puts in "Could not load <what>."
// label  the Spinner's accessible label while the first load is running
// fetch  returns a promise for whatever this panel needs; compose several
//        requests here when the panel needs more than one
// apply  receives the resolved value; writes it wherever the panel's render
//        reads it from, and does any post-success bookkeeping
export function createPanelLoader({ what, label, fetch, apply }) {
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
            loaded = true; loading = false; error = panelError(what, e); schedule();
        });
    }

    return {
        // Call from the panel's render. Idempotent: the panel is re-rendered by
        // every schedule() in the app, and only the first of those may fetch.
        ensureLoaded() {
            if (loaded || loading) return;
            run();
        },

        // Call when something the operator did means the answer on screen is now
        // wrong -- a filter changed, a tier was promoted, settings were saved.
        // Schedules its own render so the click paints the skeleton immediately
        // rather than waiting for whatever the caller happens to do next.
        reload() {
            loaded = false;
            schedule();
            run();
        },

        // True only while the FIRST load is running. See note 2 above.
        pending() { return loading && !loaded; },

        // The operator-facing sentence, or null. Panels that render their own
        // shell (settings) read this directly; the rest go through slot().
        error() { return error; },

        // The common render: skeleton, or the failure sentence, or the panel's
        // own content. Returns a node for whatever wrapper the panel puts it in
        // -- this owns the three-way choice, never the wrapper.
        slot(content) {
            if (loading && !loaded) return Spinner({ label });
            if (error) return Alert({ kind: 'error', children: error });
            return content();
        },
    };
}
