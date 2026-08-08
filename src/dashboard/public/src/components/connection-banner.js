// "Connection lost - retrying..." banner, Alert-based, driven by state.connLost.

import * as webjsx from 'webjsx';
import { Alert } from 'ds/components/content.js';
import { state } from '../state.js';
const h = webjsx.createElement;

export function ConnectionBanner() {
  if (!state.connLost) return null;
  return h('div', { class: 'ds-conn-banner', id: 'conn' },
    Alert({ kind: 'warn', title: 'Connection lost', children: 'Retrying...' })
  );
}
