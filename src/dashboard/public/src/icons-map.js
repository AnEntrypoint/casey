export const SOURCE_LABEL = { ai: 'AI collected', manual: 'Operator entered', both: 'AI, then checked' };

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
