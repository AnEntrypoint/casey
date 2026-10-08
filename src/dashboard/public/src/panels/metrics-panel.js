import * as webjsx from '/design/vendor/webjsx/index.js';
import { Panel, Section } from '/design/src/components/content/panel.js';
import { Table } from '/design/src/components/content/table.js';
import { Alert } from '/design/src/components/content/feedback.js';
import { Kpi } from '/design/src/components/content/charts.js';
import { Btn } from '/design/src/components/shell/atoms.js';
import { state } from '../state.js';
import { createPanelLoader } from './panel-load.js';
import { fetchOverview, fetchReportJson, fetchSlaAtRiskByType } from '../api.js';
import { fmtDur, stageLabel, NO_TIME_TEXT } from '../format.js';
import { entityLabelPlural } from '../vocabulary.js';
import { word } from '../words.js';

const h = webjsx.createElement;

const CASE_TYPE_KEY = {
    unset: 'ui.metrics_panel_ct_unset',
    outbreak: 'ui.metrics_panel_ct_outbreak',
    follow_up: 'ui.metrics_panel_ct_follow_up',
    lab_sample: 'ui.metrics_panel_ct_lab_sample',
    import_alert: 'ui.metrics_panel_ct_import_alert',
};
const ctLabel = (t) => (CASE_TYPE_KEY[t] ? word(CASE_TYPE_KEY[t]) : t);
const slaMetPct = (s) => (s && s.considered ? Math.round(((s.met_count || 0) / s.considered) * 100) + '%' : NO_TIME_TEXT);

const loader = createPanelLoader({
    what: () => word('ui.metrics_panel_what'),
    label: () => word('ui.metrics_panel_loading'),
    fetch: () => Promise.all([
        fetchOverview(14).catch(() => null),
        fetchReportJson(14).catch(() => null),
        fetchSlaAtRiskByType().catch(() => null),
    ]),
    apply: ([overview, report, risk]) => { state._metrics = { overview, report, risk }; },
});

function summaryCards(j) {
    const fr = j.first_response_ms || {};
    const dwell = j.dwell_ms_median || {}, backlog = j.backlog_by_stage || {};
    const cards = [
        [ word('ui.metrics_panel_first_reply'), fmtDur(fr.median), (fr.p90 == null ? word('ui.metrics_panel_not_enough', { answered: fr.n || 0 }) : word('ui.metrics_panel_nine_in_ten', { time: fmtDur(fr.p90), answered: fr.n || 0 })) ],
        [ word('ui.metrics_panel_open'), String(j.cases ? j.cases.open : 0), entityLabelPlural() ],
        [ word('ui.metrics_panel_closed'), String(j.cases ? j.cases.closed : 0), entityLabelPlural() ],
        ...Object.keys(dwell).map((s) => [stageLabel(s), fmtDur(dwell[s]), word('ui.metrics_panel_usual_stage')]),
        ...Object.keys(backlog).map((s) => [stageLabel(s), String(backlog[s]), word('ui.metrics_panel_open_now')]),
    ];
    return Kpi({ items: cards.map(([lab, val, sub]) => [val, sub ? lab + ' - ' + sub : lab]) });
}

function atRiskByType(risk) {
    const bt = (risk && risk.by_type) || {};
    const types = Object.keys(bt).filter((t) => (bt[t] || 0) > 0).sort((a, b) => (bt[b] || 0) - (bt[a] || 0));
    if (!types.length) return null;
    const tgt = risk.sla_target_ms != null ? fmtDur(risk.sla_target_ms) : '';
    const parts = [];
    types.forEach((t, i) => {
        if (i) parts.push(h('span', { key: 'sep' + i }, ', '));
        parts.push(h('b', { key: 'n' + t }, String(bt[t])), h('span', { key: 'l' + t }, ' ' + ctLabel(t)));
    });
    return Section({ title: word('ui.metrics_panel_at_risk', { target: tgt }), children: [
        h('div', { class: 'ds-risk-strip' }, ...parts)
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
        return [label, s && s.considered != null ? String(s.considered) : NO_TIME_TEXT, slaMetPct(s),
            late != null ? String(late) : NO_TIME_TEXT, never != null ? String(never) : NO_TIME_TEXT,
            fmtDur(m ? m.first_response_ms_median : null), m && m.closed_pct != null ? m.closed_pct + '%' : NO_TIME_TEXT];
    };
    const rows = types.map((t) => row(ctLabel(t), sbt[t], met[t]));
    if (ov) rows.push(row(word('ui.metrics_panel_overall'), ov, null));
    return Section({ title: word('ui.metrics_panel_by_type'), children: [
        Table({ headers: [
            word('ui.metrics_panel_h_type'), word('ui.metrics_panel_h_reports'), word('ui.metrics_panel_h_in_time'),
            word('ui.metrics_panel_h_late'), word('ui.metrics_panel_h_never'), word('ui.metrics_panel_h_first_reply'),
            word('ui.metrics_panel_h_closed'),
        ], rows })
    ]});
}

export function MetricsPanel() {
    loader.ensureLoaded();
    const exportLinks = h('div', { class: 'ds-btn-row' },
        Btn({ href: '/api/report.csv?days=14', variant: 'ghost', size: 'sm', children: word('ui.metrics_panel_export_csv') }),
        Btn({ href: '/api/report.html?days=14', variant: 'ghost', size: 'sm', children: word('ui.metrics_panel_export_html') }),
        Btn({ href: '/api/audit.csv?days=14', variant: 'ghost', size: 'sm', children: word('ui.metrics_panel_export_audit') }));
    const body = loader.slot(() => {
        const { overview, report, risk } = state._metrics || {};
        return h('div', {},
            overview ? summaryCards(overview) : Alert({ kind: 'warn', children: word('ui.metrics_panel_load_failed') }),
            risk ? atRiskByType(risk) : null,
            report ? byTypeTable(report) : null);
    });
    return Panel({ children: [exportLinks, body] });
}
