const BROWSER_INTERNAL = /^(failed to fetch|networkerror.*|load failed|the operation was aborted.*|signal is aborted.*)$/i;

export function panelError(what, e) {
  const raw = String((e && e.message) || '').trim();
  const detail = BROWSER_INTERNAL.test(raw) ? 'the request never reached the server' : raw;
  return `Could not load ${what}. Try again in a moment.` + (detail ? ` (${detail})` : '');
}
