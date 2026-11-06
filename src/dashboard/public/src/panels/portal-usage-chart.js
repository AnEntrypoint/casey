import * as webjsx from '/design/vendor/webjsx/index.js';
import { state } from '../state.js';
import { word } from '../words.js';
import { formatBytes, STEP_MS } from './portal-format.js';

const h = webjsx.createElement;

const WIDTH = 720;
const HEIGHT = 280;
const PLOT = { top: 12, right: 12, bottom: 40, left: 72 };
const PLOT_W = WIDTH - PLOT.left - PLOT.right;
const PLOT_H = HEIGHT - PLOT.top - PLOT.bottom;
const BUCKET_WORD = { hour: 'ui.portal_usage_bucket_hour', day: 'ui.portal_usage_bucket_day' };
const MAX_X_LABELS = 6;
const Y_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

export function bucketTotals(series, bucket) {
  const step = STEP_MS[bucket] || STEP_MS.hour;
  const totals = new Map();
  for (const row of series) {
    const t = Date.parse(row.t);
    if (!Number.isFinite(t)) continue;
    const total = totals.get(t) || { down: 0, up: 0 };
    total.down += row.down_bytes || 0;
    total.up += row.up_bytes || 0;
    totals.set(t, total);
  }
  if (!totals.size) return [];
  const times = [...totals.keys()];
  const first = Math.min(...times);
  const last = Math.max(...times);
  const buckets = [];
  for (let t = first; t <= last; t += step) {
    const total = totals.get(t) || { down: 0, up: 0 };
    buckets.push({ t, down: total.down, up: total.up });
  }
  return buckets;
}

function niceCeiling(value) {
  if (!(value > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  return [1, 2, 5, 10].map((m) => m * magnitude).find((c) => c >= value);
}

function axisTime(t, bucket) {
  const zone = (state.config && state.config.tz) || 'Africa/Johannesburg';
  const options = bucket === 'day'
    ? { timeZone: zone, day: 'numeric', month: 'short' }
    : { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return new Date(t).toLocaleString('en-ZA', options);
}

function LegendItem(swatchClass, text) {
  return h('span', { class: 'portal-usage-legend-item' },
    h('span', { class: 'portal-swatch ' + swatchClass }),
    text);
}

export function UsageChart({ buckets, bucket }) {
  const total = buckets.reduce((sum, b) => sum + b.down + b.up, 0);
  if (!total) return h('p', { class: 'casey-hint' }, word('ui.portal_usage_empty'));
  const unit = word(BUCKET_WORD[bucket] || BUCKET_WORD.hour);
  const yMax = niceCeiling(Math.max(...buckets.map((b) => b.down + b.up)));
  const slot = PLOT_W / buckets.length;
  const barWidth = Math.max(1, slot * 0.72);
  const baseline = PLOT.top + PLOT_H;
  const yAt = (bytes) => baseline - (bytes / yMax) * PLOT_H;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / MAX_X_LABELS));

  const yTicks = Y_FRACTIONS.flatMap((fraction) => {
    const value = yMax * fraction;
    const y = yAt(value);
    return [
      h('line', { key: 'grid' + fraction, class: 'portal-chart-grid', x1: PLOT.left, x2: WIDTH - PLOT.right, y1: y, y2: y }),
      h('text', { key: 'ytick' + fraction, class: 'portal-chart-label', x: PLOT.left - 8, y: y + 4, 'text-anchor': 'end' }, formatBytes(value)),
    ];
  });

  const bars = buckets.map((b, i) => {
    const x = PLOT.left + i * slot + (slot - barWidth) / 2;
    const downHeight = (b.down / yMax) * PLOT_H;
    const upHeight = (b.up / yMax) * PLOT_H;
    return h('g', { key: 'bar' + i },
      h('title', {}, word('ui.portal_usage_bar_title', { time: axisTime(b.t, bucket), down: formatBytes(b.down), up: formatBytes(b.up) })),
      h('rect', { class: 'portal-chart-bar-down', x, y: baseline - downHeight, width: barWidth, height: downHeight }),
      h('rect', { class: 'portal-chart-bar-up', x, y: baseline - downHeight - upHeight, width: barWidth, height: upHeight }));
  });

  const xLabels = buckets.flatMap((b, i) => (i % labelEvery === 0
    ? [h('text', { key: 'xtick' + i, class: 'portal-chart-label', x: PLOT.left + i * slot + slot / 2, y: baseline + 18, 'text-anchor': 'middle' }, axisTime(b.t, bucket))]
    : []));

  const axes = [
    h('line', { key: 'axis-x', class: 'portal-chart-axis', x1: PLOT.left, x2: WIDTH - PLOT.right, y1: baseline, y2: baseline }),
    h('line', { key: 'axis-y', class: 'portal-chart-axis', x1: PLOT.left, x2: PLOT.left, y1: PLOT.top, y2: baseline }),
    h('text', { key: 'axis-time', class: 'portal-chart-label', x: WIDTH - PLOT.right, y: HEIGHT - 4, 'text-anchor': 'end' }, word('ui.portal_usage_axis_time')),
    h('text', { key: 'axis-data', class: 'portal-chart-label', x: 14, y: PLOT.top + PLOT_H / 2, transform: `rotate(-90 14 ${PLOT.top + PLOT_H / 2})`, 'text-anchor': 'middle' }, word('ui.portal_usage_axis_data')),
  ];

  return h('div', { class: 'portal-usage-chart' },
    h('p', { class: 'casey-hint' }, word('ui.portal_usage_chart_caption', { unit })),
    h('svg', {
      class: 'portal-chart', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img',
      'aria-label': word('ui.portal_usage_chart_summary', { unit, count: buckets.length, total: formatBytes(total) }),
    }, ...yTicks, ...bars, ...xLabels, ...axes),
    h('div', { class: 'portal-usage-legend' },
      LegendItem('portal-swatch-down', word('ui.portal_usage_legend_down')),
      LegendItem('portal-swatch-up', word('ui.portal_usage_legend_up'))));
}
