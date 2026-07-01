'use strict';

const express    = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGE_ORDER = [
    'not_started',
    'docs_requested',
    'docs_received',
    'data_captured',
    'calculation_completed',
    'review_pack_generated',
    'under_review',
    'ready_to_submit',
    'submitted',
    'completed',
];

const ALL_STAGES = [...STAGE_ORDER, 'cancelled'];

// Only these backward moves are permitted
const ALLOWED_BACKWARD = {
    'submitted':      'ready_to_submit',
    'ready_to_submit':'under_review',
    'under_review':   'review_pack_generated',
};

const VALID_SOURCE_TYPES = ['individual_tax_return', 'company_tax_return', 'provisional_tax_plan'];

// Per-source-type configuration for tables and FK names
function _cfg(sourceType) {
    const configs = {
        individual_tax_return: {
            table:     'practice_individual_tax_returns',
            nameField: 'return_name',
            calcTable: 'practice_individual_tax_calculations',
            calcFK:    'tax_return_id',
            packTable: 'practice_individual_tax_review_packs',
            packFK:    'tax_return_id',
            hasCalc:   true,
            hasPack:   true,
        },
        company_tax_return: {
            table:     'practice_company_tax_returns',
            nameField: 'return_name',
            calcTable: 'practice_company_tax_calculations',
            calcFK:    'company_tax_return_id',
            packTable: 'practice_company_tax_review_packs',
            packFK:    'company_tax_return_id',
            hasCalc:   true,
            hasPack:   true,
        },
        provisional_tax_plan: {
            table:     'practice_provisional_tax_plans',
            nameField: 'plan_name',
            calcTable: null,
            calcFK:    null,
            packTable: null,
            packFK:    null,
            hasCalc:   false,
            hasPack:   false,
        },
    };
    return configs[sourceType] || null;
}

// ── Stage transition validation ───────────────────────────────────────────────

function _classifyMove(currentStage, newStage) {
    if (newStage === 'cancelled') return 'cancel';
    const ci = STAGE_ORDER.indexOf(currentStage);
    const ni = STAGE_ORDER.indexOf(newStage);
    if (ci === -1 || ni === -1) return 'invalid';
    if (ni > ci)  return 'forward';
    if (ni === ci) return 'same';
    return 'backward';
}

function _isAllowedTransition(currentStage, newStage) {
    if (currentStage === 'cancelled' || currentStage === 'completed') return false;
    const move = _classifyMove(currentStage, newStage);
    if (move === 'cancel')   return true;
    if (move === 'forward')  return true;  // forward moves always structurally allowed; auto-checks run separately
    if (move === 'backward') return ALLOWED_BACKWARD[currentStage] === newStage;
    return false;
}

async function _runAutoChecks(sourceType, sourceId, cid, newStage) {
    const cfg = _cfg(sourceType);

    if (newStage === 'calculation_completed' && cfg.hasCalc) {
        const { count } = await supabase
            .from(cfg.calcTable)
            .select('id', { count: 'exact', head: true })
            .eq(cfg.calcFK, sourceId)
            .eq('company_id', cid);
        if (!count) {
            return { ok: false, reason: 'No calculation found for this return. Create a calculation before marking calculation completed.' };
        }
    }

    if (newStage === 'review_pack_generated' && cfg.hasPack) {
        const { count } = await supabase
            .from(cfg.packTable)
            .select('id', { count: 'exact', head: true })
            .eq(cfg.packFK, sourceId)
            .eq('company_id', cid);
        if (!count) {
            return { ok: false, reason: 'No review pack found for this return. Generate a review pack before marking this stage.' };
        }
    }

    if (newStage === 'ready_to_submit' && cfg.hasPack) {
        const { data: packs } = await supabase
            .from(cfg.packTable)
            .select('pack_status')
            .eq(cfg.packFK, sourceId)
            .eq('company_id', cid)
            .in('pack_status', ['reviewed', 'approved']);
        if (!packs || packs.length === 0) {
            return { ok: false, reason: 'No reviewed or approved review pack found. The review pack must be reviewed before marking ready to submit.' };
        }
    }

    if (newStage === 'submitted') {
        const cfg2 = _cfg(sourceType);
        if (cfg2.table !== 'practice_provisional_tax_plans') {
            const { data: rec } = await supabase
                .from(cfg2.table)
                .select('readiness_status')
                .eq('id', sourceId)
                .eq('company_id', cid)
                .single();
            if (rec && rec.readiness_status === 'blocked') {
                return { ok: false, reason: 'Return readiness status is blocked. Resolve all blocking items before submitting.' };
            }
        }
    }

    return { ok: true };
}

// ── Fetch a single entity record with ownership check ─────────────────────────

async function _fetchRecord(sourceType, sourceId, cid) {
    const cfg = _cfg(sourceType);
    const { data, error } = await supabase
        .from(cfg.table)
        .select('id, company_id, tax_year, filing_stage, filing_stage_updated_at, filing_stage_updated_by, responsible_team_member_id, reviewer_team_member_id, status, readiness_status')
        .eq('id', sourceId)
        .eq('company_id', cid)
        .single();
    if (error || !data) return null;
    return data;
}

// ── Fetch pipeline events for a source record ─────────────────────────────────

async function _fetchHistory(sourceType, sourceId, cid) {
    const { data } = await supabase
        .from('practice_tax_pipeline_events')
        .select('id, old_stage, new_stage, actor_user_id, notes, metadata, created_at')
        .eq('company_id', cid)
        .eq('source_type', sourceType)
        .eq('source_id', sourceId)
        .order('created_at', { ascending: false });
    return data || [];
}

// ── Write a pipeline event ────────────────────────────────────────────────────

async function _writeEvent(cid, sourceType, sourceId, oldStage, newStage, userId, notes, metadata) {
    await supabase
        .from('practice_tax_pipeline_events')
        .insert({
            company_id:    cid,
            source_type:   sourceType,
            source_id:     sourceId,
            old_stage:     oldStage || null,
            new_stage:     newStage,
            actor_user_id: userId || null,
            notes:         notes || null,
            metadata:      metadata || {},
        });
}

// ── Fetch all pipeline items from one table with filters ──────────────────────

async function _fetchTableItems(sourceType, cid, filters) {
    const cfg = _cfg(sourceType);
    let q = supabase
        .from(cfg.table)
        .select(`id, company_id, tax_year, ${cfg.nameField}, filing_stage, filing_stage_updated_at, responsible_team_member_id, reviewer_team_member_id, status, client_id`)
        .eq('company_id', cid);

    if (filters.filing_stage)                 q = q.eq('filing_stage', filters.filing_stage);
    if (filters.tax_year)                     q = q.eq('tax_year', Number(filters.tax_year));
    if (filters.responsible_team_member_id)   q = q.eq('responsible_team_member_id', Number(filters.responsible_team_member_id));
    if (filters.reviewer_team_member_id)      q = q.eq('reviewer_team_member_id', Number(filters.reviewer_team_member_id));

    const { data } = await q.order('filing_stage_updated_at', { ascending: false, nullsFirst: false });
    return (data || []).map(r => ({
        source_type:                  sourceType,
        source_id:                    r.id,
        client_id:                    r.client_id || null,
        name:                         r[cfg.nameField],
        tax_year:                     r.tax_year,
        filing_stage:                 r.filing_stage,
        filing_stage_updated_at:      r.filing_stage_updated_at,
        responsible_team_member_id:   r.responsible_team_member_id,
        reviewer_team_member_id:      r.reviewer_team_member_id,
        status:                       r.status,
    }));
}

// ── Enrich items with client names ────────────────────────────────────────────

async function _enrichClientNames(items) {
    const clientIds = [...new Set(items.map(i => i.client_id).filter(Boolean))];
    if (!clientIds.length) return items;
    const { data: clients } = await supabase
        .from('practice_clients')
        .select('id, client_name')
        .in('id', clientIds);
    const map = {};
    (clients || []).forEach(c => { map[c.id] = c.client_name; });
    return items.map(i => ({ ...i, client_name: map[i.client_id] || null }));
}

// ── Compute allowed next stages from current stage ────────────────────────────

function _allowedNextStages(currentStage) {
    if (currentStage === 'cancelled' || currentStage === 'completed') return [];
    const result = [];
    // Forward: next stage in sequence
    const ci = STAGE_ORDER.indexOf(currentStage);
    if (ci !== -1 && ci < STAGE_ORDER.length - 1) {
        result.push(STAGE_ORDER[ci + 1]);
    }
    // Backward: allowed pairs
    if (ALLOWED_BACKWARD[currentStage]) {
        result.push(ALLOWED_BACKWARD[currentStage]);
    }
    // Cancellation always allowed
    result.push('cancelled');
    return result;
}

// ── Stage labels for display ──────────────────────────────────────────────────

const STAGE_LABELS = {
    not_started:           'Not Started',
    docs_requested:        'Docs Requested',
    docs_received:         'Docs Received',
    data_captured:         'Data Captured',
    calculation_completed: 'Calculation Done',
    review_pack_generated: 'Review Pack',
    under_review:          'Under Review',
    ready_to_submit:       'Ready To Submit',
    submitted:             'Submitted',
    completed:             'Completed',
    cancelled:             'Cancelled',
};

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        // Count per stage across all 3 entity types
        const [indRes, compRes, provRes] = await Promise.all([
            supabase.from('practice_individual_tax_returns').select('filing_stage').eq('company_id', cid),
            supabase.from('practice_company_tax_returns').select('filing_stage').eq('company_id', cid),
            supabase.from('practice_provisional_tax_plans').select('filing_stage').eq('company_id', cid),
        ]);

        const all = [
            ...(indRes.data  || []),
            ...(compRes.data || []),
            ...(provRes.data || []),
        ];

        const byStage = {};
        ALL_STAGES.forEach(s => { byStage[s] = 0; });
        all.forEach(r => {
            if (byStage[r.filing_stage] !== undefined) byStage[r.filing_stage]++;
        });

        const active   = all.filter(r => !['completed','cancelled'].includes(r.filing_stage)).length;
        const total    = all.length;
        const stageSummary = ALL_STAGES.map(s => ({
            stage:       s,
            label:       STAGE_LABELS[s],
            count:       byStage[s],
        }));

        await auditFromReq(req, 'VIEW', 'tax_pipeline', null, { action: 'summary' });
        res.json({ stage_summary: stageSummary, total, active });
    } catch (err) {
        console.error('[tax-pipeline] summary error:', err);
        res.status(500).json({ error: 'Failed to load pipeline summary' });
    }
});

// ── GET / (combined pipeline list) ───────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid     = req.companyId;
    const filters = {
        filing_stage:               req.query.filing_stage,
        tax_year:                   req.query.tax_year,
        responsible_team_member_id: req.query.responsible_team_member_id,
        reviewer_team_member_id:    req.query.reviewer_team_member_id,
    };
    const sourceTypeFilter = req.query.source_type;

    try {
        const types = sourceTypeFilter && VALID_SOURCE_TYPES.includes(sourceTypeFilter)
            ? [sourceTypeFilter]
            : VALID_SOURCE_TYPES;

        const batches = await Promise.all(types.map(st => _fetchTableItems(st, cid, filters)));
        let items = batches.flat();

        // Sort by stage order, then by filing_stage_updated_at desc within stage
        items.sort((a, b) => {
            const ai = STAGE_ORDER.indexOf(a.filing_stage);
            const bi = STAGE_ORDER.indexOf(b.filing_stage);
            if (ai !== bi) return ai - bi;
            const ad = a.filing_stage_updated_at || '';
            const bd = b.filing_stage_updated_at || '';
            return bd < ad ? -1 : bd > ad ? 1 : 0;
        });

        items = await _enrichClientNames(items);

        await auditFromReq(req, 'VIEW', 'tax_pipeline', null, { action: 'list', count: items.length });
        res.json({ items, count: items.length });
    } catch (err) {
        console.error('[tax-pipeline] list error:', err);
        res.status(500).json({ error: 'Failed to load pipeline items' });
    }
});

// ── GET /:sourceType/:sourceId ────────────────────────────────────────────────

// Completed filings may have a linked submission register entry, which in turn
// may have a manual payment case. This is a read-only convenience lookup so the
// pipeline detail view can surface payment status without a second round trip.
async function _fetchPaymentSummary(sourceType, sourceId, cid) {
    const { data: submission } = await supabase
        .from('practice_tax_submissions')
        .select('id, submission_status, amount_payable, refund_amount')
        .eq('company_id', cid)
        .eq('source_type', sourceType)
        .eq('source_id', sourceId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!submission) return null;

    const { data: payments } = await supabase
        .from('practice_tax_payments')
        .select('id, direction, status, balance_outstanding, due_date')
        .eq('company_id', cid)
        .eq('submission_id', submission.id)
        .order('created_at', { ascending: false });

    return {
        submission_id:        submission.id,
        submission_status:    submission.submission_status,
        amount_payable:       submission.amount_payable,
        refund_amount:        submission.refund_amount,
        payments:             payments || [],
    };
}

router.get('/:sourceType/:sourceId', async (req, res) => {
    const cid        = req.companyId;
    const { sourceType, sourceId } = req.params;
    const sid = Number(sourceId);

    if (!VALID_SOURCE_TYPES.includes(sourceType)) {
        return res.status(400).json({ error: 'Invalid source_type' });
    }
    if (!sid || isNaN(sid)) {
        return res.status(400).json({ error: 'Invalid source_id' });
    }

    try {
        const record = await _fetchRecord(sourceType, sid, cid);
        if (!record) return res.status(404).json({ error: 'Record not found or access denied' });

        const history        = await _fetchHistory(sourceType, sid, cid);
        const allowedStages  = _allowedNextStages(record.filing_stage);
        const paymentSummary = record.filing_stage === 'completed'
            ? await _fetchPaymentSummary(sourceType, sid, cid)
            : null;

        await auditFromReq(req, 'VIEW', 'tax_pipeline', sid, { source_type: sourceType });
        res.json({
            source_type:     sourceType,
            source_id:       sid,
            filing_stage:    record.filing_stage,
            stage_label:     STAGE_LABELS[record.filing_stage] || record.filing_stage,
            filing_stage_updated_at: record.filing_stage_updated_at,
            status:          record.status,
            readiness_status: record.readiness_status || null,
            tax_year:        record.tax_year,
            responsible_team_member_id: record.responsible_team_member_id,
            reviewer_team_member_id:    record.reviewer_team_member_id,
            allowed_next_stages: allowedStages.map(s => ({ stage: s, label: STAGE_LABELS[s] })),
            history,
            payment_summary: paymentSummary,
        });
    } catch (err) {
        console.error('[tax-pipeline] detail error:', err);
        res.status(500).json({ error: 'Failed to load pipeline detail' });
    }
});

// ── PUT /:sourceType/:sourceId/stage ──────────────────────────────────────────

router.put('/:sourceType/:sourceId/stage', async (req, res) => {
    const cid        = req.companyId;
    const { sourceType, sourceId } = req.params;
    const sid = Number(sourceId);
    const { new_stage, notes } = req.body;

    if (!VALID_SOURCE_TYPES.includes(sourceType)) {
        return res.status(400).json({ error: 'Invalid source_type' });
    }
    if (!sid || isNaN(sid)) {
        return res.status(400).json({ error: 'Invalid source_id' });
    }
    if (!new_stage || !ALL_STAGES.includes(new_stage)) {
        return res.status(400).json({ error: `Invalid stage. Allowed: ${ALL_STAGES.join(', ')}` });
    }
    if (new_stage === 'cancelled' && !notes) {
        return res.status(400).json({ error: 'Notes are required when cancelling' });
    }

    try {
        // Ownership check + get current stage
        const record = await _fetchRecord(sourceType, sid, cid);
        if (!record) return res.status(404).json({ error: 'Record not found or access denied' });

        const currentStage = record.filing_stage;
        if (currentStage === new_stage) {
            return res.status(400).json({ error: 'Record is already in that stage' });
        }

        // Structural transition check
        if (!_isAllowedTransition(currentStage, new_stage)) {
            const move = _classifyMove(currentStage, new_stage);
            if (currentStage === 'cancelled' || currentStage === 'completed') {
                return res.status(422).json({ error: `Cannot move from ${currentStage}. This stage is terminal.` });
            }
            if (move === 'backward') {
                return res.status(422).json({ error: `Backward move from ${currentStage} to ${new_stage} is not allowed. Permitted backward moves: submitted→ready_to_submit, ready_to_submit→under_review, under_review→review_pack_generated.` });
            }
            return res.status(422).json({ error: `Stage transition from ${currentStage} to ${new_stage} is not allowed` });
        }

        // Notes required for backward moves
        const move = _classifyMove(currentStage, new_stage);
        if (move === 'backward' && !notes) {
            return res.status(400).json({ error: 'Notes are required for backward stage moves' });
        }

        // Auto-validation checks
        const check = await _runAutoChecks(sourceType, sid, cid, new_stage);
        if (!check.ok) {
            return res.status(422).json({ error: check.reason });
        }

        // Update the source record
        const cfg = _cfg(sourceType);
        const { error: updateErr } = await supabase
            .from(cfg.table)
            .update({
                filing_stage:            new_stage,
                filing_stage_updated_at: new Date().toISOString(),
                filing_stage_updated_by: req.userId || null,
            })
            .eq('id', sid)
            .eq('company_id', cid);

        if (updateErr) {
            console.error('[tax-pipeline] update error:', updateErr);
            return res.status(500).json({ error: 'Failed to update stage' });
        }

        // Write pipeline event
        const metadata = { move_type: move };
        await _writeEvent(cid, sourceType, sid, currentStage, new_stage, req.userId, notes, metadata);

        // Audit log
        const auditAction = new_stage === 'cancelled'
            ? 'tax_pipeline_cancelled'
            : (move === 'backward' ? 'tax_pipeline_reopened' : 'tax_pipeline_stage_changed');
        await auditFromReq(req, auditAction, 'tax_pipeline', sid, {
            source_type: sourceType,
            old_stage:   currentStage,
            new_stage,
            notes:       notes || null,
        });

        res.json({
            ok:          true,
            source_type: sourceType,
            source_id:   sid,
            old_stage:   currentStage,
            new_stage,
            stage_label: STAGE_LABELS[new_stage],
        });
    } catch (err) {
        console.error('[tax-pipeline] stage change error:', err);
        res.status(500).json({ error: 'Failed to change stage' });
    }
});

module.exports = router;
