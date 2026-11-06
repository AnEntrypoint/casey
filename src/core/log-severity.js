const SEVERITY = new Map([['debug', 'DEBUG'], ['info', 'INFO'], ['warn', 'WARNING'], ['error', 'ERROR']])

export function withSeverity(fields) {
  return { ...fields, severity: SEVERITY.get(fields.level) ?? 'DEFAULT' }
}
