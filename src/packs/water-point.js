// packs/water-point.js -- the SECOND, genuinely unrelated config pack: rural
// water-point functionality inspection/reporting. This is the acceptance
// test proving core/pack-schema.js + core/pack-loader.js + core/observation.js
// + core/write-path.js carry ZERO animal-health-specific code -- if this
// pack loads and validates through the exact same engine with no code
// change, domain-neutrality is proven, not merely claimed.

export const waterPointPack = {
  id: 'water-point',
  version: '1.0.0',

  subjectTypes: {
    water_point: { label: 'Water point' },
    ward: { label: 'Ward', parent: 'water_point' },
  },

  observationForms: {
    functionality_check: {
      subjectType: 'water_point',
      fields: {
        point_type: { type: 'enum', codelist: 'point_types', evidenceRequired: false },
        functional: { type: 'boolean', evidenceRequired: false },
        water_quality_flag: { type: 'enum', codelist: 'quality_flags', evidenceRequired: false },
        queue_length: { type: 'number', evidenceRequired: false },
        location: { type: 'geo', evidenceRequired: false },
        photos: { type: 'photo', evidenceRequired: true },
      },
    },
  },

  codelists: {
    point_types: [
      { key: 'borehole', label: 'Borehole' },
      { key: 'tap_stand', label: 'Tap stand' },
      { key: 'well', label: 'Well' },
      { key: 'other', label: 'Other' },
    ],
    quality_flags: [
      { key: 'clear', label: 'Clear' },
      { key: 'cloudy', label: 'Cloudy' },
      { key: 'smells_bad', label: 'Smells bad' },
      { key: 'unknown', label: 'Not checked' },
    ],
  },

  rules: [
    {
      id: 'non-functional-escalation',
      condition: { op: 'eq', field: 'functional', value: false },
      severity: 'medium',
      route: 'district_water_officer',
    },
    {
      id: 'bad-quality-escalation',
      condition: { op: 'in', field: 'water_quality_flag', value: ['smells_bad'] },
      severity: 'high',
      route: 'district_water_officer',
    },
  ],

  roles: {
    reporter: { rowAccess: 'none' },
    field_worker: { rowAccess: 'owner' },
    district_water_officer: { rowAccess: 'assigned' },
    admin: { rowAccess: 'none' },
  },

  views: {
    functionality_map: { type: 'map' },
    reports_over_time: { type: 'timeseries' },
    point_table: { type: 'table' },
  },

  strings: {
    en: {
      greeting: 'Hello, I am here to help report a water point issue.',
      point_type_label: 'Water point type',
      functional_label: 'Is it working?',
    },
  },
}
