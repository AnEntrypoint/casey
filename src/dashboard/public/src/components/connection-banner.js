import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
import { fmtTime } from '../format.js';
import { word } from '../words.js';
const h = webjsx.createElement;

const BAND = 'background: var(--warn-bg, color-mix(in oklab, var(--warn, var(--amber)) 18%, var(--bg)));'
  + ' padding: var(--space-1, 4px);';

export function ConnectionBanner() {
  if (!state.connLost) return null;
  const who = state.currentUser && state.currentUser.username;
  const since = state.connLostSince ? fmtTime(new Date(state.connLostSince)) : '';
  if (!state.authed) {
    return h('div', {
      class: 'ds-conn-banner is-offline', id: 'conn',
      'data-conn-state': 'offline',
      style: BAND,
    },
      Alert({
        kind: 'warn',
        title: word('ui.offline_title'),
        children: [
          h('div', { key: 'gate' }, word('ui.offline_login_line')),
          h('div', { key: 'wait' }, word('ui.offline_login_wait')),
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
    Alert({ kind: 'warn', title: word('ui.offline_title'), children: lines })
  );
}
