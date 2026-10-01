

import { buildCaseFieldTools } from './case-tools-record-fields.js'
import { buildCaseReportTools } from './case-tools-record-report.js'
import { buildCaseTimelineTools } from './case-tools-record-timeline.js'

export function buildRecordTools(store, { caseTypeValues, priorityValues, stageValues }) {
  return [
    ...buildCaseFieldTools(store, { caseTypeValues, priorityValues }),
    ...buildCaseReportTools(store),
    ...buildCaseTimelineTools(store, { stageValues }),
  ]
}
