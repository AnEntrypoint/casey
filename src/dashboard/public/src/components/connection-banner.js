// The OFFLINE state, Alert-based, driven by state.connLost.
//
// This used to say "Connection lost / Retrying..." and, on a device with a
// warm service-worker cache, it never rendered at all: api.js concluded the
// link was fine because the fetch RESOLVED, when what resolved was the
// worker's own 503 offline envelope. So the one screen that had to say "you
// are looking at old data" said nothing, and the SPA showed a login form
// instead (see auth.js).
//
// It states three things, because on an intermittently connected rural link
// an operator has to be able to act on all three without asking anyone:
//   1. THE LINK IS DOWN -- not that they are logged out, and not that the
//      dashboard is broken.
//   2. THEY ARE STILL SIGNED IN, and what is on screen is the last data this
//      device actually received, with the time it arrived rather than a
//      relative age. A relative age would be a lie here: with the polls dead
//      there is no event left to re-render it, so "2m ago" would freeze on
//      screen and quietly keep claiming 2 minutes for the rest of the outage.
//   3. IT RECOVERS BY ITSELF -- no reload, no re-login. auth.js re-verifies
//      the session on the first real response and the polls refill the data.

import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
import { fmtTime } from '../format.js';
const h = webjsx.createElement;

// The kit's Alert(kind:'warn') tints only its icon and leaves the panel
// background neutral in both themes (app.css says so where .ds-handoff-banner
// overrides exactly this), which would leave "no signal" looking like an
// ordinary grey note. The band around it is what makes this unmistakably not
// the healthy state -- which renders no banner at all -- and not the login
// gate, which is a centred form on a plain ground.
const BAND = 'background: var(--warn-bg, color-mix(in oklab, var(--warn, var(--amber)) 18%, var(--bg)));'
  + ' border-bottom: 2px solid var(--warn, var(--amber));'
  + ' padding: var(--space-1, 4px);';

export function ConnectionBanner() {
  if (!state.connLost) return null;
  const who = state.currentUser && state.currentUser.username;
  // A Date, not the raw millisecond number: format.js's toDate() treats ANY
  // bare number as unix SECONDS (busybase returns numeric-second strings), so
  // handing it Date.now() renders the year 58655. Live-witnessed before this
  // line said `new Date(...)`: "Showing the last data received, at 05 Aug
  // 58655, 12:22 SAST."
  const since = state.connLostSince ? fmtTime(new Date(state.connLostSince)) : '';
  const lines = [
    h('div', { key: 'signed' },
      who ? `Still signed in as ${who}` : 'Still signed in',
      state.sessionRestored
        ? ' -- carried over from the last time this device reached the dashboard, and re-checked automatically when the link returns.'
        : ' -- your session is unaffected.'),
    h('div', { key: 'data' }, since
      ? `Showing the last data received, at ${since}. Nothing on this screen is updating.`
      : 'Showing the last data received. Nothing on this screen is updating.'),
    h('div', { key: 'recover' }, 'No need to reload or log in again -- the page catches up on its own once the link comes back.'),
  ];
  return h('div', {
    class: 'ds-conn-banner is-offline', id: 'conn',
    'data-conn-state': 'offline',
    style: BAND,
  },
    Alert({ kind: 'warn', title: 'Offline -- no signal', children: lines })
  );
}
