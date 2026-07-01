'use strict';

// Codebox 49 — Practice Risk Register + Internal Control Matrix
// Internal practice governance: risks, controls, periodic reviews.
//
// NOT enterprise risk software. This is internal practice governance.

const express = require('express');
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

const CATEGORIES = [
    'operational', 'compliance', 'tax', 'payroll', 'finance', 'cyber', 'privacy',
    'fraud', 'business_continuity', 'client_service', 'strategic', 'other',
];

const STATUSES = ['open', 'monitoring', 'mitigated', 'accepted', 'closed', 'cancelled'];
const TERMINAL_STATUSES = ['closed', 'cancelled'];

const REVIEW_FREQUENCIES = ['monthly', 'quarterly', 'biannual', 'annual', 'ad_hoc'];
const EFFECTIVENESS_LEVELS = ['ineffective', 'partially_effective', 'effective'];
const REVIEW_STATUSES = ['draft', 'completed', 'cancelled'];

const SOURCE_TYPES = ['quality_finding', 'knowledge_article', 'tax_dispute', 'completion_pack'];

const SOURCE_TABLE = {
    quality_finding:   'practice_quality_findings',
    knowledge_article: 'practice_knowledge_articles',
    tax_dispute:       'practice_tax_dispute_cases',
    completion_pack:   'practice_tax_completion_packs',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

function _clampInt(n, min, max) {
    const v = Number(n);
    if (isNaN(v)) return null;
    return Math.min(Math.max(Math.round(v), min), max);
}

async function _verifyRisk(id, cid) {
    const { data } = await supabase
        .from('practice_risks')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _verifyControl(controlId, cid) {
    const { data } = await supabase
        .from('practice_risk_controls')
        .select('*')
        .eq('id', controlId)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _verifyReview(reviewId, cid) {
    const { data } = await supabase
        .from('practice_risk_reviews')
        .select('*')
        .eq('id', reviewId)
        .eq('company_id', cid)
        .maybeSingle();
    return data || null;
}

async function _findActiveDuplicate(cid, title, linkedClientId) {
    let q = supabase
        .from('practice_risks')
        .select('id')
        .eq('company_id', cid)
        .ilike('title', title.trim())
        .not('status', 'in', '("closed","cancelled")');
    // PostgREST .eq() never matches NULL — use .is() for the "no linked client" case.
    q = linkedClientId ? q.eq('linked_client_id', linkedClientId) : q.is('linked_client_id', null);
    const { data } = await q.limit(1).maybeSingle();
    return data || null;
}

async function _writeEvent(riskId, cid, eventType, oldStatus, newStatus, userId, notes, meta, opts) {
    await supabase.from('practice_risk_events').insert({
        risk_id:       riskId,
        control_id:    (opts && opts.controlId) || null,
        review_id:     (opts && opts.reviewId)  || null,
        company_id:    cid,
        event_type:    eventType,
        old_status:    oldStatus || null,
        new_status:    newStatus || null,
        actor_user_id: userId    || null,
        notes:         notes     || null,
        metadata:      meta      || {},
    });
}

async function _enrichClientNames(risks, cid) {
    if (!risks || !risks.length) return risks;
    const ids = [...new Set(risks.map(r => r.linked_client_id).filter(Boolean))];
    if (!ids.length) return risks;
    const { data: clients } = await supabase
        .from('practice_clients')
        .select('id, name')
        .eq('company_id', cid)
        .in('id', ids);
    const map = {};
    (clients || []).forEach(c => { map[c.id] = c.name; });
    return risks.map(r => ({ ...r, client_name: r.linked_client_id ? (map[r.linked_client_id] || null) : null }));
}

// ── Routes ────────────────────────────────────────────────────────────────────

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: risks } = await supabase
            .from('practice_risks')
            .select('status, category, likelihood, impact, inherent_risk, next_review_date')
            .eq('company_id', cid);

        const all = risks || [];
        const counts = { open: 0, monitoring: 0, mitigated: 0, accepted: 0, closed: 0, cancelled: 0 };
        const byCategory = {};
        CATEGORIES.forEach(c => { byCategory[c] = 0; });

        const today = new Date().toISOString().slice(0, 10);
        let highInherent = 0;
        let overdueReview = 0;

        all.forEach(r => {
            if (counts[r.status] !== undefined) counts[r.status]++;
            if (byCategory[r.category] !== undefined) byCategory[r.category]++;
            if (!TERMINAL_STATUSES.includes(r.status)) {
                if (r.inherent_risk >= 15) highInherent++;
                if (r.next_review_date && r.next_review_date < today) overdueReview++;
            }
        });

        return res.json({
            total:              all.length,
            active:             all.filter(r => !TERMINAL_STATUSES.includes(r.status)).length,
            open:               counts.open,
            monitoring:         counts.monitoring,
            mitigated:          counts.mitigated,
            accepted:           counts.accepted,
            closed:             counts.closed,
            cancelled:          counts.cancelled,
            high_inherent_risk: highInherent,
            overdue_review:     overdueReview,
            by_category:        byCategory,
        });
    } catch (err) {
        console.error('GET /api/practice/risk-register/summary', err);
        return res.status(500).json({ error: 'Failed to load risk register summary.' });
    }
});

// ── GET /heatmap ──────────────────────────────────────────────────────────────
// Simple 5x5 matrix — count of active risks per (likelihood, impact) cell.

router.get('/heatmap', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: risks } = await supabase
            .from('practice_risks')
            .select('likelihood, impact, status')
            .eq('company_id', cid)
            .not('status', 'in', '("closed","cancelled")');

        const grid = [];
        for (let l = 1; l <= 5; l++) {
            const row = [];
            for (let i = 1; i <= 5; i++) {
                row.push({ likelihood: l, impact: i, count: 0 });
            }
            grid.push(row);
        }
        (risks || []).forEach(r => {
            if (r.likelihood >= 1 && r.likelihood <= 5 && r.impact >= 1 && r.impact <= 5) {
                grid[r.likelihood - 1][r.impact - 1].count++;
            }
        });

        return res.json({ grid, total_active: (risks || []).length });
    } catch (err) {
        console.error('GET /api/practice/risk-register/heatmap', err);
        return res.status(500).json({ error: 'Failed to load risk heat map.' });
    }
});

// ── GET /risks (list with filters + pagination) ──────────────────────────────

router.get('/risks', async (req, res) => {
    const cid = req.companyId;
    const {
        search, category, status, linked_client_id, owner_team_member_id,
        source_type, source_id, page = 1, limit = 50,
    } = req.query;

    try {
        if (category && !CATEGORIES.includes(category)) {
            return res.status(400).json({ error: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
        }
        if (status && !STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${STATUSES.join(', ')}` });
        }

        let q = supabase
            .from('practice_risks')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (category)             q = q.eq('category', category);
        if (status)               q = q.eq('status', status);
        if (linked_client_id)     q = q.eq('linked_client_id', Number(linked_client_id));
        if (owner_team_member_id) q = q.eq('owner_team_member_id', Number(owner_team_member_id));
        if (source_type)          q = q.eq('source_type', source_type);
        if (source_id)            q = q.eq('source_id', Number(source_id));

        if (search) {
            const s = String(search).trim().replace(/[%,]/g, '');
            if (s) q = q.or(`title.ilike.%${s}%,mitigation_plan.ilike.%${s}%,monitoring_notes.ilike.%${s}%`);
        }

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (p - 1) * l;

        q = q.order('inherent_risk', { ascending: false }).range(offset, offset + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;

        const enriched = await _enrichClientNames(data || [], cid);

        return res.json({ risks: enriched, total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/risk-register/risks', err);
        return res.status(500).json({ error: 'Failed to load risks.' });
    }
});

// ── POST /risks (manual create) ───────────────────────────────────────────────

router.post('/risks', async (req, res) => {
    const cid = req.companyId;
    const {
        title, category, owner_team_member_id, linked_client_id,
        likelihood, impact, review_frequency, next_review_date,
        mitigation_plan, contingency_plan, monitoring_notes,
    } = req.body || {};

    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required.' });
    if (!category || !CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category is required. Allowed: ${CATEGORIES.join(', ')}` });
    }
    const l = _clampInt(likelihood, 1, 5);
    const i = _clampInt(impact, 1, 5);
    if (l == null) return res.status(400).json({ error: 'likelihood is required and must be between 1 and 5.' });
    if (i == null) return res.status(400).json({ error: 'impact is required and must be between 1 and 5.' });
    if (review_frequency && !REVIEW_FREQUENCIES.includes(review_frequency)) {
        return res.status(400).json({ error: `Invalid review_frequency. Allowed: ${REVIEW_FREQUENCIES.join(', ')}` });
    }

    try {
        const clientId = linked_client_id ? Number(linked_client_id) : null;
        const dup = await _findActiveDuplicate(cid, String(title), clientId);
        if (dup) {
            return res.status(409).json({
                error: 'An active risk already exists with this title for this client.',
                existing_risk_id: dup.id,
            });
        }

        const { data: risk, error } = await supabase
            .from('practice_risks')
            .insert({
                company_id:            cid,
                title:                 String(title).trim(),
                category,
                status:                'open',
                owner_team_member_id:  owner_team_member_id ? Number(owner_team_member_id) : null,
                linked_client_id:      clientId,
                likelihood:            l,
                impact:                i,
                inherent_risk:         l * i,
                review_frequency:      review_frequency || 'annual',
                next_review_date:      next_review_date || null,
                mitigation_plan:       mitigation_plan    || null,
                contingency_plan:      contingency_plan   || null,
                monitoring_notes:      monitoring_notes   || null,
                created_by:            req.user?.userId,
                updated_by:            req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'risk_created', null, 'open', req.user?.userId, null, { category, inherent_risk: risk.inherent_risk });
        await auditFromReq(req, 'risk_created', 'practice_risk', risk.id, { category });

        return res.status(201).json(risk);
    } catch (err) {
        console.error('POST /api/practice/risk-register/risks', err);
        return res.status(500).json({ error: 'Failed to create risk.' });
    }
});

// ── Create-from-source helpers ───────────────────────────────────────────────

async function _createFromSource(req, res, opts) {
    const cid = req.companyId;
    const { sourceIdField, sourceType, defaultCategory, defaultTitlePrefix, titleField, hasClientId, clientIdVia } = opts;
    const sourceId = Number(req.body?.[sourceIdField]);

    if (!sourceId || isNaN(sourceId)) {
        return res.status(400).json({ error: `${sourceIdField} is required.` });
    }

    const l = _clampInt(req.body?.likelihood, 1, 5) || 3;
    const i = _clampInt(req.body?.impact, 1, 5) || 3;

    try {
        const table = SOURCE_TABLE[sourceType];
        const { data: source } = await supabase
            .from(table)
            .select('*')
            .eq('id', sourceId)
            .eq('company_id', cid)
            .maybeSingle();
        if (!source) return res.status(404).json({ error: 'Source record not found or access denied.' });

        // Resolve client_id: direct column, or (for quality_finding) via its parent review.
        let clientId = req.body?.linked_client_id ? Number(req.body.linked_client_id) : null;
        if (!clientId && hasClientId) clientId = source.client_id || null;
        if (!clientId && clientIdVia === 'quality_review') {
            const { data: review } = await supabase
                .from('practice_quality_reviews')
                .select('client_id')
                .eq('id', source.review_id)
                .eq('company_id', cid)
                .maybeSingle();
            clientId = (review && review.client_id) || null;
        }

        const title = (req.body?.title && req.body.title.trim())
            || `${defaultTitlePrefix} — ${source[titleField] || ('#' + sourceId)}`;

        const dup = await _findActiveDuplicate(cid, title, clientId);
        if (dup) {
            return res.status(409).json({
                error: 'An active risk already exists with this title for this client.',
                existing_risk_id: dup.id,
            });
        }

        const { data: risk, error } = await supabase
            .from('practice_risks')
            .insert({
                company_id:            cid,
                title:                 title.slice(0, 500),
                category:              req.body?.category && CATEGORIES.includes(req.body.category) ? req.body.category : defaultCategory,
                status:                'open',
                owner_team_member_id:  req.body?.owner_team_member_id ? Number(req.body.owner_team_member_id) : null,
                linked_client_id:      clientId,
                likelihood:            l,
                impact:                i,
                inherent_risk:         l * i,
                review_frequency:      req.body?.review_frequency && REVIEW_FREQUENCIES.includes(req.body.review_frequency) ? req.body.review_frequency : 'annual',
                mitigation_plan:       req.body?.mitigation_plan || null,
                monitoring_notes:      req.body?.monitoring_notes || null,
                source_type:           sourceType,
                source_id:             sourceId,
                created_by:            req.user?.userId,
                updated_by:            req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'risk_created', null, 'open', req.user?.userId, null, {
            source_type: sourceType, source_id: sourceId,
        });
        await auditFromReq(req, 'risk_created', 'practice_risk', risk.id, { source_type: sourceType, source_id: sourceId });

        return res.status(201).json(risk);
    } catch (err) {
        console.error(`POST /api/practice/risk-register/create-from-${sourceType}`, err);
        return res.status(500).json({ error: 'Failed to create risk from source.' });
    }
}

router.post('/create-from-finding', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'finding_id', sourceType: 'quality_finding', defaultCategory: 'operational',
    defaultTitlePrefix: 'Quality Finding Risk', titleField: 'finding_title', hasClientId: false, clientIdVia: 'quality_review',
}));

router.post('/create-from-knowledge-article', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'article_id', sourceType: 'knowledge_article', defaultCategory: 'compliance',
    defaultTitlePrefix: 'Knowledge Article Risk', titleField: 'title', hasClientId: false,
}));

router.post('/create-from-tax-dispute', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'dispute_id', sourceType: 'tax_dispute', defaultCategory: 'tax',
    defaultTitlePrefix: 'Tax Dispute Risk', titleField: 'title', hasClientId: true,
}));

router.post('/create-from-completion-pack', (req, res) => _createFromSource(req, res, {
    sourceIdField: 'completion_pack_id', sourceType: 'completion_pack', defaultCategory: 'tax',
    defaultTitlePrefix: 'Completion Pack Risk', titleField: 'id', hasClientId: true,
}));

// ── GET /risks/:id ─────────────────────────────────────────────────────────────

router.get('/risks/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        const [enriched] = await _enrichClientNames([risk], cid);
        return res.json(enriched);
    } catch (err) {
        console.error('GET /api/practice/risk-register/risks/:id', err);
        return res.status(500).json({ error: 'Failed to load risk.' });
    }
});

// ── PUT /risks/:id (update) ───────────────────────────────────────────────────

router.put('/risks/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = [
        'title', 'category', 'owner_team_member_id', 'linked_client_id',
        'likelihood', 'impact', 'residual_risk', 'review_frequency', 'next_review_date',
        'mitigation_plan', 'contingency_plan', 'monitoring_notes',
    ];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }
    if (patch.category && !CATEGORIES.includes(patch.category)) {
        return res.status(400).json({ error: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
    }
    if (patch.review_frequency && !REVIEW_FREQUENCIES.includes(patch.review_frequency)) {
        return res.status(400).json({ error: `Invalid review_frequency. Allowed: ${REVIEW_FREQUENCIES.join(', ')}` });
    }

    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        if (TERMINAL_STATUSES.includes(risk.status)) {
            return res.status(422).json({ error: `Cannot edit a ${risk.status} risk.` });
        }

        // Recompute inherent_risk if likelihood or impact changed.
        let newLikelihood = risk.likelihood;
        let newImpact     = risk.impact;
        if ('likelihood' in patch) {
            newLikelihood = _clampInt(patch.likelihood, 1, 5);
            if (newLikelihood == null) return res.status(400).json({ error: 'likelihood must be between 1 and 5.' });
            patch.likelihood = newLikelihood;
        }
        if ('impact' in patch) {
            newImpact = _clampInt(patch.impact, 1, 5);
            if (newImpact == null) return res.status(400).json({ error: 'impact must be between 1 and 5.' });
            patch.impact = newImpact;
        }
        if ('likelihood' in patch || 'impact' in patch) {
            patch.inherent_risk = newLikelihood * newImpact;
        }
        if ('residual_risk' in patch && patch.residual_risk != null) {
            const rr = _clampInt(patch.residual_risk, 1, 25);
            if (rr == null) return res.status(400).json({ error: 'residual_risk must be between 1 and 25.' });
            patch.residual_risk = rr;
        }
        if ('owner_team_member_id' in patch) patch.owner_team_member_id = patch.owner_team_member_id ? Number(patch.owner_team_member_id) : null;
        if ('linked_client_id' in patch)     patch.linked_client_id     = patch.linked_client_id     ? Number(patch.linked_client_id)     : null;

        const { data: updated, error } = await supabase
            .from('practice_risks')
            .update({ ...patch, updated_by: req.user?.userId })
            .eq('id', risk.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'risk_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'risk_updated', 'practice_risk', risk.id, { fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/risk-register/risks/:id', err);
        return res.status(500).json({ error: 'Failed to update risk.' });
    }
});

// ── DELETE /risks/:id (soft cancel) ───────────────────────────────────────────

router.delete('/risks/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        if (TERMINAL_STATUSES.includes(risk.status)) {
            return res.status(422).json({ error: `Risk is already ${risk.status}.` });
        }

        const { data: updated, error } = await supabase
            .from('practice_risks')
            .update({ status: 'cancelled', updated_by: req.user?.userId })
            .eq('id', risk.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'risk_cancelled', risk.status, 'cancelled', req.user?.userId, reason || null, {});
        await auditFromReq(req, 'risk_cancelled', 'practice_risk', risk.id, { previous_status: risk.status });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/risk-register/risks/:id', err);
        return res.status(500).json({ error: 'Failed to cancel risk.' });
    }
});

// ── PUT /risks/:id/close ───────────────────────────────────────────────────────

router.put('/risks/:id/close', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        if (TERMINAL_STATUSES.includes(risk.status)) {
            return res.status(422).json({ error: `Risk is already ${risk.status}.` });
        }

        const { data: updated, error } = await supabase
            .from('practice_risks')
            .update({ status: 'closed', updated_by: req.user?.userId })
            .eq('id', risk.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'risk_closed', risk.status, 'closed', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'risk_closed', 'practice_risk', risk.id, { previous_status: risk.status });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/risk-register/risks/:id/close', err);
        return res.status(500).json({ error: 'Failed to close risk.' });
    }
});

// ── PUT /risks/:id/reopen ──────────────────────────────────────────────────────

router.put('/risks/:id/reopen', async (req, res) => {
    const cid = req.companyId;
    const { notes } = req.body || {};
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        if (!TERMINAL_STATUSES.includes(risk.status)) {
            return res.status(422).json({ error: `Risk is not closed or cancelled — current status: "${risk.status}".` });
        }

        const { data: updated, error } = await supabase
            .from('practice_risks')
            .update({ status: 'open', updated_by: req.user?.userId })
            .eq('id', risk.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'risk_reopened', risk.status, 'open', req.user?.userId, notes || null, {});
        await auditFromReq(req, 'risk_reopened', 'practice_risk', risk.id, { previous_status: risk.status });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/risk-register/risks/:id/reopen', err);
        return res.status(500).json({ error: 'Failed to reopen risk.' });
    }
});

// ── GET /risks/:id/controls ────────────────────────────────────────────────────

router.get('/risks/:id/controls', async (req, res) => {
    const cid = req.companyId;
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });

        const { data, error } = await supabase
            .from('practice_risk_controls')
            .select('*')
            .eq('risk_id', risk.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ controls: data || [] });
    } catch (err) {
        console.error('GET /api/practice/risk-register/risks/:id/controls', err);
        return res.status(500).json({ error: 'Failed to load controls.' });
    }
});

// ── POST /risks/:id/controls ───────────────────────────────────────────────────

router.post('/risks/:id/controls', async (req, res) => {
    const cid = req.companyId;
    const { control_title, control_type, owner_team_member_id, effectiveness, review_date, evidence_notes } = req.body || {};

    if (!control_title || !String(control_title).trim()) return res.status(400).json({ error: 'control_title is required.' });
    if (effectiveness && !EFFECTIVENESS_LEVELS.includes(effectiveness)) {
        return res.status(400).json({ error: `Invalid effectiveness. Allowed: ${EFFECTIVENESS_LEVELS.join(', ')}` });
    }

    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        if (TERMINAL_STATUSES.includes(risk.status)) {
            return res.status(422).json({ error: `Cannot add controls to a ${risk.status} risk.` });
        }

        const { data: control, error } = await supabase
            .from('practice_risk_controls')
            .insert({
                company_id:            cid,
                risk_id:               risk.id,
                control_title:         String(control_title).trim(),
                control_type:          control_type || null,
                owner_team_member_id:  owner_team_member_id ? Number(owner_team_member_id) : null,
                effectiveness:         effectiveness || null,
                review_date:           review_date || null,
                evidence_notes:        evidence_notes || null,
                created_by:            req.user?.userId,
                updated_by:            req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'control_added', null, null, req.user?.userId, null, {
            control_title: control.control_title,
        }, { controlId: control.id });
        await auditFromReq(req, 'risk_control_added', 'practice_risk', risk.id, { control_id: control.id });

        return res.status(201).json(control);
    } catch (err) {
        console.error('POST /api/practice/risk-register/risks/:id/controls', err);
        return res.status(500).json({ error: 'Failed to add control.' });
    }
});

// ── PUT /controls/:controlId (update) ─────────────────────────────────────────

router.put('/controls/:controlId', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE = ['control_title', 'control_type', 'owner_team_member_id', 'effectiveness', 'review_date', 'evidence_notes'];
    const patch = _pick(req.body || {}, EDITABLE);

    if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No editable fields provided.', editable: EDITABLE });
    }
    if (patch.effectiveness && !EFFECTIVENESS_LEVELS.includes(patch.effectiveness)) {
        return res.status(400).json({ error: `Invalid effectiveness. Allowed: ${EFFECTIVENESS_LEVELS.join(', ')}` });
    }
    if ('owner_team_member_id' in patch) patch.owner_team_member_id = patch.owner_team_member_id ? Number(patch.owner_team_member_id) : null;

    try {
        const control = await _verifyControl(req.params.controlId, cid);
        if (!control) return res.status(404).json({ error: 'Control not found.' });
        if (!control.is_active) return res.status(422).json({ error: 'Cannot edit a removed control.' });

        const { data: updated, error } = await supabase
            .from('practice_risk_controls')
            .update({ ...patch, updated_by: req.user?.userId })
            .eq('id', control.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(control.risk_id, cid, 'control_updated', null, null, req.user?.userId, null, {
            fields: Object.keys(patch),
        }, { controlId: control.id });
        await auditFromReq(req, 'risk_control_updated', 'practice_risk', control.risk_id, { control_id: control.id, fields: Object.keys(patch) });

        return res.json(updated);
    } catch (err) {
        console.error('PUT /api/practice/risk-register/controls/:controlId', err);
        return res.status(500).json({ error: 'Failed to update control.' });
    }
});

// ── DELETE /controls/:controlId (soft remove) ─────────────────────────────────

router.delete('/controls/:controlId', async (req, res) => {
    const cid = req.companyId;
    try {
        const control = await _verifyControl(req.params.controlId, cid);
        if (!control) return res.status(404).json({ error: 'Control not found.' });
        if (!control.is_active) return res.status(422).json({ error: 'Control is already removed.' });

        const { data: updated, error } = await supabase
            .from('practice_risk_controls')
            .update({ is_active: false, updated_by: req.user?.userId })
            .eq('id', control.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(control.risk_id, cid, 'control_removed', null, null, req.user?.userId, null, {
            control_title: control.control_title,
        }, { controlId: control.id });
        await auditFromReq(req, 'risk_control_removed', 'practice_risk', control.risk_id, { control_id: control.id });

        return res.json(updated);
    } catch (err) {
        console.error('DELETE /api/practice/risk-register/controls/:controlId', err);
        return res.status(500).json({ error: 'Failed to remove control.' });
    }
});

// ── GET /risks/:id/reviews ─────────────────────────────────────────────────────

router.get('/risks/:id/reviews', async (req, res) => {
    const cid = req.companyId;
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });

        const { data, error } = await supabase
            .from('practice_risk_reviews')
            .select('*')
            .eq('risk_id', risk.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ reviews: data || [] });
    } catch (err) {
        console.error('GET /api/practice/risk-register/risks/:id/reviews', err);
        return res.status(500).json({ error: 'Failed to load reviews.' });
    }
});

// ── POST /risks/:id/reviews (create/schedule a review) ────────────────────────

router.post('/risks/:id/reviews', async (req, res) => {
    const cid = req.companyId;
    const { next_review_date, review_notes } = req.body || {};
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });
        if (TERMINAL_STATUSES.includes(risk.status)) {
            return res.status(422).json({ error: `Cannot schedule a review for a ${risk.status} risk.` });
        }

        const { data: review, error } = await supabase
            .from('practice_risk_reviews')
            .insert({
                company_id:       cid,
                risk_id:          risk.id,
                review_status:    'draft',
                review_notes:     review_notes || null,
                next_review_date: next_review_date || null,
                created_by:       req.user?.userId,
            })
            .select()
            .single();
        if (error) throw error;

        await _writeEvent(risk.id, cid, 'review_created', null, 'draft', req.user?.userId, null, {}, { reviewId: review.id });
        await auditFromReq(req, 'risk_review_created', 'practice_risk', risk.id, { review_id: review.id });

        return res.status(201).json(review);
    } catch (err) {
        console.error('POST /api/practice/risk-register/risks/:id/reviews', err);
        return res.status(500).json({ error: 'Failed to create review.' });
    }
});

// ── PUT /reviews/:reviewId/complete ───────────────────────────────────────────
// Snapshots the assessment and propagates it to the parent risk (likelihood,
// impact, inherent_risk recomputed, residual_risk, next_review_date).

router.put('/reviews/:reviewId/complete', async (req, res) => {
    const cid = req.companyId;
    const { likelihood, impact, residual_risk, review_notes, next_review_date } = req.body || {};

    try {
        const review = await _verifyReview(req.params.reviewId, cid);
        if (!review) return res.status(404).json({ error: 'Review not found.' });
        if (review.review_status !== 'draft') {
            return res.status(422).json({ error: `Review must be "draft" status to complete. Current: "${review.review_status}".` });
        }

        const risk = await _verifyRisk(review.risk_id, cid);
        if (!risk) return res.status(404).json({ error: 'Parent risk not found.' });

        const l = likelihood != null ? _clampInt(likelihood, 1, 5) : risk.likelihood;
        const i = impact     != null ? _clampInt(impact, 1, 5)     : risk.impact;
        if (l == null || i == null) return res.status(400).json({ error: 'likelihood and impact must be between 1 and 5.' });

        let rr = risk.residual_risk;
        if (residual_risk != null) {
            rr = _clampInt(residual_risk, 1, 25);
            if (rr == null) return res.status(400).json({ error: 'residual_risk must be between 1 and 25.' });
        }

        const now = new Date().toISOString();

        const { data: updatedReview, error: reviewErr } = await supabase
            .from('practice_risk_reviews')
            .update({
                review_status:           'completed',
                likelihood_at_review:    l,
                impact_at_review:        i,
                residual_risk_at_review: rr,
                review_notes:            review_notes || review.review_notes,
                next_review_date:        next_review_date || review.next_review_date,
                reviewed_at:             now,
                reviewed_by:             req.user?.userId || null,
            })
            .eq('id', review.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (reviewErr) throw reviewErr;

        const riskUpdates = {
            likelihood:     l,
            impact:         i,
            inherent_risk:  l * i,
            residual_risk:  rr,
            updated_by:     req.user?.userId,
        };
        if (next_review_date || review.next_review_date) {
            riskUpdates.next_review_date = next_review_date || review.next_review_date;
        }

        const { data: updatedRisk, error: riskErr } = await supabase
            .from('practice_risks')
            .update(riskUpdates)
            .eq('id', risk.id)
            .eq('company_id', cid)
            .select()
            .single();
        if (riskErr) throw riskErr;

        await _writeEvent(risk.id, cid, 'review_completed', 'draft', 'completed', req.user?.userId, review_notes || null, {
            likelihood: l, impact: i, residual_risk: rr,
        }, { reviewId: review.id });
        await auditFromReq(req, 'risk_review_completed', 'practice_risk', risk.id, { review_id: review.id });

        return res.json({ review: updatedReview, risk: updatedRisk });
    } catch (err) {
        console.error('PUT /api/practice/risk-register/reviews/:reviewId/complete', err);
        return res.status(500).json({ error: 'Failed to complete review.' });
    }
});

// ── GET /risks/:id/events (append-only audit log) ─────────────────────────────

router.get('/risks/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const risk = await _verifyRisk(req.params.id, cid);
        if (!risk) return res.status(404).json({ error: 'Risk not found.' });

        const { data, error } = await supabase
            .from('practice_risk_events')
            .select('*')
            .eq('risk_id', risk.id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/risk-register/risks/:id/events', err);
        return res.status(500).json({ error: 'Failed to load events.' });
    }
});

module.exports = router;
