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
// NOTE: This module is a MANUAL payment register only.
// No SARS API. No bank reconciliation. No automatic payment importing.

const DIRECTIONS       = ['payable', 'refundable'];
const PAYMENT_STATUSES = ['outstanding','partially_paid','paid_in_full','overpaid','refund_pending','refund_received','cancelled'];
const PAYMENT_METHODS  = ['eft','debit_order','cash','cheque','sars_efiling','other'];
const ACTIVE_STATUSES  = ['outstanding','partially_paid','refund_pending'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function _recalcBalance(row) {
    if (row.direction === 'payable') {
        return _round2(Number(row.original_amount) + Number(row.interest_accrued) + Number(row.penalty_accrued) - Number(row.amount_settled));
    }
    return _round2(Number(row.original_amount) - Number(row.amount_settled));
}

function _deriveStatus(row, balance) {
    if (row.status === 'cancelled') return 'cancelled';
    if (row.direction === 'refundable') {
        if (balance <= 0) return 'refund_received';
        if (Number(row.amount_settled) > 0) return 'refund_pending';
        return 'refund_pending';
    }
    if (balance < 0) return 'overpaid';
    if (balance === 0) return 'paid_in_full';
    if (Number(row.amount_settled) > 0) return 'partially_paid';
    return 'outstanding';
}

async function _verifyPayment(id, cid) {
    const { data } = await supabase
        .from('practice_tax_payments')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _verifySubmission(submissionId, cid) {
    const { data } = await supabase
        .from('practice_tax_submissions')
        .select('id, company_id, client_id, tax_year, submission_status, amount_payable, refund_amount, payment_due_date')
        .eq('id', submissionId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _writeEvent(cid, paymentId, eventType, fields) {
    await supabase.from('practice_tax_payment_events').insert({
        company_id:     cid,
        payment_id:     paymentId,
        event_type:     eventType,
        amount:         fields.amount != null ? fields.amount : null,
        payment_date:   fields.payment_date || null,
        payment_method: fields.payment_method || null,
        reference:      fields.reference || null,
        balance_before: fields.balance_before != null ? fields.balance_before : null,
        balance_after:  fields.balance_after != null ? fields.balance_after : null,
        actor_user_id:  fields.actor_user_id || null,
        notes:          fields.notes || null,
        metadata:       fields.metadata || {},
    });
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

function _validAmount(v) {
    return v !== undefined && v !== null && v !== '' && !isNaN(Number(v)) && Number(v) > 0;
}

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: all } = await supabase
            .from('practice_tax_payments')
            .select('direction, status, balance_outstanding, due_date')
            .eq('company_id', cid);

        const today = new Date().toISOString().split('T')[0];
        const counts = {};
        PAYMENT_STATUSES.forEach(s => { counts[s] = 0; });

        let totalOutstandingPayable    = 0;
        let totalPendingRefund         = 0;
        let overdueCount               = 0;

        (all || []).forEach(r => {
            if (counts[r.status] !== undefined) counts[r.status]++;
            const active = ACTIVE_STATUSES.includes(r.status);
            if (active && r.direction === 'payable')    totalOutstandingPayable += Number(r.balance_outstanding) || 0;
            if (active && r.direction === 'refundable') totalPendingRefund      += Number(r.balance_outstanding) || 0;
            if (active && r.due_date && r.due_date < today) overdueCount++;
        });

        await auditFromReq(req, 'VIEW', 'tax_payment', null, { action: 'summary' });
        res.json({
            by_status: counts,
            total_outstanding_payable: _round2(totalOutstandingPayable),
            total_pending_refund:      _round2(totalPendingRefund),
            overdue_count:             overdueCount,
            total:                     (all || []).length,
        });
    } catch (err) {
        console.error('[tax-payments] summary error:', err);
        res.status(500).json({ error: 'Failed to load payment summary' });
    }
});

// ── GET / (list with filters) ─────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const cid = req.companyId;
    try {
        let q = supabase
            .from('practice_tax_payments')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (req.query.client_id)     q = q.eq('client_id', Number(req.query.client_id));
        if (req.query.submission_id) q = q.eq('submission_id', Number(req.query.submission_id));
        if (req.query.tax_year)      q = q.eq('tax_year', Number(req.query.tax_year));
        if (req.query.direction && DIRECTIONS.includes(req.query.direction)) q = q.eq('direction', req.query.direction);
        if (req.query.status && PAYMENT_STATUSES.includes(req.query.status)) q = q.eq('status', req.query.status);

        const { data, count, error } = await q.order('updated_at', { ascending: false });
        if (error) throw error;

        await auditFromReq(req, 'VIEW', 'tax_payment', null, { action: 'list', count: data ? data.length : 0 });
        res.json({ payments: data || [], total: count || 0 });
    } catch (err) {
        console.error('[tax-payments] list error:', err);
        res.status(500).json({ error: 'Failed to load payments' });
    }
});

// ── POST / (create a payment case from a submission) ──────────────────────────

router.post('/', async (req, res) => {
    const cid = req.companyId;
    const { submission_id, direction, original_amount, due_date, notes, internal_notes } = req.body;

    const sid = Number(submission_id);
    if (!sid || isNaN(sid)) return res.status(400).json({ error: 'submission_id is required' });
    if (!DIRECTIONS.includes(direction)) return res.status(400).json({ error: `Invalid direction. Allowed: ${DIRECTIONS.join(', ')}` });
    if (!_validAmount(original_amount)) return res.status(400).json({ error: 'original_amount must be a positive number' });

    try {
        const sub = await _verifySubmission(sid, cid);
        if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });

        // Duplicate guard (Codebox 43 Patch 43A):
        // Prevent creating a second active case for the same submission+direction.
        const { data: existing409 } = await supabase
            .from('practice_tax_payments')
            .select('id')
            .eq('company_id', cid)
            .eq('submission_id', sid)
            .eq('direction', direction)
            .neq('status', 'cancelled')
            .limit(1)
            .maybeSingle();
        if (existing409) {
            return res.status(409).json({
                error: `An active ${direction} payment case already exists for this submission.`,
                code: 'DUPLICATE_PAYMENT_CASE',
                existing_payment_id: existing409.id,
            });
        }

        const row = {
            company_id:          cid,
            client_id:           sub.client_id,
            submission_id:       sid,
            tax_year:            sub.tax_year || null,
            direction,
            original_amount:     _round2(original_amount),
            interest_accrued:    0,
            penalty_accrued:     0,
            amount_settled:      0,
            balance_outstanding: _round2(original_amount),
            status:              direction === 'payable' ? 'outstanding' : 'refund_pending',
            due_date:            due_date || sub.payment_due_date || null,
            notes:               notes || null,
            internal_notes:      internal_notes || null,
            created_by:          req.userId || null,
        };

        const { data: created, error: insertErr } = await supabase
            .from('practice_tax_payments')
            .insert(row)
            .select('*')
            .single();
        if (insertErr) throw insertErr;

        await _writeEvent(cid, created.id, 'payment_created', {
            amount: row.original_amount, balance_before: 0, balance_after: row.balance_outstanding,
            actor_user_id: req.userId, notes: 'Payment case created from submission #' + sid,
        });
        await auditFromReq(req, 'CREATE', 'tax_payment', created.id, { submission_id: sid, direction });
        res.status(201).json({ ok: true, payment: created });
    } catch (err) {
        console.error('[tax-payments] create error:', err);
        res.status(500).json({ error: 'Failed to create payment case' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const payment = await _verifyPayment(id, cid);
        if (!payment) return res.status(404).json({ error: 'Payment case not found or access denied' });

        await auditFromReq(req, 'VIEW', 'tax_payment', id, {});
        res.json(payment);
    } catch (err) {
        console.error('[tax-payments] get error:', err);
        res.status(500).json({ error: 'Failed to load payment case' });
    }
});

// ── PUT /:id (general update — non-financial fields only) ────────────────────

router.put('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const payment = await _verifyPayment(id, cid);
        if (!payment) return res.status(404).json({ error: 'Payment case not found or access denied' });
        if (payment.status === 'cancelled') return res.status(422).json({ error: 'Cannot update a cancelled payment case' });

        const allowed = ['due_date', 'notes', 'internal_notes'];
        const updates = _pick(req.body, allowed);
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' });
        updates.updated_by = req.userId || null;

        const { data: updated, error: updateErr } = await supabase
            .from('practice_tax_payments')
            .update(updates)
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await auditFromReq(req, 'UPDATE', 'tax_payment', id, { fields: Object.keys(updates) });
        res.json({ ok: true, payment: updated });
    } catch (err) {
        console.error('[tax-payments] update error:', err);
        res.status(500).json({ error: 'Failed to update payment case' });
    }
});

// ── DELETE /:id (soft cancel only) ────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const payment = await _verifyPayment(id, cid);
        if (!payment) return res.status(404).json({ error: 'Payment case not found or access denied' });
        if (payment.status === 'cancelled')      return res.status(422).json({ error: 'Payment case is already cancelled' });
        if (Number(payment.amount_settled) > 0)  return res.status(422).json({ error: 'Cannot cancel a payment case that already has recorded payments/refunds. Reverse those manually first.' });

        const { error: updateErr } = await supabase
            .from('practice_tax_payments')
            .update({ status: 'cancelled', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, 'payment_cancelled', {
            balance_before: payment.balance_outstanding, balance_after: payment.balance_outstanding,
            actor_user_id: req.userId, notes: req.body.notes || null,
        });
        await auditFromReq(req, 'tax_payment_cancelled', 'tax_payment', id, { old_status: payment.status });
        res.json({ ok: true, id, status: 'cancelled' });
    } catch (err) {
        console.error('[tax-payments] cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel payment case' });
    }
});

// ── Shared handler for the four ledger-movement actions ───────────────────────

async function _applyLedgerMovement(req, res, { eventType, field, allowedDirections, statusOverride }) {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { amount, payment_date, payment_method, reference, notes } = req.body;
    if (!_validAmount(amount)) return res.status(400).json({ error: 'amount must be a positive number' });
    if ((eventType === 'payment_recorded' || eventType === 'refund_recorded')) {
        if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
        if (payment_method && !PAYMENT_METHODS.includes(payment_method)) {
            return res.status(400).json({ error: `Invalid payment_method. Allowed: ${PAYMENT_METHODS.join(', ')}` });
        }
    }

    try {
        const payment = await _verifyPayment(id, cid);
        if (!payment) return res.status(404).json({ error: 'Payment case not found or access denied' });
        if (payment.status === 'cancelled') return res.status(422).json({ error: 'Cannot record movements on a cancelled payment case' });
        if (allowedDirections && !allowedDirections.includes(payment.direction)) {
            return res.status(422).json({ error: `This action is not valid for a '${payment.direction}' payment case` });
        }

        const balanceBefore = Number(payment.balance_outstanding);
        const next = { ...payment, [field]: _round2(Number(payment[field]) + Number(amount)) };
        const balanceAfter = _recalcBalance(next);
        const newStatus = statusOverride ? statusOverride(next, balanceAfter) : _deriveStatus(next, balanceAfter);

        const { data: updated, error: updateErr } = await supabase
            .from('practice_tax_payments')
            .update({
                [field]:             next[field],
                balance_outstanding: balanceAfter,
                status:              newStatus,
                updated_by:          req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await _writeEvent(cid, id, eventType, {
            amount: _round2(amount), payment_date: payment_date || null, payment_method: payment_method || null,
            reference: reference || null, balance_before: balanceBefore, balance_after: balanceAfter,
            actor_user_id: req.userId, notes: notes || null,
        });
        await auditFromReq(req, eventType, 'tax_payment', id, { amount: _round2(amount), new_status: newStatus });
        res.json({ ok: true, payment: updated });
    } catch (err) {
        console.error(`[tax-payments] ${eventType} error:`, err);
        res.status(500).json({ error: 'Failed to record movement' });
    }
}

// ── PUT /:id/record-payment ───────────────────────────────────────────────────

router.put('/:id/record-payment', (req, res) => _applyLedgerMovement(req, res, {
    eventType: 'payment_recorded', field: 'amount_settled', allowedDirections: ['payable'],
}));

// ── PUT /:id/record-refund ────────────────────────────────────────────────────

router.put('/:id/record-refund', (req, res) => _applyLedgerMovement(req, res, {
    eventType: 'refund_recorded', field: 'amount_settled', allowedDirections: ['refundable'],
}));

// ── PUT /:id/add-interest ─────────────────────────────────────────────────────

router.put('/:id/add-interest', (req, res) => _applyLedgerMovement(req, res, {
    eventType: 'interest_added', field: 'interest_accrued', allowedDirections: ['payable'],
}));

// ── PUT /:id/add-penalty ──────────────────────────────────────────────────────

router.put('/:id/add-penalty', (req, res) => _applyLedgerMovement(req, res, {
    eventType: 'penalty_added', field: 'penalty_accrued', allowedDirections: ['payable'],
}));

// ── GET /:id/events ────────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const payment = await _verifyPayment(id, cid);
        if (!payment) return res.status(404).json({ error: 'Payment case not found or access denied' });

        const { data, error } = await supabase
            .from('practice_tax_payment_events')
            .select('id, event_type, amount, payment_date, payment_method, reference, balance_before, balance_after, actor_user_id, notes, metadata, created_at')
            .eq('payment_id', id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        res.json({ events: data || [] });
    } catch (err) {
        console.error('[tax-payments] get-events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

module.exports = router;
