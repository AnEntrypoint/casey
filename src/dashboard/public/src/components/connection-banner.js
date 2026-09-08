// The OFFLINE state, Alert-based, driven by state.connLost. api.js owns that
// flag: a fetch rejection, the service worker's own 503 offline envelope, and
// the quiet-link watch all raise it, so a resolved fetch is never mistaken for
// a reachable origin.
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
// ordinary grey note. The tinted band is what makes this unmistakably not the
// healthy state, which renders no banner at all. The band alone: no rule under
// it, since a one-sided border is decoration the ground already does better.
const BAND = 'background: var(--warn-bg, color-mix(in oklab, var(--warn, var(--amber)) 18%, var(--bg)));'
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
  // The banner also renders over the LOGIN GATE (app-view.js renders it above
  // the unauthed early return), and there the three lines below would each be
  // false: nobody is signed in, there is no last data on screen, and the page
  // cannot catch up on its own because the operator still has to log in. Say
  // the one thing that is true and actionable on that screen instead.
  if (!state.authed) {
    return h('div', {
      class: 'ds-conn-banner is-offline', id: 'conn',
      'data-conn-state': 'offline',
      style: BAND,
    },
      Alert({
        kind: 'warn',
        title: 'Offline -- no signal',
        children: [
          h('div', { key: 'gate' }, 'This device cannot reach the dashboard, so signing in will not work yet.'),
          h('div', { key: 'wait' }, 'Leave this page open -- the form works again as soon as the link comes back. Nothing here is broken and nothing has been lost.'),
        ],
      })
    );
  }
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
