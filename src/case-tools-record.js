// case-tools-record.js  --  the tools that WRITE to a case: edit its fields,
// record the report, add an observation, move it through the workflow.
//
// Split out of case-tools.js verbatim -- names, descriptions (case_report's
// come straight from the loaded config via report-shape.js), parameter schemas
// and handler bodies are unchanged. Every tool here is autonomy-aware: an
// operator's `observe` setting blocks content edits, which is why the writes
// route through updateCaseChecked/mergeReport (autonomy re-read INSIDE the
// per-conversation lock) rather than a read-then-write of their own.
//
// The four definitions themselves live in three sibling modules, grouped the
// same way the other case-tools-* files are -- by the surface each write
// touches: case-tools-record-fields.js (a case's own editable columns),
// case-tools-record-report.js (the report blob plus the lat/lon columns), and
// case-tools-record-timeline.js (observations and workflow transitions).
// buildRecordTools stays the ONLY export, so case-tools.js's composition is
// unchanged and so is the order the tools reach the model -- that order is
// prompt-visible text (see AGENTS.md), so keep case_update, case_report,
// case_observe, case_transition exactly as they are.

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
