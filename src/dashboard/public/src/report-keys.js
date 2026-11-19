import { rawWord } from './words.js';

const concept = (name) => rawWord('report.concept.' + name) ?? null;

export const CK = Object.freeze({
  kind: concept('kind'),
  signs: concept('signs'),
  suspected_condition: concept('suspected_condition'),
  total_count: concept('total_count'),
  identifying_detail: concept('identifying_detail'),
  contact_available: concept('contact_available'),
});
export const AREA_KEY = rawWord('report.area_field') ?? null;
