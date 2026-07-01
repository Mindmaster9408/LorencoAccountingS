'use strict';

// Codebox 52 — Practice Partner Monthly Review Pack
// Deterministic management reporting and partner sign-off, built from the
// Management Dashboard (Codebox 50) and KPI History (Codebox 51).
//
// NOT AI. NOT forecasting. NOT automated email reporting.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const managementDashboard = require('./management-dashboard');
const kpiHistory = require('./kpi-history');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (e) { PDFDocument = null; }

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const PACK_STATUSES = ['draft', 'generated', 'under_review', 'approved', 'rejected', 'archived', 'cancelled'];
const TERMINAL_STATUSES = ['archived', 'cancelled'];
// Approved packs are immutable (matches the approved-is-frozen convention used
// throughout this codebase — Knowledge Base, SOP Library, etc). draft/generated/
// under_review/rejected can still be edited via PUT (rejected specifically so a
// pack can be fixed and resubmitted without generating a brand-new one).
const EDITABLE_STATUSES = ['draft', 'generated', 'under_review', 'rejected'];

const DISCLAIMER = 'Internal management report — not financial statements or audit assurance.';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyPack(id, cid) {
    const { data } = await supabase
        .from('practice_partner_review_packs')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _findActivePackForPeriod(cid, periodKey) {
    if (!periodKey) return null;
    const { data } = await supabase
        .from('practice_partner_review_packs')
        .select('id')
        .eq('company_id', cid)
        .eq('period_key', periodKey)
        .not('pack_status', 'in', '("cancelled","archived")')
        .maybeSingle();
    return data || null;
}

async function _writeEvent(packId, cid, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_partner_review_pack_events').insert({
        pack_id:       packId,
        company_id:    cid,
        event_type:    eventType,
        old_status:    oldStatus || null,
        new_status:    newStatus || null,
        actor_user_id: userId    || null,
        notes:         notes     || null,
        metadata:      meta      || {},
    });
}

// Nearest active KPI snapshot at or before the given date (inclusive).
// "Nearest in period where practical" is interpreted as nearest by generated_at
// — the most literal reading of "when was this snapshot taken" (documented
// judgment call, see completion report).
async function _nearestSnapshotAtOrBefore(cid, dateStr) {
    if (!dateStr) return null;
    const { data } = await supabase
        .from('practice_kpi_snapshots')
        .select('*')
        .eq('company_id', cid)
        .eq('status', 'active')
        .lte('generated_at', dateStr + 'T23:59:59.999Z')
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}

async function _fetchSnapshotById(id, cid) {
    if (!id) return null;
    const { data } = await supabase
        .from('practice_kpi_snapshots')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

function _snapshotRef(s) {
    if (!s) return null;
    return { id: s.id, snapshot_name: s.snapshot_name, snapshot_type: s.snapshot_type, generated_at: s.generated_at, period_key: s.period_key };
}

// Diff two same-shaped objects' numeric fields — used for every "movement"
// section (risk, qms, tax, capacity, client_health, document/reminder/compliance).
// endObj falls back to live current-state data when no end snapshot exists,
// so the report always shows *something* even in the current-state-only case.
function _diffSection(startObj, endObj) {
    const keys = new Set([
        ...Object.keys(startObj || {}),
        ...Object.keys(endObj || {}),
    ]);
    const out = {};
    keys.forEach(k => {
        const s = startObj ? startObj[k] : null;
        const e = endObj ? endObj[k] : null;
        const bothNumeric = typeof s === 'number' && typeof e === 'number';
        out[k] = {
            start: s != null ? s : null,
            end:   e != null ? e : null,
            delta: bothNumeric ? e - s : null,
            direction: bothNumeric ? kpiHistory.direction(e - s) : null,
        };
    });
    return out;
}

// Build the frozen report_snapshot — the single source of truth for
// report-data/report-html/report-pdf. Never recalculated after generation.
async function _buildReportSnapshot({ cid, reviewPeriodStart, reviewPeriodEnd, periodKey, snapshotStart, snapshotEnd, warnings }) {
    const [latestSummary, latestScore, latestAlerts, latestPartnerQueue, latestFeed] = await Promise.all([
        managementDashboard.computeSummary(cid),
        managementDashboard.computePracticeScore(cid),
        managementDashboard.computeAlerts(cid),
        managementDashboard.computePartnerReview(cid),
        managementDashboard.computeExecutiveFeed(cid, 20),
    ]);

    // End-of-period section falls back to live data when no end snapshot —
    // start-of-period never falls back (there is no "before" without a real snapshot).
    const endKpi = snapshotEnd ? snapshotEnd.kpi_data : latestSummary;
    const endScore = snapshotEnd ? snapshotEnd.score_data : latestScore;
    const startKpi = snapshotStart ? snapshotStart.kpi_data : null;
    const startScore = snapshotStart ? snapshotStart.score_data : null;

    const kpiTrends = kpiHistory.METRIC_KEYS.map(key => {
        const extractor = kpiHistory.METRIC_EXTRACTORS[key];
        const startVal = snapshotStart ? extractor(snapshotStart) ?? null : null;
        const endVal = snapshotEnd ? extractor(snapshotEnd) ?? null : (extractor({ kpi_data: latestSummary, score_data: latestScore }) ?? null);
        const bothKnown = startVal != null && endVal != null;
        return {
            metric_key: key,
            start_value: startVal,
            end_value: endVal,
            delta: bothKnown ? endVal - startVal : null,
            delta_percentage: bothKnown ? kpiHistory.deltaPct(endVal, startVal) : null,
            direction: bothKnown ? kpiHistory.direction(endVal - startVal) : null,
        };
    });

    const practiceScoreMovement = {
        overall: { start: startScore?.overall_score ?? null, end: endScore?.overall_score ?? null },
        sub_scores: _diffSection(startScore?.scores || null, endScore?.scores || null),
    };
    if (practiceScoreMovement.overall.start != null && practiceScoreMovement.overall.end != null) {
        practiceScoreMovement.overall.delta = practiceScoreMovement.overall.end - practiceScoreMovement.overall.start;
        practiceScoreMovement.overall.direction = kpiHistory.direction(practiceScoreMovement.overall.delta);
    }

    const movement = {};
    movement.risk = _diffSection(startKpi?.risk, endKpi?.risk);
    movement.qms = _diffSection(startKpi?.qms, endKpi?.qms);
    movement.tax = _diffSection(startKpi?.tax, endKpi?.tax);
    movement.capacity = _diffSection(startKpi?.capacity, endKpi?.capacity);
    movement.client_health = _diffSection(startKpi?.client_health, endKpi?.client_health);
    movement.document_requests = _diffSection(startKpi?.document_requests, endKpi?.document_requests);
    movement.reminders = _diffSection(startKpi?.reminders, endKpi?.reminders);
    movement.compliance = _diffSection(startKpi?.compliance, endKpi?.compliance);

    return {
        period: { review_period_start: reviewPeriodStart, review_period_end: reviewPeriodEnd, period_key: periodKey || null },
        generated_at: new Date().toISOString(),
        snapshots: { start: _snapshotRef(snapshotStart), end: _snapshotRef(snapshotEnd) },
        latest_summary: latestSummary,
        latest_alerts: latestAlerts,
        latest_partner_queue: latestPartnerQueue,
        latest_executive_feed: latestFeed,
        kpi_trends: kpiTrends,
        practice_score_movement: practiceScoreMovement,
        movement,
        warnings,
        assumptions: [
            'Nearest available KPI snapshot at or before each period boundary was used when an exact-date snapshot did not exist.',
            'All figures are deterministic counts/scores computed from existing modules — no forecasting, prediction, or AI-derived commentary is included.',
            'End-of-period figures use live current-state data when no snapshot exists at or before the period end date.',
        ],
    };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// ── GET / (list with filters + pagination) ────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { pack_status, period_from, period_to, page = 1, limit = 50 } = req.query;

    try {
        if (pack_status && !PACK_STATUSES.includes(pack_status)) {
            return res.status(400).json({ error: `Invalid pack_status. Allowed: ${PACK_STATUSES.join(', ')}` });
        }

        let q = supabase
            .from('practice_partner_review_packs')
            .select('id, pack_name, pack_status, review_period_start, review_period_end, period_key, prepared_by, prepared_at, reviewed_by, reviewed_at, approved_by, approved_at, created_at, updated_at', { count: 'exact' })
            .eq('company_id', cid);

        if (pack_status) q = q.eq('pack_status', pack_status);
        if (period_from) q = q.gte('review_period_start', period_from);
        if (period_to) q = q.lte('review_period_end', period_to);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;

        q = q.order('review_period_start', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        return res.json({ packs: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/partner-review-packs', err);
        return res.status(500).json({ error: 'Failed to load partner review packs.' });
    }
});

// ── POST /generate ─────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
    const cid = req.companyId;
    const {
        pack_name, review_period_start, review_period_end, period_key,
        snapshot_start_id, snapshot_end_id, executive_summary, notes, force,
    } = req.body || {};

    if (!pack_name || !String(pack_name).trim()) return res.status(400).json({ error: 'pack_name is required.' });
    if (!review_period_start) return res.status(400).json({ error: 'review_period_start is required.' });
    if (!review_period_end) return res.status(400).json({ error: 'review_period_end is required.' });
    if (review_period_end < review_period_start) {
        return res.status(400).json({ error: 'review_period_end cannot be before review_period_start.' });
    }

    try {
        let supersededPack = null;

        if (period_key) {
            const existing = await _findActivePackForPeriod(cid, period_key);
            if (existing) {
                if (force !== true && force !== 'true') {
                    return res.status(409).json({
                        error: `An active review pack already exists for period "${period_key}".`,
                        existing_pack_id: existing.id,
                    });
                }
                // force=true: cancel the superseded pack rather than overwrite
                // or delete it — preserves the prior pack's full history (same
                // reasoning as Codebox 51's force-recapture: never destroy a
                // historical management record).
                const { data: cancelled, error: cancelErr } = await supabase
                    .from('practice_partner_review_packs')
                    .update({ pack_status: 'cancelled', updated_by: req.user?.userId })
                    .eq('id', existing.id)
                    .eq('company_id', cid)
                    .select()
                    .single();
                if (cancelErr) throw cancelErr;
                supersededPack = cancelled;
                await _writeEvent(existing.id, cid, 'partner_review_pack_cancelled', cancelled.pack_status, 'cancelled', req.user?.userId, 'Superseded by forced regeneration for the same period.', {
                    reason: 'force_regenerate', period_key,
                });
            }
        }

        // Resolve snapshots: explicit ids (verified to belong to this company)
        // or nearest active snapshot at/before each period boundary.
        const warnings = [];
        let snapshotStart = null, snapshotEnd = null;

        if (snapshot_start_id) {
            snapshotStart = await _fetchSnapshotById(Number(snapshot_start_id), cid);
            if (!snapshotStart) return res.status(404).json({ error: `snapshot_start_id ${snapshot_start_id} not found for this company.` });
        } else {
            snapshotStart = await _nearestSnapshotAtOrBefore(cid, review_period_start);
            if (!snapshotStart) warnings.push(`No KPI snapshot found at or before the period start (${review_period_start}) — start-of-period comparison is unavailable.`);
        }

        if (snapshot_end_id) {
            snapshotEnd = await _fetchSnapshotById(Number(snapshot_end_id), cid);
            if (!snapshotEnd) return res.status(404).json({ error: `snapshot_end_id ${snapshot_end_id} not found for this company.` });
        } else {
            snapshotEnd = await _nearestSnapshotAtOrBefore(cid, review_period_end);
            if (!snapshotEnd) warnings.push(`No KPI snapshot found at or before the period end (${review_period_end}) — end-of-period figures use live current-state data instead.`);
        }

        if (!snapshotStart && !snapshotEnd) {
            warnings.push('No KPI snapshots exist for this practice yet — this pack reflects current-state data only, with no historical comparison.');
        }

        const reportSnapshot = await _buildReportSnapshot({
            cid, reviewPeriodStart: review_period_start, reviewPeriodEnd: review_period_end,
            periodKey: period_key || null, snapshotStart, snapshotEnd, warnings,
        });

        const now = new Date().toISOString();
        const { data: pack, error } = await supabase
            .from('practice_partner_review_packs')
            .insert({
                company_id:          cid,
                pack_name:           String(pack_name).trim(),
                pack_status:         'generated',
                review_period_start,
                review_period_end,
                period_key:          period_key || null,
                snapshot_start_id:   snapshotStart ? snapshotStart.id : null,
                snapshot_end_id:     snapshotEnd ? snapshotEnd.id : null,
                report_snapshot:     reportSnapshot,
                executive_summary:   executive_summary || null,
                partner_notes:       null,
                prepared_by:         req.user?.userId || null,
                prepared_at:         now,
                created_by:          req.user?.userId || null,
                updated_by:          req.user?.userId || null,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'partner_review_pack_generated', null, 'generated', req.user?.userId, notes || null, {
            period_key: period_key || null, warnings_count: warnings.length,
            superseded_pack_id: supersededPack ? supersededPack.id : null,
        });
        await auditFromReq(req, 'partner_review_pack_generated', 'partner_review_pack', pack.id, { period_key: period_key || null });

        return res.status(201).json({ pack, warnings, superseded_pack_id: supersededPack ? supersededPack.id : null });
    } catch (err) {
        console.error('POST /api/practice/partner-review-packs/generate', err);
        return res.status(500).json({ error: 'Failed to generate partner review pack.' });
    }
});

// ── GET /:id ───────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });
        return res.json(pack);
    } catch (err) {
        console.error('GET /api/practice/partner-review-packs/:id', err);
        return res.status(500).json({ error: 'Failed to load partner review pack.' });
    }
});

// ── PUT /:id (update non-frozen fields) ───────────────────────────────────────
// review_period_start/end, period_key, snapshot ids, and report_snapshot are
// NEVER editable — they are frozen at generation time. Only the narrative
// fields (name, executive summary, partner notes) can be changed, and only
// while the pack is in a non-terminal, non-approved state.

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['pack_name', 'executive_summary', 'partner_notes'];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });
        if (!EDITABLE_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: `Cannot edit a pack in "${pack.pack_status}" status.` });
        }

        const { data: updated, error } = await supabase
            .from('practice_partner_review_packs')
            .update({ ...patch, updated_by: req.user?.userId })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'partner_review_pack_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'partner_review_pack_updated', 'partner_review_pack', pack.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/partner-review-packs/:id', err);
        return res.status(500).json({ error: 'Failed to update partner review pack.' });
    }
});

// ── PUT /:id/submit-review ────────────────────────────────────────────────────
// Transition: generated/rejected → under_review

router.put('/:id/submit-review', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });
        if (!['generated', 'rejected'].includes(pack.pack_status)) {
            return res.status(422).json({ error: `Pack must be "generated" or "rejected" to submit for review. Current: "${pack.pack_status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_partner_review_packs')
            .update({ pack_status: 'under_review', updated_by: req.user?.userId })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'partner_review_pack_submitted_review', pack.pack_status, 'under_review', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'partner_review_pack_submitted_review', 'partner_review_pack', pack.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/partner-review-packs/:id/submit-review', err);
        return res.status(500).json({ error: 'Failed to submit pack for review.' });
    }
});

// ── PUT /:id/approve ──────────────────────────────────────────────────────────
// Transition: under_review → approved

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });
        if (pack.pack_status !== 'under_review') {
            return res.status(422).json({ error: `Pack must be "under_review" status to approve. Current: "${pack.pack_status}".` });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase
            .from('practice_partner_review_packs')
            .update({
                pack_status: 'approved',
                reviewed_by: req.user?.userId || null,
                reviewed_at: now,
                approved_by: req.user?.userId || null,
                approved_at: now,
                updated_by:  req.user?.userId,
            })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'partner_review_pack_approved', 'under_review', 'approved', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'partner_review_pack_approved', 'partner_review_pack', pack.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/partner-review-packs/:id/approve', err);
        return res.status(500).json({ error: 'Failed to approve partner review pack.' });
    }
});

// ── PUT /:id/reject ────────────────────────────────────────────────────────────
// Transition: under_review → rejected. Requires a reason.

router.put('/:id/reject', async (req, res) => {
    const cid = req.companyId;
    const { rejection_reason, notes } = req.body || {};
    if (!rejection_reason || !String(rejection_reason).trim()) {
        return res.status(400).json({ error: 'rejection_reason is required.' });
    }

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });
        if (pack.pack_status !== 'under_review') {
            return res.status(422).json({ error: `Pack must be "under_review" status to reject. Current: "${pack.pack_status}".` });
        }

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase
            .from('practice_partner_review_packs')
            .update({
                pack_status:      'rejected',
                reviewed_by:      req.user?.userId || null,
                reviewed_at:      now,
                rejection_reason: String(rejection_reason).trim(),
                updated_by:       req.user?.userId,
            })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(pack.id, cid, 'partner_review_pack_rejected', 'under_review', 'rejected', req.user?.userId, notes || rejection_reason, { rejection_reason: String(rejection_reason).trim() });
        await auditFromReq(req, 'partner_review_pack_rejected', 'partner_review_pack', pack.id, {});

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/partner-review-packs/:id/reject', err);
        return res.status(500).json({ error: 'Failed to reject partner review pack.' });
    }
});

// ── DELETE /:id (soft cancel/archive) ─────────────────────────────────────────
// Approved packs are archived (retiring a completed report); anything else
// is cancelled (withdrawn before completion). Both are soft — never deleted.

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });
        if (TERMINAL_STATUSES.includes(pack.pack_status)) {
            return res.status(422).json({ error: `Pack is already ${pack.pack_status}.` });
        }

        const newStatus = pack.pack_status === 'approved' ? 'archived' : 'cancelled';
        const { data: updated, error } = await supabase
            .from('practice_partner_review_packs')
            .update({ pack_status: newStatus, updated_by: req.user?.userId })
            .eq('id', pack.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        const eventType = newStatus === 'archived' ? 'partner_review_pack_archived' : 'partner_review_pack_cancelled';
        await _writeEvent(pack.id, cid, eventType, pack.pack_status, newStatus, req.user?.userId, reason || null, {});
        await auditFromReq(req, eventType, 'partner_review_pack', pack.id, { previous_status: pack.pack_status });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/partner-review-packs/:id', err);
        return res.status(500).json({ error: 'Failed to cancel/archive partner review pack.' });
    }
});

// ── GET /:id/report-data ───────────────────────────────────────────────────────
// Returns the frozen report_snapshot exactly as generated — never recomputed.

router.get('/:id/report-data', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });

        return res.json({
            pack_id: pack.id, pack_name: pack.pack_name, pack_status: pack.pack_status,
            review_period_start: pack.review_period_start, review_period_end: pack.review_period_end,
            period_key: pack.period_key, executive_summary: pack.executive_summary, partner_notes: pack.partner_notes,
            report_snapshot: pack.report_snapshot, disclaimer: DISCLAIMER,
        });
    } catch (err) {
        console.error('GET /api/practice/partner-review-packs/:id/report-data', err);
        return res.status(500).json({ error: 'Failed to load report data.' });
    }
});

// ── GET /:id/report-html ───────────────────────────────────────────────────────

router.get('/:id/report-html', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });

        await _writeEvent(pack.id, cid, 'partner_review_pack_report_viewed', null, null, req.user?.userId, null, { format: 'html' });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(_buildHtmlReport(pack));
    } catch (err) {
        console.error('GET /api/practice/partner-review-packs/:id/report-html', err);
        return res.status(500).json({ error: 'Failed to render report.' });
    }
});

// ── GET /:id/report-pdf ────────────────────────────────────────────────────────

router.get('/:id/report-pdf', async (req, res) => {
    const cid = req.companyId;
    if (!PDFDocument) return res.status(503).json({ error: 'PDF generation is not available on this server.' });

    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });

        await _writeEvent(pack.id, cid, 'partner_review_pack_pdf_downloaded', null, null, req.user?.userId, null, {});

        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="partner-review-pack-${pack.id}.pdf"`);
        doc.pipe(res);
        _buildPdfReport(doc, pack);
        doc.end();
    } catch (err) {
        console.error('GET /api/practice/partner-review-packs/:id/report-pdf', err);
        if (!res.headersSent) return res.status(500).json({ error: 'Failed to generate PDF.' });
    }
});

// ── GET /:id/events (append-only audit log) ───────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const pack = await _verifyPack(req.params.id, cid);
        if (!pack) return res.status(404).json({ error: 'Partner review pack not found.' });

        const { data, error } = await supabase
            .from('practice_partner_review_pack_events')
            .select('*')
            .eq('pack_id', pack.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/partner-review-packs/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

// ── HTML report builder ────────────────────────────────────────────────────────
// Simple, dependency-free server-rendered HTML. No chart library, per spec.

function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtNum(n) { return n == null ? '—' : String(n); }

function _movementRows(section) {
    return Object.keys(section || {}).map(key => {
        const v = section[key];
        const deltaStr = v.delta != null ? (v.delta > 0 ? '+' : '') + v.delta : '—';
        return `<tr><td>${_esc(key.replace(/_/g, ' '))}</td><td>${_fmtNum(v.start)}</td><td>${_fmtNum(v.end)}</td><td>${deltaStr}</td></tr>`;
    }).join('');
}

function _buildHtmlReport(pack) {
    const r = pack.report_snapshot || {};
    const sm = r.practice_score_movement || {};
    const alerts = (r.latest_alerts && r.latest_alerts.alerts) || [];
    const queue = r.latest_partner_queue || {};
    const feed = r.latest_executive_feed || [];

    const style = `
        body { font-family: Arial, Helvetica, sans-serif; color: #1a1a2e; margin: 0; padding: 40px; background: #fff; }
        h1 { font-size: 20px; margin-bottom: 4px; }
        h2 { font-size: 15px; margin: 28px 0 10px; border-bottom: 2px solid #667eea; padding-bottom: 4px; }
        .meta { color: #718096; font-size: 12px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 12px; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
        th { background: #f7fafc; color: #4a5568; text-transform: uppercase; font-size: 10px; }
        .score-box { display: inline-block; background: #f7fafc; border-radius: 8px; padding: 10px 16px; margin: 4px 8px 4px 0; text-align: center; }
        .score-val { font-size: 22px; font-weight: 700; }
        .score-lbl { font-size: 10px; color: #718096; text-transform: uppercase; }
        .warn { background: #fff8e1; border: 1px solid #f6ad55; border-radius: 6px; padding: 10px 14px; font-size: 12px; margin-bottom: 8px; }
        .disclaimer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #718096; font-style: italic; }
        .signoff { margin-top: 20px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
        .signoff-row { display: flex; justify-content: space-between; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; }
    `;

    const scoreBoxes = ['overall_score', 'quality', 'compliance', 'risk', 'capacity', 'tax'].map(key => {
        let val;
        if (key === 'overall_score') val = sm.overall ? sm.overall.end : null;
        else val = sm.sub_scores ? (sm.sub_scores[key] ? sm.sub_scores[key].end : null) : null;
        return `<div class="score-box"><div class="score-val">${_fmtNum(val)}</div><div class="score-lbl">${_esc(key.replace(/_/g, ' '))}</div></div>`;
    }).join('');

    const kpiTrendRows = (r.kpi_trends || []).map(t => {
        const deltaStr = t.delta != null ? (t.delta > 0 ? '+' : '') + t.delta : '—';
        return `<tr><td>${_esc(t.metric_key.replace(/_/g, ' '))}</td><td>${_fmtNum(t.start_value)}</td><td>${_fmtNum(t.end_value)}</td><td>${deltaStr}</td><td>${_esc(t.direction || '—')}</td></tr>`;
    }).join('');

    const alertRows = alerts.slice(0, 25).map(a => `<tr><td>${_esc(a.severity)}</td><td>${_esc(a.label)}</td></tr>`).join('');

    const queueTotal = ['knowledge_approvals', 'sop_approvals', 'tax_completion', 'qms_reviews', 'risk_acceptance', 'billing_approval']
        .reduce((sum, k) => sum + ((queue[k] || []).length), 0);

    const feedRows = feed.slice(0, 15).map(f => `<tr><td>${_esc(f.source)}</td><td>${_esc(f.description)}</td><td>${_esc(new Date(f.at).toLocaleString('en-ZA'))}</td></tr>`).join('');

    const warningsHtml = (r.warnings || []).map(w => `<div class="warn">⚠ ${_esc(w)}</div>`).join('') || '<p style="font-size:12px;color:#718096;">No warnings.</p>';

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${_esc(pack.pack_name)} — Partner Review Pack</title><style>${style}</style></head><body>
<h1>1. ${_esc(pack.pack_name)}</h1>
<div class="meta">2. Period: ${_esc(pack.review_period_start)} to ${_esc(pack.review_period_end)} ${pack.period_key ? '(' + _esc(pack.period_key) + ')' : ''} &nbsp;|&nbsp; Status: ${_esc(pack.pack_status)} &nbsp;|&nbsp; Generated: ${_esc(r.generated_at ? new Date(r.generated_at).toLocaleString('en-ZA') : '—')}</div>

<h2>3. Executive Summary</h2>
<p style="font-size:13px;">${_esc(pack.executive_summary) || '<em>No executive summary provided.</em>'}</p>

<h2>4. Practice Score</h2>
${scoreBoxes}

<h2>5. KPI Movement</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th><th>Direction</th></tr></thead><tbody>${kpiTrendRows || '<tr><td colspan="5">No KPI trend data available.</td></tr>'}</tbody></table>

<h2>6. Risk Summary</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>${_movementRows(r.movement && r.movement.risk)}</tbody></table>

<h2>7. QMS Summary</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>${_movementRows(r.movement && r.movement.qms)}</tbody></table>

<h2>8. Tax Summary</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>${_movementRows(r.movement && r.movement.tax)}</tbody></table>

<h2>9. Capacity Summary</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>${_movementRows(r.movement && r.movement.capacity)}</tbody></table>

<h2>10. Client Health Summary</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>${_movementRows(r.movement && r.movement.client_health)}</tbody></table>

<h2>11. Compliance / Document / Reminder Summary</h2>
<table><thead><tr><th>Metric</th><th>Start</th><th>End</th><th>Delta</th></tr></thead><tbody>
${_movementRows(r.movement && r.movement.compliance)}
${_movementRows(r.movement && r.movement.document_requests)}
${_movementRows(r.movement && r.movement.reminders)}
</tbody></table>

<h2>12. Partner Action Queue (${queueTotal})</h2>
<p style="font-size:12px;">Knowledge approvals: ${(queue.knowledge_approvals || []).length} &nbsp;|&nbsp; SOP approvals: ${(queue.sop_approvals || []).length} &nbsp;|&nbsp; Tax completion: ${(queue.tax_completion || []).length} &nbsp;|&nbsp; QMS reviews: ${(queue.qms_reviews || []).length} &nbsp;|&nbsp; Risk acceptance: ${(queue.risk_acceptance || []).length} &nbsp;|&nbsp; Billing approval: ${(queue.billing_approval || []).length}</p>

<h2>13. Key Alerts (${alerts.length})</h2>
<table><thead><tr><th>Severity</th><th>Label</th></tr></thead><tbody>${alertRows || '<tr><td colspan="2">No active alerts.</td></tr>'}</tbody></table>

<h2>Executive Feed (recent activity)</h2>
<table><thead><tr><th>Source</th><th>Description</th><th>At</th></tr></thead><tbody>${feedRows || '<tr><td colspan="3">No recent activity.</td></tr>'}</tbody></table>

<h2>Warnings &amp; Assumptions</h2>
${warningsHtml}

<h2>14. Partner Sign-Off</h2>
<div class="signoff">
<div class="signoff-row"><span>Prepared by</span><span>User #${_esc(pack.prepared_by)} — ${_esc(pack.prepared_at ? new Date(pack.prepared_at).toLocaleString('en-ZA') : '—')}</span></div>
<div class="signoff-row"><span>Reviewed by</span><span>${pack.reviewed_by ? 'User #' + _esc(pack.reviewed_by) + ' — ' + _esc(new Date(pack.reviewed_at).toLocaleString('en-ZA')) : 'Pending'}</span></div>
<div class="signoff-row"><span>Approved by</span><span>${pack.approved_by ? 'User #' + _esc(pack.approved_by) + ' — ' + _esc(new Date(pack.approved_at).toLocaleString('en-ZA')) : 'Pending'}</span></div>
${pack.rejection_reason ? '<div class="signoff-row"><span>Rejection Reason</span><span>' + _esc(pack.rejection_reason) + '</span></div>' : ''}
${pack.partner_notes ? '<div class="signoff-row"><span>Partner Notes</span><span>' + _esc(pack.partner_notes) + '</span></div>' : ''}
</div>

<div class="disclaimer">15. ${_esc(DISCLAIMER)}</div>
</body></html>`;
}

// ── PDF report builder (PDFKit) ────────────────────────────────────────────────

function _pdfHeading(doc, text) {
    doc.moveDown(0.8).fontSize(13).fillColor('#1a1a2e').font('Helvetica-Bold').text(text);
    doc.font('Helvetica').fontSize(9).fillColor('#000');
}

function _pdfMovementTable(doc, section) {
    const rows = Object.keys(section || {});
    if (!rows.length) { doc.fontSize(9).text('No data.'); return; }
    rows.forEach(key => {
        const v = section[key];
        const deltaStr = v.delta != null ? (v.delta > 0 ? '+' : '') + v.delta : '—';
        doc.fontSize(9).text(`${key.replace(/_/g, ' ')}: start ${v.start ?? '—'} → end ${v.end ?? '—'} (Δ ${deltaStr})`);
    });
}

function _buildPdfReport(doc, pack) {
    const r = pack.report_snapshot || {};
    const sm = r.practice_score_movement || {};
    const alerts = (r.latest_alerts && r.latest_alerts.alerts) || [];
    const queue = r.latest_partner_queue || {};

    doc.fontSize(18).font('Helvetica-Bold').text(`1. ${pack.pack_name}`);
    doc.fontSize(9).font('Helvetica').fillColor('#718096')
        .text(`2. Period: ${pack.review_period_start} to ${pack.review_period_end}${pack.period_key ? ' (' + pack.period_key + ')' : ''}`)
        .text(`Status: ${pack.pack_status} | Generated: ${r.generated_at ? new Date(r.generated_at).toLocaleString('en-ZA') : '—'}`);
    doc.fillColor('#000');

    _pdfHeading(doc, '3. Executive Summary');
    doc.fontSize(9).text(pack.executive_summary || 'No executive summary provided.');

    _pdfHeading(doc, '4. Practice Score');
    const scoreLine = ['overall_score', 'quality', 'compliance', 'risk', 'capacity', 'tax'].map(key => {
        const val = key === 'overall_score' ? (sm.overall ? sm.overall.end : null) : (sm.sub_scores && sm.sub_scores[key] ? sm.sub_scores[key].end : null);
        return `${key.replace(/_/g, ' ')}: ${val != null ? val : '—'}`;
    }).join('   |   ');
    doc.fontSize(9).text(scoreLine);

    _pdfHeading(doc, '5. KPI Movement');
    (r.kpi_trends || []).forEach(t => {
        const deltaStr = t.delta != null ? (t.delta > 0 ? '+' : '') + t.delta : '—';
        doc.fontSize(9).text(`${t.metric_key.replace(/_/g, ' ')}: start ${t.start_value ?? '—'} → end ${t.end_value ?? '—'} (Δ ${deltaStr}, ${t.direction || '—'})`);
    });

    _pdfHeading(doc, '6. Risk Summary');
    _pdfMovementTable(doc, r.movement && r.movement.risk);

    _pdfHeading(doc, '7. QMS Summary');
    _pdfMovementTable(doc, r.movement && r.movement.qms);

    _pdfHeading(doc, '8. Tax Summary');
    _pdfMovementTable(doc, r.movement && r.movement.tax);

    _pdfHeading(doc, '9. Capacity Summary');
    _pdfMovementTable(doc, r.movement && r.movement.capacity);

    _pdfHeading(doc, '10. Client Health Summary');
    _pdfMovementTable(doc, r.movement && r.movement.client_health);

    _pdfHeading(doc, '11. Compliance / Document / Reminder Summary');
    _pdfMovementTable(doc, r.movement && r.movement.compliance);
    _pdfMovementTable(doc, r.movement && r.movement.document_requests);
    _pdfMovementTable(doc, r.movement && r.movement.reminders);

    const queueTotal = ['knowledge_approvals', 'sop_approvals', 'tax_completion', 'qms_reviews', 'risk_acceptance', 'billing_approval']
        .reduce((sum, k) => sum + ((queue[k] || []).length), 0);
    _pdfHeading(doc, `12. Partner Action Queue (${queueTotal})`);
    doc.fontSize(9).text(`Knowledge: ${(queue.knowledge_approvals || []).length}  SOP: ${(queue.sop_approvals || []).length}  Tax Completion: ${(queue.tax_completion || []).length}  QMS: ${(queue.qms_reviews || []).length}  Risk: ${(queue.risk_acceptance || []).length}  Billing: ${(queue.billing_approval || []).length}`);

    _pdfHeading(doc, `13. Key Alerts (${alerts.length})`);
    alerts.slice(0, 25).forEach(a => doc.fontSize(9).text(`[${a.severity}] ${a.label}`));
    if (!alerts.length) doc.fontSize(9).text('No active alerts.');

    if ((r.warnings || []).length) {
        _pdfHeading(doc, 'Warnings');
        r.warnings.forEach(w => doc.fontSize(9).fillColor('#dd6b20').text(`⚠ ${w}`));
        doc.fillColor('#000');
    }

    _pdfHeading(doc, '14. Partner Sign-Off');
    doc.fontSize(9).text(`Prepared by: User #${pack.prepared_by || '—'} — ${pack.prepared_at ? new Date(pack.prepared_at).toLocaleString('en-ZA') : '—'}`);
    doc.text(`Reviewed by: ${pack.reviewed_by ? 'User #' + pack.reviewed_by + ' — ' + new Date(pack.reviewed_at).toLocaleString('en-ZA') : 'Pending'}`);
    doc.text(`Approved by: ${pack.approved_by ? 'User #' + pack.approved_by + ' — ' + new Date(pack.approved_at).toLocaleString('en-ZA') : 'Pending'}`);
    if (pack.rejection_reason) doc.text(`Rejection Reason: ${pack.rejection_reason}`);
    if (pack.partner_notes) doc.text(`Partner Notes: ${pack.partner_notes}`);

    doc.moveDown(1).fontSize(8).fillColor('#718096').font('Helvetica-Oblique').text(`15. ${DISCLAIMER}`);

    const range = doc.bufferedPageRange ? doc.bufferedPageRange() : { start: 0, count: 1 };
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.fontSize(7).fillColor('#9ca3af').text(
            `Partner Review Pack #${pack.id}  |  Page ${i + 1} of ${range.count}`,
            50, doc.page.height - 30, { width: doc.page.width - 100, align: 'center' }
        );
    }
}

module.exports = router;
