import { api, ApiError } from './api.js';

async function json(path) {
  const r = await api(path);
  let body = null;
  try { body = await r.json(); } catch {  }
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
function qs(params) {
  const p = Object.entries(params || {}).filter(([, v]) => v != null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : '';
}
export const fetchResolvedMap = (params) => json('/api/reports/resolved-map' + qs(params));
export const fetchDiseaseReport = (params) => json('/api/reports/diseases' + qs(params));
export const fetchHeat = (params) => json('/api/reports/heat' + qs(params));
export const exportCsvUrl = (params) => '/api/reports/export.csv' + qs(params);
