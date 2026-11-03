import * as webjsx from '/design/vendor/webjsx/index.js';

const h = webjsx.createElement;

const WIDTH = 320;
const HEIGHT = 56;
const PAD = 4;

export function Sparkline({ values, label }) {
  const present = values.filter((v) => v != null);
  if (!present.length) return null;
  const low = Math.min(...present);
  const span = (Math.max(...present) - low) || 1;
  const step = values.length > 1 ? (WIDTH - 2 * PAD) / (values.length - 1) : 0;
  const xAt = (i) => PAD + i * step;
  const yAt = (v) => HEIGHT - PAD - ((v - low) / span) * (HEIGHT - 2 * PAD);
  const d = values
    .map((v, i) => (v == null ? null : (i === 0 || values[i - 1] == null ? 'M' : 'L') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1)))
    .filter(Boolean)
    .join(' ');
  return h('svg', {
    class: 'portal-sparkline', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label,
  },
    h('path', { class: 'portal-sparkline-line', d, 'vector-effect': 'non-scaling-stroke' }));
}
