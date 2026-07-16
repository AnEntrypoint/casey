// packs/animal-health.js -- casey's OWN domain, ported to the config-pack
// format as the FIRST proof pack: zero engine code change, only declarative
// data. This does NOT replace casey's existing thatcher.config.yml /
// case-tools.js REPORT_KEYS -- those keep running the live agent
// conversation exactly as today. This pack is the new provenance
// subsystem's parallel declarative description of the same domain
// vocabulary, proving the engine (core/pack-schema.js, core/pack-loader.js)
// can represent it with no animal-health-specific code anywhere in core/.

export const animalHealthPack = {
  id: 'animal-health',
  version: '1.0.0',

  subjectTypes: {
    herd: { label: 'Herd or flock' },
    farm: { label: 'Farm or homestead', parent: 'herd' },
  },

  observationForms: {
    sick_or_dead_animal: {
      subjectType: 'herd',
      fields: {
        species: { type: 'enum', codelist: 'species', evidenceRequired: false },
        symptoms: { type: 'text', evidenceRequired: false },
        affected_count: { type: 'number', evidenceRequired: false },
        dead_count: { type: 'number', evidenceRequired: false },
        onset: { type: 'date', evidenceRequired: false },
        suspected_disease: { type: 'enum', codelist: 'conditions', evidenceRequired: false },
        location: { type: 'geo', evidenceRequired: false },
        photos: { type: 'photo', evidenceRequired: true },
        audio: { type: 'audio', evidenceRequired: false },
      },
    },
  },

  codelists: {
    species: [
      { key: 'cattle', label: 'Cattle' },
      { key: 'goat', label: 'Goat' },
      { key: 'sheep', label: 'Sheep' },
      { key: 'poultry', label: 'Poultry' },
      { key: 'pig', label: 'Pig' },
      { key: 'other', label: 'Other' },
    ],
    conditions: [
      { key: 'foot_and_mouth', label: 'Foot and mouth disease' },
      { key: 'newcastle', label: 'Newcastle disease' },
      { key: 'anthrax', label: 'Anthrax' },
      { key: 'rabies', label: 'Rabies' },
      { key: 'unknown_illness', label: 'Unknown illness' },
    ],
  },

  rules: [
    {
      id: 'mass-mortality-escalation',
      condition: { op: 'gte', field: 'dead_count', value: 5 },
      severity: 'high',
      route: 'district_vet',
    },
    {
      id: 'notifiable-disease-escalation',
      condition: { op: 'in', field: 'suspected_disease', value: ['foot_and_mouth', 'anthrax', 'rabies'] },
      severity: 'high',
      route: 'district_vet',
    },
  ],

  roles: {
    reporter: { rowAccess: 'none' },
    field_worker: { rowAccess: 'owner' },
    district_vet: { rowAccess: 'assigned' },
    national_authority: { rowAccess: 'none' },
    admin: { rowAccess: 'none' },
  },

  views: {
    outbreak_map: { type: 'map' },
    cases_over_time: { type: 'timeseries' },
    case_table: { type: 'table' },
  },

  strings: {
    en: {
      greeting: 'Hello, I am here to help report sick or dead animals.',
      species_label: 'Animal type',
      symptoms_label: 'What did you see?',
    },
  },
}
