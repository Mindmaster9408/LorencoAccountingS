'use strict';

// Codebox 74 — Practice Pricing Review + Fee Adjustment Workflow
// "Should this client's commercial arrangement be reviewed?" — NOT "what
// should we charge?" This module governs the DECISION process only. It
// never modifies invoices, accounting, billing, or engagements — and it
// never suggests a specific fee. "Implemented" means the commercial
// decision has been accepted; a future codebox may consume that fact to
// actually update an engagement's fee. This module never does that itself.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];
const PARTNER_ROLES = ['owner', 'partner'];

const REVIEW_REASONS = ['profitability', 'scope_change', 'inflation', 'annual_review', 'client_growth', 'service_growth', 'writeoffs', 'low_realization', 'manual', 'other'];
const FEE_BASES = ['fixed_monthly', 'fixed_annual', 'hourly', 'per_service', 'once_off', 'retainer', 'quote_based', 'no_charge', 'other'];
const PRICING_STATUSES = ['draft', 'under_review', 'partner_review', 'approved', 'rejected', 'implemented', 'cancelled'];
const RECOMMENDED_ACTIONS = ['increase_fee', 'decrease_fee', 'change_fee_basis', 'change_scope', 'split_services', 'merge_services', 'engagement_update', 'monitor', 'no_change'];
const ITEM_TYPES = ['low_realization', 'high_writeoffs', 'scope_creep', 'time_increase', 'new_services', 'additional_compliance', 'manual_justification', 'other'];

const TERMINAL_PRICING_STATUSES = ['implemented', 'rejected', 'cancelled'];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _myTeamMember(cid, userId) {
    if (!userId) return null;
    const { data } = await supabase.from('practice_team_members').select('id, display_name, role')
        .eq('company_id', cid).eq('user_id', userId).eq('is_active', true).maybeSingle();
    return data || null;
}
function _isManager(member) { return !!member && MANAGER_ROLES.includes(member.role); }
function _isPartner(member) { return !!member && PARTNER_ROLES.includes(member.role); }

async function _requireManager(req, res) {
    const member = await _myTeamMember(req.companyId, req.user?.userId);
    if (!_isManager(member)) {
        res.status(403).json({ error: 'Only owners, partners, admins, and practice managers can manage pricing reviews.' });
        return null;
    }
    return member;
}

async function _verifyClient(cid, clientId) {
    const { data } = await supabase.from('practice_clients').select('id, name').eq('id', clientId).eq('company_id', cid).eq('is_active', true).maybeSingle();
    return data || null;
}

async function _fetchReview(cid, id) {
    const { data } = await supabase.from('practice_pricing_reviews').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, reviewId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_pricing_events').insert({
        company_id: cid, pricing_review_id: reviewId, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

// ── Pricing Engine — buildPricingReview() ────────────────────────────────────
// Pure, read-only evidence preparation. NEVER computes or suggests a fee
// amount — only gathers the facts a partner needs to decide, and suggests a
// deterministic review_reason category plus candidate evidence items. See
// docs/new-app/74_pricing_review.md for the full "may recommend a category,
// never a number" reasoning.

async function buildPricingReview(cid, { clientId, engagementId, profitabilityReviewId }) {
    const client = await _verifyClient(cid, clientId);
    if (!client) throw new Error('Client not found');

    let engagement = null;
    if (engagementId) {
        const { data } = await supabase.from('practice_client_engagements').select('*').eq('id', engagementId).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
        if (!data) throw new Error('Engagement not found for this client');
        engagement = data;
    }

    let profitabilityReview = null;
    let snapshot = null;
    if (profitabilityReviewId) {
        const { data } = await supabase.from('practice_profitability_reviews').select('*').eq('id', profitabilityReviewId).eq('company_id', cid).maybeSingle();
        if (!data) throw new Error('Profitability review not found');
        profitabilityReview = data;
        if (data.snapshot_id) {
            const { data: snap } = await supabase.from('practice_profitability_snapshots').select('*').eq('id', data.snapshot_id).eq('company_id', cid).maybeSingle();
            snapshot = snap || null;
        }
    } else {
        // Best-effort: the client/engagement's most recently SAVED
        // profitability snapshot, if one exists. Never triggers a new
        // calculation — that remains an explicit action on the
        // Profitability page itself.
        try {
            let q = supabase.from('practice_profitability_snapshots').select('*').eq('company_id', cid).eq('client_id', clientId).order('created_at', { ascending: false }).limit(1);
            if (engagementId) q = q.eq('engagement_id', engagementId);
            const { data } = await q.maybeSingle();
            snapshot = data || null;
        } catch (e) { snapshot = null; }
    }

    const suggestedItems = [];
    let suggestedReason = 'manual';
    if (snapshot) {
        if (['unprofitable', 'low_margin'].includes(snapshot.profitability_status)) {
            suggestedReason = 'profitability';
        } else if ((snapshot.warnings || []).includes('HIGH_WRITEOFFS')) {
            suggestedReason = 'writeoffs';
        } else if (snapshot.realization_percentage != null && snapshot.realization_percentage < 70) {
            suggestedReason = 'low_realization';
        }
        if (snapshot.realization_percentage != null && snapshot.realization_percentage < 85) {
            suggestedItems.push({ item_type: 'low_realization', title: `Realization at ${snapshot.realization_percentage}%`, description: 'Billed value relative to recoverable value for the analyzed period.', supporting_value: snapshot.realization_percentage });
        }
        if (Number(snapshot.writeoff_value) > 0) {
            suggestedItems.push({ item_type: 'high_writeoffs', title: `Write-offs of R${snapshot.writeoff_value}`, description: 'Write-off value recorded for the analyzed period.', supporting_value: snapshot.writeoff_value });
        }
        if ((snapshot.warnings || []).includes('HIGH_NONBILLABLE_TIME')) {
            suggestedItems.push({ item_type: 'scope_creep', title: 'High non-billable time recorded', description: 'A high share of recorded hours were non-billable in the analyzed period — may indicate scope creep or process inefficiency.', supporting_value: snapshot.nonbillable_hours });
        }
    }

    return {
        client, engagement, profitability_review: profitabilityReview, profitability_snapshot: snapshot,
        current_fee_basis: engagement ? (engagement.fee_basis || null) : null,
        current_fee_amount: engagement ? (engagement.fee_amount || null) : null,
        suggested_review_reason: suggestedReason,
        suggested_review_items: suggestedItems,
        assumptions: [
            'current_fee_basis/current_fee_amount are read live from the engagement at prepare-time — a point-in-time snapshot copied onto the review only when it is actually created, never a live link.',
            'suggested_review_reason and suggested_review_items are deterministic category suggestions based on the most recent profitability snapshot for this client/engagement — never a suggested fee amount.',
            snapshot ? `Profitability snapshot used: #${snapshot.id} (${snapshot.period_start} to ${snapshot.period_end}).` : 'No profitability snapshot found — suggestions are based on manual review only.',
        ],
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: rows } = await supabase.from('practice_pricing_reviews').select('pricing_status').eq('company_id', cid);
        const reviews = rows || [];
        const statusCounts = {}; PRICING_STATUSES.forEach(s => { statusCounts[s] = 0; });
        reviews.forEach(r => { if (r.pricing_status in statusCounts) statusCounts[r.pricing_status]++; });

        res.json({
            reviews_total: reviews.length,
            by_pricing_status: statusCounts,
            partner_approvals_waiting: statusCounts.partner_review,
            commercial_discussions_pending: statusCounts.under_review + statusCounts.partner_review,
            approved_not_implemented: statusCounts.approved,
        });
    } catch (err) {
        console.error('Pricing-review /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PREPARE (read-only evidence gathering)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/prepare', async (req, res) => {
    const cid = req.companyId;
    const { client_id, engagement_id, profitability_review_id } = req.query;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    try {
        const prepared = await buildPricingReview(cid, {
            clientId, engagementId: engagement_id ? parseInt(engagement_id) : null,
            profitabilityReviewId: profitability_review_id ? parseInt(profitability_review_id) : null,
        });
        res.json(prepared);
    } catch (err) {
        console.error('Pricing-review GET /prepare error:', err.message);
        res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
    const cid = req.companyId;
    const { client_id, engagement_id, pricing_status, assigned_partner_id, limit = 200 } = req.query;
    try {
        let q = supabase.from('practice_pricing_reviews').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 200));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (engagement_id) q = q.eq('engagement_id', parseInt(engagement_id));
        if (pricing_status) q = q.eq('pricing_status', pricing_status);
        if (assigned_partner_id) q = q.eq('assigned_partner_id', parseInt(assigned_partner_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(r => r.client_id))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clients } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clients || []).forEach(c => { nameById[c.id] = c.name; });
        }
        res.json({ reviews: (data || []).map(r => ({ ...r, client_name: nameById[r.client_id] || null })) });
    } catch (err) {
        console.error('Pricing-review GET list error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;

    const { client_id, engagement_id, profitability_review_id, review_title, review_reason, review_items } = req.body;
    const clientId = parseInt(client_id);
    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    if (!review_title) return res.status(400).json({ error: 'review_title is required' });
    if (!REVIEW_REASONS.includes(review_reason)) return res.status(400).json({ error: 'Invalid review_reason' });
    const client = await _verifyClient(cid, clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    let engagementId = null;
    if (engagement_id) {
        const { data: eng } = await supabase.from('practice_client_engagements').select('id, fee_basis, fee_amount').eq('id', parseInt(engagement_id)).eq('company_id', cid).eq('client_id', clientId).maybeSingle();
        if (!eng) return res.status(404).json({ error: 'Engagement not found for this client' });
        engagementId = eng.id;
    }
    if (req.body.current_fee_basis && !FEE_BASES.includes(req.body.current_fee_basis)) return res.status(400).json({ error: 'Invalid current_fee_basis' });
    if (req.body.proposed_fee_basis && !FEE_BASES.includes(req.body.proposed_fee_basis)) return res.status(400).json({ error: 'Invalid proposed_fee_basis' });
    if (req.body.recommended_action && !RECOMMENDED_ACTIONS.includes(req.body.recommended_action)) return res.status(400).json({ error: 'Invalid recommended_action' });

    try {
        const { data, error } = await supabase.from('practice_pricing_reviews').insert({
            company_id: cid, client_id: clientId, engagement_id: engagementId,
            profitability_review_id: profitability_review_id ? parseInt(profitability_review_id) : null,
            review_title, review_reason,
            current_fee_basis: req.body.current_fee_basis || null, current_fee_amount: req.body.current_fee_amount || null,
            proposed_fee_basis: req.body.proposed_fee_basis || null, proposed_fee_amount: req.body.proposed_fee_amount || null,
            effective_date: req.body.effective_date || null, recommended_action: req.body.recommended_action || null,
            partner_notes: req.body.partner_notes || null, client_discussion_notes: req.body.client_discussion_notes || null,
            internal_notes: req.body.internal_notes || null, assigned_partner_id: req.body.assigned_partner_id || null,
            created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });

        await _writeEvent(cid, data.id, 'review_created', null, data.pricing_status, req.user.userId, review_title, {});

        if (Array.isArray(review_items) && review_items.length) {
            const rows = review_items.filter(i => i.title && ITEM_TYPES.includes(i.item_type)).map((i, idx) => ({
                company_id: cid, pricing_review_id: data.id, item_type: i.item_type, title: i.title,
                description: i.description || null, supporting_value: i.supporting_value || null, sort_order: idx, created_by: req.user.userId,
            }));
            if (rows.length) await supabase.from('practice_pricing_review_items').insert(rows);
        }

        res.status(201).json({ review: data });
    } catch (err) {
        console.error('Pricing-review POST error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    try {
        const review = await _fetchReview(cid, id);
        if (!review) return res.status(404).json({ error: 'Review not found' });
        const { data: items } = await supabase.from('practice_pricing_review_items').select('*').eq('company_id', cid).eq('pricing_review_id', id).order('sort_order');
        res.json({ review, items: items || [] });
    } catch (err) {
        console.error('Pricing-review GET :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (TERMINAL_PRICING_STATUSES.includes(existing.pricing_status)) return res.status(400).json({ error: `Cannot edit a review that is already ${existing.pricing_status}.` });

    const allowed = [
        'review_title', 'review_reason', 'current_fee_basis', 'current_fee_amount', 'proposed_fee_basis', 'proposed_fee_amount',
        'effective_date', 'recommended_action', 'partner_notes', 'client_discussion_notes', 'internal_notes', 'assigned_partner_id',
    ];
    const update = _pick(req.body, allowed);
    if (update.review_reason && !REVIEW_REASONS.includes(update.review_reason)) return res.status(400).json({ error: 'Invalid review_reason' });
    if (update.current_fee_basis && !FEE_BASES.includes(update.current_fee_basis)) return res.status(400).json({ error: 'Invalid current_fee_basis' });
    if (update.proposed_fee_basis && !FEE_BASES.includes(update.proposed_fee_basis)) return res.status(400).json({ error: 'Invalid proposed_fee_basis' });
    if (update.recommended_action && !RECOMMENDED_ACTIONS.includes(update.recommended_action)) return res.status(400).json({ error: 'Invalid recommended_action' });
    update.updated_by = req.user.userId;
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_pricing_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'review_updated', null, null, req.user.userId, null, { fields: Object.keys(update) });
        res.json({ review: data });
    } catch (err) {
        console.error('Pricing-review PUT :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const existing = await _fetchReview(cid, id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    if (TERMINAL_PRICING_STATUSES.includes(existing.pricing_status)) return res.status(400).json({ error: `Review is already ${existing.pricing_status}.` });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to cancel a pricing review.' });

    try {
        const { data, error } = await supabase.from('practice_pricing_reviews')
            .update({ pricing_status: 'cancelled', cancellation_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'cancelled', existing.pricing_status, 'cancelled', req.user.userId, req.body.reason, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Pricing-review DELETE :id error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Workflow Actions ──────────────────────────────────────────────────────────

router.put('/:id/submit', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.pricing_status !== 'draft') return res.status(422).json({ error: `Cannot submit from status "${review.pricing_status}" — must be draft.` });

    try {
        const { data, error } = await supabase.from('practice_pricing_reviews')
            .update({ pricing_status: 'under_review', updated_by: req.user.userId, updated_at: new Date().toISOString() }).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'submitted', 'draft', 'under_review', req.user.userId, req.body.notes || null, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Pricing-review submit error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/partner-review', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.pricing_status !== 'under_review') return res.status(422).json({ error: `Cannot start partner review from status "${review.pricing_status}" — must be under_review.` });

    try {
        const update = { pricing_status: 'partner_review', updated_by: req.user.userId, updated_at: new Date().toISOString() };
        if (req.body.assigned_partner_id) update.assigned_partner_id = req.body.assigned_partner_id;
        const { data, error } = await supabase.from('practice_pricing_reviews').update(update).eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'partner_review_started', 'under_review', 'partner_review', req.user.userId, req.body.notes || null, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Pricing-review partner-review error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.pricing_status !== 'partner_review') return res.status(422).json({ error: `Cannot approve from status "${review.pricing_status}" — must be partner_review.` });

    // Partner approval is expected for a pricing decision, but — matching
    // the established Work Authorization precedent (Codebox 72) — a manager
    // is never silently blocked. An approval by a non-partner is flagged,
    // never rejected outright.
    const partnerUnverified = !_isPartner(member);

    try {
        const { data, error } = await supabase.from('practice_pricing_reviews')
            .update({ pricing_status: 'approved', approved_by: req.user.userId, approved_at: new Date().toISOString(), approval_notes: req.body.notes || null, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'approved', 'partner_review', 'approved', req.user.userId, req.body.notes || null, partnerUnverified ? { partner_approval_unverified: true, approver_role: member.role } : {});
        res.json({ review: data, partner_approval_unverified: partnerUnverified });
    } catch (err) {
        console.error('Pricing-review approve error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/reject', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (!['under_review', 'partner_review'].includes(review.pricing_status)) return res.status(422).json({ error: `Cannot reject from status "${review.pricing_status}".` });
    if (!req.body.reason) return res.status(400).json({ error: 'reason is required to reject a pricing review.' });

    try {
        const { data, error } = await supabase.from('practice_pricing_reviews')
            .update({ pricing_status: 'rejected', rejection_reason: req.body.reason, updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'rejected', review.pricing_status, 'rejected', req.user.userId, req.body.reason, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Pricing-review reject error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/:id/implement', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.pricing_status !== 'approved') return res.status(422).json({ error: `Cannot implement from status "${review.pricing_status}" — must be approved.` });

    try {
        // "Implemented" means the commercial DECISION has been accepted —
        // this NEVER writes to practice_client_engagements. See migration
        // 131's header and module header comment.
        const { data, error } = await supabase.from('practice_pricing_reviews')
            .update({ pricing_status: 'implemented', implemented_by: req.user.userId, implemented_at: new Date().toISOString(), updated_by: req.user.userId, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        await _writeEvent(cid, id, 'implemented', 'approved', 'implemented', req.user.userId, req.body.notes || null, {});
        res.json({ review: data });
    } catch (err) {
        console.error('Pricing-review implement error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// REVIEW ITEMS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/items', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    try {
        const { data, error } = await supabase.from('practice_pricing_review_items').select('*').eq('company_id', cid).eq('pricing_review_id', id).order('sort_order');
        if (error) return res.status(500).json({ error: error.message });
        res.json({ items: data || [] });
    } catch (err) {
        console.error('Pricing-review GET items error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/items', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const review = await _fetchReview(cid, id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (TERMINAL_PRICING_STATUSES.includes(review.pricing_status)) return res.status(400).json({ error: `Cannot add evidence to a review that is already ${review.pricing_status}.` });

    const { item_type, title, description, supporting_value } = req.body;
    if (!ITEM_TYPES.includes(item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    if (!title) return res.status(400).json({ error: 'title is required' });

    try {
        const { count } = await supabase.from('practice_pricing_review_items').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('pricing_review_id', id);
        const { data, error } = await supabase.from('practice_pricing_review_items').insert({
            company_id: cid, pricing_review_id: id, item_type, title, description: description || null,
            supporting_value: supporting_value || null, sort_order: count || 0, created_by: req.user.userId,
        }).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.status(201).json({ item: data });
    } catch (err) {
        console.error('Pricing-review POST item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/items/:itemId', async (req, res) => {
    const cid = req.companyId;
    const itemId = parseInt(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'Invalid item ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: existing } = await supabase.from('practice_pricing_review_items').select('*').eq('id', itemId).eq('company_id', cid).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    const allowed = ['item_type', 'title', 'description', 'supporting_value', 'sort_order'];
    const update = _pick(req.body, allowed);
    if (update.item_type && !ITEM_TYPES.includes(update.item_type)) return res.status(400).json({ error: 'Invalid item_type' });
    update.updated_at = new Date().toISOString();

    try {
        const { data, error } = await supabase.from('practice_pricing_review_items').update(update).eq('id', itemId).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ item: data });
    } catch (err) {
        console.error('Pricing-review PUT item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/items/:itemId', async (req, res) => {
    const cid = req.companyId;
    const itemId = parseInt(req.params.itemId);
    if (!itemId) return res.status(400).json({ error: 'Invalid item ID' });
    const member = await _requireManager(req, res);
    if (!member) return;

    const { data: existing } = await supabase.from('practice_pricing_review_items').select('*').eq('id', itemId).eq('company_id', cid).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    try {
        const { error } = await supabase.from('practice_pricing_review_items').delete().eq('id', itemId).eq('company_id', cid);
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        console.error('Pricing-review DELETE item error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid review ID' });
    try {
        const { data, error } = await supabase.from('practice_pricing_events').select('*').eq('company_id', cid).eq('pricing_review_id', id).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Pricing-review GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules (Engagement Management, Profitability, Client
// Success, Management Dashboard, Planning Board) — see
// docs/new-app/74_pricing_review.md
module.exports.buildPricingReview = buildPricingReview;
