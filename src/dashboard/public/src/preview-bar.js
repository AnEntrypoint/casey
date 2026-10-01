// The bar across the top while an admin is previewing another login (api.js setViewAs). It is a plain element outside the
// app's own render so it shows over the admin, ranger, technician and viewer apps alike, and says what is going on:
// whose dashboard this is, that it is read-only, and how to leave.
import { setViewAs, viewAsId } from './api.js';

export function syncPreviewBar(whoami) {
  const old = document.getElementById('casey-preview-bar');
  const on = !!(whoami && whoami.authed && whoami.view_as && viewAsId());
  if (!on) { if (old) old.remove(); document.body.classList.remove('casey-previewing'); return; }
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.id = 'casey-preview-bar';
  bar.setAttribute('role', 'status');
  const who = whoami.display_name || whoami.username || 'this login';
  const text = document.createElement('span');
  text.textContent = 'Previewing ' + who + ' (' + String(whoami.role || '').replace(/_/g, ' ') + '). Read-only: nothing you do here changes anything.';
  const leave = document.createElement('button');
  leave.type = 'button';
  leave.textContent = 'Leave the preview';
  leave.addEventListener('click', () => setViewAs(''));
  bar.append(text, leave);
  document.body.prepend(bar);
  document.body.classList.add('casey-previewing');
}
