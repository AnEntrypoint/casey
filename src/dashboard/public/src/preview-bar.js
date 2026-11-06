import { setViewAs, viewAsId } from './api.js';
import { word } from './words.js';

export function syncPreviewBar(whoami) {
  const old = document.getElementById('casey-preview-bar');
  const on = !!(whoami && whoami.authed && whoami.view_as && viewAsId());
  if (!on) { if (old) old.remove(); document.body.classList.remove('casey-previewing'); return; }
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.id = 'casey-preview-bar';
  bar.setAttribute('role', 'status');
  const who = whoami.display_name || whoami.username || word('ui.preview_bar_this_login');
  const text = document.createElement('span');
  text.textContent = word('ui.preview_bar_text', { who, role: String(whoami.role || '').replace(/_/g, ' ') });
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.textContent = word('ui.preview_bar_leave');
  leave.addEventListener('click', () => setViewAs(''));
  bar.append(text, leave);
  document.body.prepend(bar);
  document.body.classList.add('casey-previewing');
}
