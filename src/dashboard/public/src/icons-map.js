// icons-map.js -- one place mapping casey's semantic names (event kinds,
// report source tags) to design-SDK Icon() names, so a status color/icon
// pairing is decided once, not per-call-site. Every value here MUST exist in
// the design SDK's ICON_PATHS registry (/design/src/components/shell/icons.js)
// -- an unknown name renders an empty span, a silent bug, so keep this list
// checked against that registry.

export const SOURCE_LABEL = { ai: 'AI', manual: 'Manual', both: 'Both' };

// Event-timeline kind -> icon/tone pairing (ux-case-detail-timeline-visual-distinction).
// tone matches the Chip/Alert tone vocabulary ('' | 'ok' | 'warn' | 'error' | 'accent').
export const EVENT_KIND_ICON = {
  inbound: 'arrow-down', outbound: 'send', transition: 'arrow-right',
  note: 'pencil', observation: 'circle-dot', action: 'activity',
  autonomy_change: 'settings', draft: 'megaphone',
};
export const EVENT_KIND_TONE = {
  inbound: 'accent', outbound: 'ok', transition: 'muted', note: 'warn',
  observation: 'muted', action: 'accent', autonomy_change: 'warn', draft: 'warn',
};
export function eventIcon(kind) { return EVENT_KIND_ICON[kind] || 'circle'; }
export function eventTone(kind) { return EVENT_KIND_TONE[kind] || 'muted'; }
