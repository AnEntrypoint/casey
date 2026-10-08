import { word } from '../words.js';

const BROWSER_INTERNAL = /^(failed to fetch|networkerror.*|load failed|the operation was aborted.*|signal is aborted.*)$/i;

export function panelError(what, e) {
  const raw = String((e && e.message) || '').trim();
  const detail = BROWSER_INTERNAL.test(raw) ? word('ui.panel_error_never_reached') : raw;
  return word('ui.panel_error_could_not_load', { what }) + (detail ? word('ui.panel_error_detail', { detail }) : '');
}
