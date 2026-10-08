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
      who ? word('ui.connection_banner_signed_in_as', { who }) : word('ui.connection_banner_signed_in'),
      state.sessionRestored
        ? word('ui.connection_banner_carried_over')
        : word('ui.connection_banner_session_unaffected')),
    h('div', { key: 'data' }, since
      ? word('ui.connection_banner_last_data_at', { since })
      : word('ui.connection_banner_last_data')),
    h('div', { key: 'recover' }, word('ui.connection_banner_no_reload')),
  ];
  return h('div', {
    class: 'ds-conn-banner is-offline', id: 'conn',
    'data-conn-state': 'offline',
    style: BAND,
  },
    Alert({ kind: 'warn', title: word('ui.offline_title'), children: lines })
  );
}
