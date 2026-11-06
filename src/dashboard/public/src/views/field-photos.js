import * as webjsx from '/design/vendor/webjsx/index.js';
import { Section } from '/design/src/components/content.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const SAVED_PHOTO_RE = /\(saved: media\/([^/)\s]+)\/([^/)\s]+\.(?:jpe?g|png|webp|gif))\)/gi;
const ALT_MAX = 120;

export function photoItems(caseId, photosText) {
  const text = String(photosText || '');
  const items = [];
  let from = 0;
  SAVED_PHOTO_RE.lastIndex = 0;
  for (let m = SAVED_PHOTO_RE.exec(text); m; m = SAVED_PHOTO_RE.exec(text)) {
    const note = text.slice(from, m.index).replace(/^[\s;]+/, '').replace(/\s*--\s*auto-description.*$/i, '').trim();
    from = m.index + m[0].length;
    if (m[1] !== String(caseId)) continue;
    items.push({ src: '/media/' + encodeURIComponent(m[1]) + '/' + encodeURIComponent(m[2]), alt: note.slice(0, ALT_MAX) });
  }
  return items;
}

export function PhotosStrip(c, report) {
  const items = photoItems(c.id, report.photos);
  if (!items.length) return null;
  return Section({
    title: word('ui.field_photos_title'),
    children: h('div', { class: 'field-photos' }, ...items.map((p, i) => h('a', {
      key: p.src, class: 'field-photo', href: p.src, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': word('ui.field_photo_open', { n: i + 1, ref: c.ref }),
    }, h('img', { src: p.src, alt: p.alt || word('ui.field_photos_title') + ' ' + (i + 1), loading: 'lazy', decoding: 'async' })))),
  });
}
