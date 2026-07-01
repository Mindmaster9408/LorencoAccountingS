'use strict';

// Codebox 51 — Practice KPI Engine + Historical Trend Analytics
// Deterministic KPI history for the Management Dashboard (Codebox 50).
//
// NOT AI. NOT forecasting. NOT predictive analytics. Simple deterministic
// deltas between captured snapshots only.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const managementDashboard = require('./management-dashboard');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const SNAPSHOT_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'manual'];
const SNAPSHOT_STATUSES = ['active', 'archived'];
const SOURCE_DASHBOARD = 'management_dashboard';

// Metric key → extractor from a stored snapshot row. Single source of truth
// for /trends and /compare so both endpoints always agree on what a metric
// key means. Paths match exactly what computeSummary()/computePracticeScore()
// return (see management-dashboard.js) — nothing here is guessed.
const METRIC_EXTRACTORS = {
    overall_score:             s => s.score_data?.overall_score,
    quality_score:             s => s.score_data?.scores?.quality,
    compliance_score:          s => s.score_data?.scores?.compliance,
    risk_score:                s => s.score_data?.scores?.risk,
    capacity_score:            s => s.score_data?.scores?.capacity,
    tax_score:                 s => s.score_data?.scores?.tax,
    open_risks:                s => s.kpi_data?.risk?.open_risks,
    critical_risks:            s => s.kpi_data?.risk?.critical_risks,
    open_findings:             s => s.kpi_data?.qms?.open_findings,
    overdue_documents:         s => s.kpi_data?.document_requests?.overdue,
    // "Tax review queue" has no single existing field — mapped to the closest
    // confirmed concept (returns ready for review). Documented judgment call.
    tax_review_queue:          s => s.kpi_data?.tax?.ready_review,
    overdue_reminders:         s => s.kpi_data?.reminders?.overdue,
    capacity_overloaded_count: s => s.kpi_data?.capacity?.over_capacity_staff,
};
const METRIC_KEYS = Object.keys(METRIC_EXTRACTORS);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _verifySnapshot(id, cid) {
    const { data } = await supabase
        .from('practice_kpi_snapshots')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _findActiveForPeriod(cid, snapshotType, periodKey) {
    if (!periodKey) return null;
    const { data } = await supabase
        .from('practice_kpi_snapshots')
        .select('id')
        .eq('company_id', cid)
        .eq('source_dashboard', SOURCE_DASHBOARD)
        .eq('snapshot_type', snapshotType)
        .eq('period_key', periodKey)
        .eq('status', 'active')
        .maybeSingle();
    return data || null;
}

async function _writeEvent(snapshotId, cid, eventType, userId, notes, meta) {
    await supabase.from('practice_kpi_snapshot_events').insert({
        snapshot_id:   snapshotId,
        company_id:    cid,
        event_type:    eventType,
        actor_user_id: userId || null,
        notes:         notes  || null,
        metadata:      meta   || {},
    });
}

function _direction(delta) {
    if (delta > 0) return 'up';
    if (delta < 0) return 'down';
    return 'flat';
}

function _deltaPct(current, previous) {
    if (previous == null || current == null) return null;
    if (previous === 0) return current === 0 ? 0 : null; // undefined % change from zero baseline
    return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// ── Routes ────────────────────────────────────────────────────────────────────
// NOTE: /summary, /trends, /compare, /capture are all specific top-level
// paths that never collide with /:id — no special ordering required.

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: snapshots } = await supabase
            .from('practice_kpi_snapshots')
            .select('snapshot_type, generated_at, score_data')
            .eq('company_id', cid)
            .eq('status', 'active')
            .order('generated_at', { ascending: true });

        const all = snapshots || [];
        const counts = { daily: 0, weekly: 0, monthly: 0, quarterly: 0, annual: 0, manual: 0 };
        all.forEach(s => { if (counts[s.snapshot_type] !== undefined) counts[s.snapshot_type]++; });

        let trendDirection = null;
        if (all.length >= 2) {
            const last = all[all.length - 1];
            const prev = all[all.length - 2];
            const lastScore = last.score_data?.overall_score;
            const prevScore = prev.score_data?.overall_score;
            if (lastScore != null && prevScore != null) trendDirection = _direction(lastScore - prevScore);
        }

        return res.json({
            total_snapshots:     all.length,
            latest_snapshot_date: all.length ? all[all.length - 1].generated_at : null,
            monthly_snapshots:   counts.monthly,
            weekly_snapshots:    counts.weekly,
            manual_snapshots:    counts.manual,
            daily_snapshots:     counts.daily,
            quarterly_snapshots: counts.quarterly,
            annual_snapshots:    counts.annual,
            trend_direction:     trendDirection,
        });
    } catch (err) {
        console.error('GET /api/practice/kpi-history/summary', err);
        return res.status(500).json({ error: 'Failed to load KPI history summary.' });
    }
});

// ── GET /trends ────────────────────────────────────────────────────────────────
// Simple deterministic deltas only. No prediction.

router.get('/trends', async (req, res) => {
    const cid = req.companyId;
    const { metric_key, snapshot_type, period_from, period_to } = req.query;

    if (!metric_key || !METRIC_EXTRACTORS[metric_key]) {
        return res.status(400).json({ error: `metric_key is required. Allowed: ${METRIC_KEYS.join(', ')}` });
    }
    if (snapshot_type && !SNAPSHOT_TYPES.includes(snapshot_type)) {
        return res.status(400).json({ error: `Invalid snapshot_type. Allowed: ${SNAPSHOT_TYPES.join(', ')}` });
    }

    try {
        let q = supabase
            .from('practice_kpi_snapshots')
            .select('id, snapshot_name, snapshot_type, period_start, period_end, period_key, generated_at, kpi_data, score_data')
            .eq('company_id', cid)
            .eq('status', 'active');

        if (snapshot_type) q = q.eq('snapshot_type', snapshot_type);
        if (period_from)   q = q.gte('period_start', period_from);
        if (period_to)     q = q.lte('period_end', period_to);

        q = q.order('generated_at', { ascending: true });

        const { data, error } = await q;
        if (error) throw error;

        const extractor = METRIC_EXTRACTORS[metric_key];
        const rows = (data || []).map(s => ({ snapshot: s, value: extractor(s) ?? null }));

        const trend = rows.map((row, i) => {
            const prev = i > 0 ? rows[i - 1].value : null;
            const delta = (row.value != null && prev != null) ? row.value - prev : null;
            return {
                snapshot_id:   row.snapshot.id,
                snapshot_name: row.snapshot.snapshot_name,
                snapshot_type: row.snapshot.snapshot_type,
                period_start:  row.snapshot.period_start,
                period_end:    row.snapshot.period_end,
                period_key:    row.snapshot.period_key,
                generated_at:  row.snapshot.generated_at,
                value:         row.value,
                delta:         delta,
                delta_percentage: delta != null ? _deltaPct(row.value, prev) : null,
                trend_direction:  delta != null ? _direction(delta) : null,
            };
        });

        // Audit: kpi_trend_viewed must attach to a snapshot_id (schema requires
        // one) — logged against the most recent snapshot in the filtered
        // result set, with the query parameters captured in metadata. If the
        // filter matched zero snapshots, there is nothing to attach to and no
        // event is written (documented judgment call).
        if (trend.length) {
            const last = trend[trend.length - 1];
            await _writeEvent(last.snapshot_id, cid, 'kpi_trend_viewed', req.user?.userId, null, {
                metric_key, snapshot_type: snapshot_type || null, period_from: period_from || null, period_to: period_to || null, result_count: trend.length,
            });
        }

        return res.json({ metric_key, trend });
    } catch (err) {
        console.error('GET /api/practice/kpi-history/trends', err);
        return res.status(500).json({ error: 'Failed to load KPI trends.' });
    }
});

// ── GET /compare ───────────────────────────────────────────────────────────────

router.get('/compare', async (req, res) => {
    const cid = req.companyId;
    const snapshotAId = Number(req.query.snapshot_a_id);
    const snapshotBId = Number(req.query.snapshot_b_id);

    if (!snapshotAId || !snapshotBId) {
        return res.status(400).json({ error: 'snapshot_a_id and snapshot_b_id are both required.' });
    }

    try {
        const [a, b] = await Promise.all([
            _verifySnapshot(snapshotAId, cid),
            _verifySnapshot(snapshotBId, cid),
        ]);
        if (!a) return res.status(404).json({ error: `Snapshot ${snapshotAId} not found.` });
        if (!b) return res.status(404).json({ error: `Snapshot ${snapshotBId} not found.` });

        // Score comparison — overall + 5 sub-scores.
        const scoreKeys = ['overall_score', 'quality_score', 'compliance_score', 'risk_score', 'capacity_score', 'tax_score'];
        const scoreComparison = scoreKeys.map(key => {
            const extractor = METRIC_EXTRACTORS[key];
            const aVal = extractor(a), bVal = extractor(b);
            const delta = (aVal != null && bVal != null) ? bVal - aVal : null;
            return { metric: key, a_value: aVal, b_value: bVal, delta, delta_percentage: delta != null ? _deltaPct(bVal, aVal) : null, direction: delta != null ? _direction(delta) : null };
        });

        // KPI comparison — the non-score metric keys.
        const kpiKeys = METRIC_KEYS.filter(k => !scoreKeys.includes(k));
        const kpiComparison = kpiKeys.map(key => {
            const extractor = METRIC_EXTRACTORS[key];
            const aVal = extractor(a), bVal = extractor(b);
            const delta = (aVal != null && bVal != null) ? bVal - aVal : null;
            return { metric: key, a_value: aVal, b_value: bVal, delta, delta_percentage: delta != null ? _deltaPct(bVal, aVal) : null, direction: delta != null ? _direction(delta) : null };
        });

        // Alert comparison — counts per severity bucket.
        const SEVERITIES = ['critical', 'high', 'overdue', 'blocked', 'needs_partner', 'requires_approval'];
        function _alertCounts(snapshot) {
            const alerts = snapshot.alert_data?.alerts || [];
            const counts = {};
            SEVERITIES.forEach(s => { counts[s] = alerts.filter(al => al.severity === s).length; });
            counts.total = alerts.length;
            return counts;
        }
        const aAlerts = _alertCounts(a), bAlerts = _alertCounts(b);
        const alertComparison = [...SEVERITIES, 'total'].map(sev => ({
            severity: sev, a_count: aAlerts[sev] || 0, b_count: bAlerts[sev] || 0, delta: (bAlerts[sev] || 0) - (aAlerts[sev] || 0),
        }));

        // Partner queue comparison — totals per category.
        const QUEUE_CATEGORIES = ['knowledge_approvals', 'sop_approvals', 'tax_completion', 'qms_reviews', 'risk_acceptance', 'billing_approval'];
        const partnerQueueComparison = QUEUE_CATEGORIES.map(cat => {
            const aCount = (a.partner_queue_data?.[cat] || []).length;
            const bCount = (b.partner_queue_data?.[cat] || []).length;
            return { category: cat, a_count: aCount, b_count: bCount, delta: bCount - aCount };
        });

        await _writeEvent(a.id, cid, 'kpi_snapshot_compared', req.user?.userId, null, { compared_with: b.id });

        return res.json({
            snapshot_a: { id: a.id, snapshot_name: a.snapshot_name, generated_at: a.generated_at },
            snapshot_b: { id: b.id, snapshot_name: b.snapshot_name, generated_at: b.generated_at },
            score_comparison: scoreComparison,
            kpi_comparison: kpiComparison,
            alert_comparison: alertComparison,
            partner_queue_comparison: partnerQueueComparison,
        });
    } catch (err) {
        console.error('GET /api/practice/kpi-history/compare', err);
        return res.status(500).json({ error: 'Failed to compare snapshots.' });
    }
});

// ── POST /capture ──────────────────────────────────────────────────────────────
// Captures a snapshot by calling the Management Dashboard's own compute
// functions directly (in-process — see management-dashboard.js exports).
// No frontend-provided KPI values are ever trusted.

router.post('/capture', async (req, res) => {
    const cid = req.companyId;
    const { snapshot_type, period_start, period_end, period_key, snapshot_name, notes, force } = req.body || {};

    const resolvedType = snapshot_type || 'manual';
    if (!SNAPSHOT_TYPES.includes(resolvedType)) {
        return res.status(400).json({ error: `Invalid snapshot_type. Allowed: ${SNAPSHOT_TYPES.join(', ')}` });
    }

    try {
        let archivedPrevious = null;

        if (period_key) {
            const existing = await _findActiveForPeriod(cid, resolvedType, period_key);
            if (existing) {
                if (force !== true && force !== 'true') {
                    return res.status(409).json({
                        error: `An active ${resolvedType} snapshot already exists for period "${period_key}".`,
                        existing_snapshot_id: existing.id,
                    });
                }
                // force=true: archive the superseded snapshot rather than
                // overwrite or delete it — preserves full history (see
                // migration 108's comment on the 'status' column for why
                // this is the safer choice than mutating the old row).
                const { data: archived, error: archiveErr } = await supabase
                    .from('practice_kpi_snapshots')
                    .update({ status: 'archived' })
                    .eq('id', existing.id)
                    .eq('company_id', cid)
                    .select()
                    .single();
                if (archiveErr) throw archiveErr;
                archivedPrevious = archived;
                await _writeEvent(existing.id, cid, 'kpi_snapshot_archived', req.user?.userId, 'Superseded by forced recapture for the same period.', {
                    reason: 'force_recapture', period_key,
                });
            }
        }

        // Compute fresh — never trust frontend-supplied KPI values.
        const [kpiData, scoreData, alertData, partnerQueueData] = await Promise.all([
            managementDashboard.computeSummary(cid),
            managementDashboard.computePracticeScore(cid),
            managementDashboard.computeAlerts(cid),
            managementDashboard.computePartnerReview(cid),
        ]);

        const title = (snapshot_name && String(snapshot_name).trim())
            || `${resolvedType.charAt(0).toUpperCase() + resolvedType.slice(1)} snapshot — ${new Date().toISOString().slice(0, 10)}`;

        const { data: snapshot, error } = await supabase
            .from('practice_kpi_snapshots')
            .insert({
                company_id:         cid,
                snapshot_name:      title,
                snapshot_type:      resolvedType,
                period_start:       period_start || null,
                period_end:         period_end   || null,
                period_key:         period_key   || null,
                source_dashboard:   SOURCE_DASHBOARD,
                kpi_data:           kpiData,
                score_data:         scoreData,
                alert_data:         alertData,
                partner_queue_data: partnerQueueData,
                generated_by:       req.user?.userId || null,
                notes:              notes || null,
                status:             'active',
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(snapshot.id, cid, 'kpi_snapshot_captured', req.user?.userId, notes || null, {
            snapshot_type: resolvedType, period_key: period_key || null,
            superseded_snapshot_id: archivedPrevious ? archivedPrevious.id : null,
        });

        return res.status(201).json({ snapshot, superseded_snapshot_id: archivedPrevious ? archivedPrevious.id : null });
    } catch (err) {
        console.error('POST /api/practice/kpi-history/capture', err);
        return res.status(500).json({ error: 'Failed to capture KPI snapshot.' });
    }
});

// ── GET / (list with filters + pagination) ────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const {
        snapshot_type, period_from, period_to, source_dashboard, status,
        page = 1, limit = 50,
    } = req.query;

    try {
        if (snapshot_type && !SNAPSHOT_TYPES.includes(snapshot_type)) {
            return res.status(400).json({ error: `Invalid snapshot_type. Allowed: ${SNAPSHOT_TYPES.join(', ')}` });
        }

        let q = supabase
            .from('practice_kpi_snapshots')
            .select('id, snapshot_name, snapshot_type, period_start, period_end, period_key, source_dashboard, generated_at, generated_by, status, score_data', { count: 'exact' })
            .eq('company_id', cid);

        // Default: only active snapshots, matching this codebase's soft-delete
        // convention. status=all / status=archived opt into the rest.
        if (status && SNAPSHOT_STATUSES.includes(status)) {
            q = q.eq('status', status);
        } else if (status !== 'all') {
            q = q.eq('status', 'active');
        }

        if (snapshot_type)    q = q.eq('snapshot_type', snapshot_type);
        if (source_dashboard) q = q.eq('source_dashboard', source_dashboard);
        if (period_from)      q = q.gte('period_start', period_from);
        if (period_to)        q = q.lte('period_end', period_to);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;

        q = q.order('generated_at', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        return res.json({ snapshots: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/kpi-history', err);
        return res.status(500).json({ error: 'Failed to load KPI snapshots.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const snapshot = await _verifySnapshot(req.params.id, cid);
        if (!snapshot) return res.status(404).json({ error: 'KPI snapshot not found.' });
        return res.json(snapshot);
    } catch (err) {
        console.error('GET /api/practice/kpi-history/:id', err);
        return res.status(500).json({ error: 'Failed to load KPI snapshot.' });
    }
});

// ── DELETE /:id (soft archive) ─────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const snapshot = await _verifySnapshot(req.params.id, cid);
        if (!snapshot) return res.status(404).json({ error: 'KPI snapshot not found.' });
        if (snapshot.status === 'archived') return res.status(422).json({ error: 'Snapshot is already archived.' });

        const { data: updated, error } = await supabase
            .from('practice_kpi_snapshots')
            .update({ status: 'archived' })
            .eq('id', snapshot.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(snapshot.id, cid, 'kpi_snapshot_archived', req.user?.userId, reason || null, {});

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/kpi-history/:id', err);
        return res.status(500).json({ error: 'Failed to archive KPI snapshot.' });
    }
});

// ── GET /:id/events (append-only audit log) ───────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const snapshot = await _verifySnapshot(req.params.id, cid);
        if (!snapshot) return res.status(404).json({ error: 'KPI snapshot not found.' });

        const { data, error } = await supabase
            .from('practice_kpi_snapshot_events')
            .select('*')
            .eq('snapshot_id', snapshot.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/kpi-history/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

module.exports = router;

// Codebox 52 (Partner Review Packs) reuses these directly so the metric
// definitions and delta math are never duplicated across modules.
module.exports.METRIC_EXTRACTORS = METRIC_EXTRACTORS;
module.exports.METRIC_KEYS = METRIC_KEYS;
module.exports.direction = _direction;
module.exports.deltaPct = _deltaPct;
