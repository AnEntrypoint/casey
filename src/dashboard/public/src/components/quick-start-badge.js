// New-case badge count in Topbar + navigator.setAppBadge wiring (the visual
// piece rides Badge; the app-badge API call itself lives in handoff-banner.js
// setInboxBadge, shared with the title-flash count so there is one counter).

import * as webjsx from 'webjsx';
import { Badge } from 'ds/components/shell.js';
import { state } from '../state.js';
const h = webjsx.createElement;

export function QuickStartBadge() {
  const n = state.attention.length;
  if (!n) return null;
  return h('span', { class: 'ds-quick-start-badge' }, Badge({ tone: 'warn', children: String(n) }));
}
