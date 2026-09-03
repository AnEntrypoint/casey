// Metrics panel -- 14-day report + CSV/HTML export links + per-case-type SLA.
// Content-swap panel (state.activePanel === 'metrics').

import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Spinner, Alert } from '/design/src/components/content/feedback.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state, schedule, closePanel } from '../state.js';
import { fetchOverview, fetchReportJson, fetchSlaAtRiskByType } from '../api.js';
import { fmtDur } from '../format.js';

const h = webjsx.createElement;

const STAGE_LABELS_M = { new: 'New', triaging: 'Triage', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed' };
const CASE_TYPE_LABEL = { unset: 'Unclassified', outbreak: 'Outbreak', follow_up: 'Follow-up', lab_sample: 'Lab sample', import_alert: 'Import alert' };
const ctLabel = (t) => CASE_TYPE_LABEL[t] || t;
const slaMetPct = (s) => (s && s.considered ? Math.round(((s.met_count || 0) / s.considered) * 100) + '%' : '--');

let loaded = false, loading = false, error = null;

function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    Promise.all([
        fetchOverview(14).catch(() => null),
        fetchReportJson(14).catch(() => null),
        fetchSlaAtRiskByType().catch(() => null),
    ]).then(([overview, report, risk]) => {
        state._metrics = { overview, report, risk };
        loaded = true; loading = false; error = null; schedule();
    }).catch((e) => { loaded = true; loading = false; error = e.message || 'metrics error'; schedule(); });
}

function summaryCards(j) {
    const fr = j.first_response_ms || {};
    const dwell = j.dwell_ms_median || {}, backlog = j.backlog_by_stage || {};
    const cards = [
        [ 'Median first reply', fmtDur(fr.median), `p90 ${fmtDur(fr.p90)} (${fr.n || 0} answered)` ],
        [ 'Open', String(j.cases ? j.cases.open : 0), 'cases' ],
        [ 'Closed', String(j.cases ? j.cases.closed : 0), 'cases' ],
        ...Object.keys(dwell).map((s) => [STAGE_LABELS_M[s] || s, fmtDur(dwell[s]), 'median dwell']),
        ...Object.keys(backlog).map((s) => [STAGE_LABELS_M[s] || s, String(backlog[s]), 'open now']),
    ];
    return h('div', { class: 'ds-stats-grid' }, ...cards.map(([lab, val, sub], i) =>
        h('div', { key: i, class: 'ds-stat-card' },
            h('div', { class: 'ds-stat-label' }, lab),
            h('div', { class: 'ds-stat-value' }, val),
            sub ? h('div', { class: 'ds-stat-sub' }, sub) : null)));
}

function atRiskByType(risk) {
    const bt = (risk && risk.by_type) || {};
    const types = Object.keys(bt).filter((t) => (bt[t] || 0) > 0).sort((a, b) => (bt[b] || 0) - (bt[a] || 0));
    if (!types.length) return null;
    const tgt = risk.sla_target_ms != null ? fmtDur(risk.sla_target_ms) : '';
    return Section({ title: `At risk now (reply target ${tgt})`, children: [
        h('div', { class: 'ds-risk-strip' }, ...types.map((t) =>
            h('span', { key: t, class: 'ds-risk-chip' }, ctLabel(t) + ' ', h('b', {}, String(bt[t])))))
    ]});
}

function byTypeTable(report) {
    const sbt = (report && report.sla_by_type && report.sla_by_type.by_type) || {};
    const ov = (report && report.sla_by_type && report.sla_by_type.overall) || null;
    const met = (report && report.by_case_type) || {};
    const types = Array.from(new Set([...Object.keys(sbt), ...Object.keys(met)]));
    if (!types.length) return null;
    const row = (label, s, m) => {
        const late = s && s.breached_by_reason && s.breached_by_reason.answered_late;
        const never = s && s.breached_by_reason && s.breached_by_reason.never_answered;
        return [label, s && s.considered != null ? String(s.considered) : '--', slaMetPct(s),
            late != null ? String(late) : '--', never != null ? String(never) : '--',
            fmtDur(m ? m.first_response_ms_median : null), m && m.closed_pct != null ? m.closed_pct + '%' : '--'];
    };
    const rows = types.map((t) => row(ctLabel(t), sbt[t], met[t]));
    if (ov) rows.push(row('Overall', ov, null));
    return Section({ title: 'By case type', children: [
        Table({ headers: ['Type', 'Cases', 'SLA met', 'Late', 'Never', '1st reply', 'Closed'], rows })
    ]});
}

export function MetricsPanel() {
    ensureLoaded();
    const back = Btn({ variant: 'ghost', children: 'Back to cases', onClick: closePanel });
    const exportLinks = h('div', { class: 'ds-metrics-exports' },
        Btn({ href: '/api/report.csv?days=14', variant: 'ghost', size: 'sm', children: 'Export CSV' }),
        Btn({ href: '/api/report.html?days=14', variant: 'ghost', size: 'sm', children: 'Export HTML' }),
        Btn({ href: '/api/audit.csv?days=14', variant: 'ghost', size: 'sm', children: 'Audit trail CSV' }));
    let body;
    if (loading && !loaded) body = Spinner({ label: 'loading metrics -- scans every open case, can take several seconds' });
    else if (error) body = Alert({ kind: 'error', children: 'Metrics error: ' + error });
    else {
        const { overview, report, risk } = state._metrics || {};
        body = h('div', {},
            overview ? summaryCards(overview) : Alert({ kind: 'warn', children: 'Could not load metrics.' }),
            risk ? atRiskByType(risk) : null,
            report ? byTypeTable(report) : null);
    }
    return Panel({ title: 'Metrics', right: exportLinks, children: [back, body] });
}
