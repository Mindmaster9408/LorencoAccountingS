'use strict';

// Codebox 43 — SARS Statement Reconciliation
// Manual statement-line register and reconciliation against the practice's
// own tax payment ledger.
//
// NOT SARS API. NOT bank feed. NOT automatic import.
// All data is manually entered by practice staff.

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

const TAX_TYPES = ['itr12', 'itr14', 'irp6', 'emp201', 'emp501', 'vat201', 'other'];
const TRANSACTION_TYPES = ['assessment', 'payment', 'refund', 'interest', 'penalty', 'adjustment', 'balance', 'other'];
const RECON_STATUSES = ['unmatched', 'matched', 'partially_matched', 'disputed', 'ignored', 'cancelled'];
const ACTIVE_RECON_STATUSES = ['unmatched', 'partially_matched', 'disputed'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyLine(id, cid) {
    const { data } = await supabase
        .from('practice_sars_statement_lines')
        .select('*')
        .eq('id', id)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _verifyPaymentEvent(eventId, cid) {
    const { data } = await supabase
        .from('practice_tax_payment_events')
        .select('id, payment_id, company_id, event_type, amount, payment_date, balance_before, balance_after')
        .eq('id', eventId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function _writeReconEvent(cid, lineId, eventType, opts) {
    await supabase.from('practice_sars_statement_reconciliation_events').insert({
        company_id:       cid,
        statement_line_id: lineId,
        event_type:       eventType,
        old_status:       opts.old_status || null,
        new_status:       opts.new_status || null,
        actor_user_id:    opts.actor_user_id || null,
        notes:            opts.notes || null,
        metadata:         opts.metadata || {},
    });
}

// ── GET /summary ──────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: lines } = await supabase
            .from('practice_sars_statement_lines')
            .select('reconciliation_status, transaction_type, debit_amount, credit_amount')
            .eq('company_id', cid);

        const { data: events } = await supabase
            .from('practice_tax_payment_events')
            .select('id, event_type')
            .eq('company_id', cid)
            .in('event_type', ['payment_recorded', 'refund_recorded']);

        // Statement line counts by status
        const byStatus = {};
        RECON_STATUSES.forEach(s => { byStatus[s] = 0; });

        let totalDebits   = 0;
        let totalCredits  = 0;
        (lines || []).forEach(l => {
            if (byStatus[l.reconciliation_status] !== undefined) byStatus[l.reconciliation_status]++;
            // Cancelled and ignored lines excluded from variance totals (Patch 44A)
            if (!['cancelled', 'ignored'].includes(l.reconciliation_status)) {
                totalDebits  += Number(l.debit_amount)  || 0;
                totalCredits += Number(l.credit_amount) || 0;
            }
        });

        // Unmatched payment events — events with no statement line yet matched
        const matchedEventIds = new Set(
            (lines || [])
                .filter(l => l.matched_payment_event_id != null)
                .map(l => String(l.matched_payment_event_id))
        );
        const unmatchedEventCount = (events || []).filter(e => !matchedEventIds.has(String(e.id))).length;

        await auditFromReq(req, 'VIEW', 'sars_recon', null, { action: 'summary' });
        res.json({
            by_status:              byStatus,
            total_sars_debits:      _round2(totalDebits),
            total_sars_credits:     _round2(totalCredits),
            variance:               _round2(totalCredits - totalDebits),
            unmatched_line_count:   byStatus.unmatched || 0,
            disputed_line_count:    byStatus.disputed  || 0,
            unmatched_event_count:  unmatchedEventCount,
            total_lines:            (lines || []).length,
        });
    } catch (err) {
        console.error('[sars-recon] summary error:', err);
        res.status(500).json({ error: 'Failed to load reconciliation summary' });
    }
});

// ── GET /lines (list with filters) ────────────────────────────────────────────

router.get('/lines', async (req, res) => {
    const cid = req.companyId;
    try {
        let q = supabase
            .from('practice_sars_statement_lines')
            .select('*', { count: 'exact' })
            .eq('company_id', cid);

        if (req.query.client_id)     q = q.eq('client_id', Number(req.query.client_id));
        if (req.query.submission_id) q = q.eq('submission_id', Number(req.query.submission_id));
        if (req.query.payment_id)    q = q.eq('payment_id', Number(req.query.payment_id));
        if (req.query.tax_type && TAX_TYPES.includes(req.query.tax_type))
            q = q.eq('tax_type', req.query.tax_type);
        if (req.query.transaction_type && TRANSACTION_TYPES.includes(req.query.transaction_type))
            q = q.eq('transaction_type', req.query.transaction_type);
        if (req.query.status && RECON_STATUSES.includes(req.query.status))
            q = q.eq('reconciliation_status', req.query.status);
        if (req.query.date_from)     q = q.gte('statement_date', req.query.date_from);
        if (req.query.date_to)       q = q.lte('statement_date', req.query.date_to);
        if (req.query.search) {
            const s = req.query.search.trim();
            q = q.or(`description.ilike.%${s}%,reference_number.ilike.%${s}%`);
        }

        const { data, count, error } = await q.order('statement_date', { ascending: false });
        if (error) throw error;

        // Patch 44A — enrich rows with client_name via batch lookup
        let lines = data || [];
        if (lines.length) {
            const clientIds = [...new Set(lines.map(l => l.client_id).filter(Boolean))];
            const { data: clients } = await supabase
                .from('practice_clients')
                .select('id, client_name')
                .eq('company_id', cid)
                .in('id', clientIds);
            const nameMap = {};
            (clients || []).forEach(c => { nameMap[c.id] = c.client_name; });
            lines = lines.map(l => ({ ...l, client_name: nameMap[l.client_id] || null }));
        }

        await auditFromReq(req, 'VIEW', 'sars_recon', null, { action: 'list', count: lines.length });
        res.json({ lines, total: count || 0 });
    } catch (err) {
        console.error('[sars-recon] list error:', err);
        res.status(500).json({ error: 'Failed to load statement lines' });
    }
});

// ── POST /lines (create a statement line) ────────────────────────────────────

router.post('/lines', async (req, res) => {
    const cid = req.companyId;
    const {
        client_id, submission_id, payment_id, statement_date, tax_type, tax_year, period_label,
        transaction_type, description, reference_number, debit_amount, credit_amount,
        running_balance, notes, internal_notes,
    } = req.body;

    if (!client_id || isNaN(Number(client_id))) return res.status(400).json({ error: 'client_id is required' });
    if (!statement_date) return res.status(400).json({ error: 'statement_date is required' });
    if (!TAX_TYPES.includes(tax_type)) return res.status(400).json({ error: `Invalid tax_type. Allowed: ${TAX_TYPES.join(', ')}` });
    if (!TRANSACTION_TYPES.includes(transaction_type)) return res.status(400).json({ error: `Invalid transaction_type. Allowed: ${TRANSACTION_TYPES.join(', ')}` });

    const debit  = debit_amount  != null ? _round2(debit_amount)  : 0;
    const credit = credit_amount != null ? _round2(credit_amount) : 0;
    if (debit < 0 || credit < 0) return res.status(400).json({ error: 'debit_amount and credit_amount must be zero or positive' });

    try {
        // Verify client_id belongs to this company
        const { data: client } = await supabase
            .from('practice_clients')
            .select('id')
            .eq('id', Number(client_id))
            .eq('company_id', cid)
            .single();
        if (!client) return res.status(404).json({ error: 'Client not found or access denied' });

        // Optionally verify submission and payment belong to this company
        if (submission_id) {
            const { data: sub } = await supabase
                .from('practice_tax_submissions')
                .select('id')
                .eq('id', Number(submission_id))
                .eq('company_id', cid)
                .single();
            if (!sub) return res.status(404).json({ error: 'Submission not found or access denied' });
        }
        if (payment_id) {
            const { data: pay } = await supabase
                .from('practice_tax_payments')
                .select('id')
                .eq('id', Number(payment_id))
                .eq('company_id', cid)
                .single();
            if (!pay) return res.status(404).json({ error: 'Payment case not found or access denied' });
        }

        const row = {
            company_id:           cid,
            client_id:            Number(client_id),
            submission_id:        submission_id ? Number(submission_id) : null,
            payment_id:           payment_id   ? Number(payment_id)   : null,
            statement_date,
            tax_type,
            tax_year:             tax_year   ? Number(tax_year)   : null,
            period_label:         period_label || null,
            transaction_type,
            description:          description || null,
            reference_number:     reference_number || null,
            debit_amount:         debit,
            credit_amount:        credit,
            running_balance:      running_balance != null ? _round2(running_balance) : null,
            reconciliation_status: 'unmatched',
            notes:                notes || null,
            internal_notes:       internal_notes || null,
            created_by:           req.userId || null,
        };

        const { data: created, error: insertErr } = await supabase
            .from('practice_sars_statement_lines')
            .insert(row)
            .select('*')
            .single();
        if (insertErr) throw insertErr;

        await _writeReconEvent(cid, created.id, 'sars_statement_line_created', {
            new_status: 'unmatched', actor_user_id: req.userId,
            notes: `Statement line created. ${tax_type} / ${transaction_type}`,
        });
        await auditFromReq(req, 'CREATE', 'sars_recon', created.id, { tax_type, transaction_type });
        res.status(201).json({ ok: true, line: created });
    } catch (err) {
        console.error('[sars-recon] create error:', err);
        res.status(500).json({ error: 'Failed to create statement line' });
    }
});

// ── GET /lines/:id ────────────────────────────────────────────────────────────

router.get('/lines/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });

        await auditFromReq(req, 'VIEW', 'sars_recon', id, {});
        res.json({ line });
    } catch (err) {
        console.error('[sars-recon] get error:', err);
        res.status(500).json({ error: 'Failed to load statement line' });
    }
});

// ── PUT /lines/:id (update non-status fields) ─────────────────────────────────

router.put('/lines/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });
        if (line.reconciliation_status === 'cancelled') return res.status(422).json({ error: 'Cannot update a cancelled statement line' });

        const allowed = ['statement_date', 'tax_type', 'tax_year', 'period_label', 'transaction_type',
            'description', 'reference_number', 'debit_amount', 'credit_amount',
            'running_balance', 'submission_id', 'payment_id', 'notes', 'internal_notes'];
        const updates = _pick(req.body, allowed);
        if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' });

        if (updates.tax_type && !TAX_TYPES.includes(updates.tax_type))
            return res.status(400).json({ error: 'Invalid tax_type' });
        if (updates.transaction_type && !TRANSACTION_TYPES.includes(updates.transaction_type))
            return res.status(400).json({ error: 'Invalid transaction_type' });
        if (updates.debit_amount  != null) updates.debit_amount  = _round2(updates.debit_amount);
        if (updates.credit_amount != null) updates.credit_amount = _round2(updates.credit_amount);
        if (updates.running_balance != null) updates.running_balance = _round2(updates.running_balance);
        updates.updated_by = req.userId || null;

        const { data: updated, error: updateErr } = await supabase
            .from('practice_sars_statement_lines')
            .update(updates)
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await _writeReconEvent(cid, id, 'sars_statement_line_updated', {
            old_status: line.reconciliation_status,
            new_status: updated.reconciliation_status,
            actor_user_id: req.userId,
            notes: `Fields updated: ${Object.keys(updates).filter(k => k !== 'updated_by').join(', ')}`,
        });
        await auditFromReq(req, 'UPDATE', 'sars_recon', id, { fields: Object.keys(updates) });
        res.json({ ok: true, line: updated });
    } catch (err) {
        console.error('[sars-recon] update error:', err);
        res.status(500).json({ error: 'Failed to update statement line' });
    }
});

// ── DELETE /lines/:id (soft cancel only) ──────────────────────────────────────

router.delete('/lines/:id', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });
        if (line.reconciliation_status === 'cancelled') return res.status(422).json({ error: 'Statement line is already cancelled' });
        if (line.reconciliation_status === 'matched') {
            return res.status(422).json({ error: 'Unmatch this line from its payment event before cancelling.' });
        }

        const { error: updateErr } = await supabase
            .from('practice_sars_statement_lines')
            .update({ reconciliation_status: 'cancelled', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid);
        if (updateErr) throw updateErr;

        await _writeReconEvent(cid, id, 'sars_statement_line_cancelled', {
            old_status: line.reconciliation_status,
            new_status: 'cancelled',
            actor_user_id: req.userId,
            notes: req.body.notes || null,
        });
        await auditFromReq(req, 'sars_statement_line_cancelled', 'sars_recon', id, { old_status: line.reconciliation_status });
        res.json({ ok: true, id, status: 'cancelled' });
    } catch (err) {
        console.error('[sars-recon] cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel statement line' });
    }
});

// ── POST /lines/:id/match-payment-event ───────────────────────────────────────

router.post('/lines/:id/match-payment-event', async (req, res) => {
    const cid     = req.companyId;
    const id      = Number(req.params.id);
    const { payment_event_id, notes } = req.body;

    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const eventId = Number(payment_event_id);
    if (!eventId || isNaN(eventId)) return res.status(400).json({ error: 'payment_event_id is required' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });
        if (line.reconciliation_status === 'cancelled') return res.status(422).json({ error: 'Cannot match a cancelled statement line' });

        const event = await _verifyPaymentEvent(eventId, cid);
        if (!event) return res.status(404).json({ error: 'Payment event not found or access denied' });

        // Direction coherence check:
        // SARS credit → expect refund_recorded or similar
        // SARS debit  → expect payment_recorded
        // This is advisory only; we allow overrides with notes, not a hard block.
        const coherenceWarning = [];
        const debit  = Number(line.debit_amount);
        const credit = Number(line.credit_amount);
        if (debit > 0 && event.event_type === 'refund_recorded') {
            coherenceWarning.push('Statement line is a debit (you owe SARS) but matched to a refund event — please verify this is intentional.');
        }
        if (credit > 0 && event.event_type === 'payment_recorded') {
            coherenceWarning.push('Statement line is a credit (SARS owes you) but matched to a payment event — please verify this is intentional.');
        }
        if (coherenceWarning.length > 0 && !notes) {
            return res.status(422).json({
                error: 'Amount direction mismatch between statement line and payment event. Add notes to confirm this is intentional.',
                warnings: coherenceWarning,
                code: 'DIRECTION_MISMATCH',
            });
        }

        const now = new Date().toISOString();
        const { data: updated, error: updateErr } = await supabase
            .from('practice_sars_statement_lines')
            .update({
                reconciliation_status:   'matched',
                matched_payment_event_id: eventId,
                matched_at:              now,
                matched_by:              req.userId || null,
                updated_by:              req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await _writeReconEvent(cid, id, 'sars_statement_line_matched', {
            old_status: line.reconciliation_status,
            new_status: 'matched',
            actor_user_id: req.userId,
            notes: notes || null,
            metadata: { payment_event_id: eventId, warnings: coherenceWarning },
        });
        await auditFromReq(req, 'sars_statement_line_matched', 'sars_recon', id, { payment_event_id: eventId });
        res.json({ ok: true, line: updated, warnings: coherenceWarning });
    } catch (err) {
        console.error('[sars-recon] match error:', err);
        res.status(500).json({ error: 'Failed to match statement line' });
    }
});

// ── POST /lines/:id/unmatch ────────────────────────────────────────────────────

router.post('/lines/:id/unmatch', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });
        if (!['matched', 'partially_matched'].includes(line.reconciliation_status)) {
            return res.status(422).json({ error: 'Statement line is not currently matched' });
        }

        const { data: updated, error: updateErr } = await supabase
            .from('practice_sars_statement_lines')
            .update({
                reconciliation_status:    'unmatched',
                matched_payment_event_id: null,
                matched_at:               null,
                matched_by:               null,
                updated_by:               req.userId || null,
            })
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await _writeReconEvent(cid, id, 'sars_statement_line_unmatched', {
            old_status: line.reconciliation_status,
            new_status: 'unmatched',
            actor_user_id: req.userId,
            notes: req.body.notes || null,
            metadata: { previously_matched_event_id: line.matched_payment_event_id },
        });
        await auditFromReq(req, 'sars_statement_line_unmatched', 'sars_recon', id, {});
        res.json({ ok: true, line: updated });
    } catch (err) {
        console.error('[sars-recon] unmatch error:', err);
        res.status(500).json({ error: 'Failed to unmatch statement line' });
    }
});

// ── POST /lines/:id/dispute ────────────────────────────────────────────────────

router.post('/lines/:id/dispute', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    if (!req.body.notes || !req.body.notes.trim()) {
        return res.status(400).json({ error: 'notes is required when disputing a line — describe the reason for the dispute' });
    }

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });
        if (line.reconciliation_status === 'cancelled') return res.status(422).json({ error: 'Cannot dispute a cancelled statement line' });

        const { data: updated, error: updateErr } = await supabase
            .from('practice_sars_statement_lines')
            .update({ reconciliation_status: 'disputed', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await _writeReconEvent(cid, id, 'sars_statement_line_disputed', {
            old_status: line.reconciliation_status,
            new_status: 'disputed',
            actor_user_id: req.userId,
            notes: req.body.notes.trim(),
        });
        await auditFromReq(req, 'sars_statement_line_disputed', 'sars_recon', id, { notes: req.body.notes.trim() });
        res.json({ ok: true, line: updated });
    } catch (err) {
        console.error('[sars-recon] dispute error:', err);
        res.status(500).json({ error: 'Failed to mark statement line as disputed' });
    }
});

// ── POST /lines/:id/ignore ────────────────────────────────────────────────────

router.post('/lines/:id/ignore', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });
        if (line.reconciliation_status === 'cancelled') return res.status(422).json({ error: 'Cannot ignore a cancelled statement line' });
        if (line.reconciliation_status === 'matched') return res.status(422).json({ error: 'Unmatch this line before ignoring it' });

        const { data: updated, error: updateErr } = await supabase
            .from('practice_sars_statement_lines')
            .update({ reconciliation_status: 'ignored', updated_by: req.userId || null })
            .eq('id', id)
            .eq('company_id', cid)
            .select('*')
            .single();
        if (updateErr) throw updateErr;

        await _writeReconEvent(cid, id, 'sars_statement_line_ignored', {
            old_status: line.reconciliation_status,
            new_status: 'ignored',
            actor_user_id: req.userId,
            notes: req.body.notes || null,
        });
        await auditFromReq(req, 'sars_statement_line_ignored', 'sars_recon', id, {});
        res.json({ ok: true, line: updated });
    } catch (err) {
        console.error('[sars-recon] ignore error:', err);
        res.status(500).json({ error: 'Failed to mark statement line as ignored' });
    }
});

// ── GET /lines/:id/events ─────────────────────────────────────────────────────

router.get('/lines/:id/events', async (req, res) => {
    const cid = req.companyId;
    const id  = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
        const line = await _verifyLine(id, cid);
        if (!line) return res.status(404).json({ error: 'Statement line not found or access denied' });

        const { data, error } = await supabase
            .from('practice_sars_statement_reconciliation_events')
            .select('id, event_type, old_status, new_status, actor_user_id, notes, metadata, created_at')
            .eq('statement_line_id', id)
            .eq('company_id', cid)
            .order('created_at', { ascending: false });
        if (error) throw error;

        res.json({ events: data || [] });
    } catch (err) {
        console.error('[sars-recon] get-events error:', err);
        res.status(500).json({ error: 'Failed to load events' });
    }
});

// ── GET /payment-events/unmatched ─────────────────────────────────────────────
// Returns payment ledger events (payment_recorded, refund_recorded) that have
// not yet been matched to any SARS statement line.

router.get('/payment-events/unmatched', async (req, res) => {
    const cid = req.companyId;
    try {
        // All payment events of matchable types for this company
        const { data: events, error: evErr } = await supabase
            .from('practice_tax_payment_events')
            .select('id, payment_id, event_type, amount, payment_date, payment_method, reference, balance_before, balance_after, notes, created_at')
            .eq('company_id', cid)
            .in('event_type', ['payment_recorded', 'refund_recorded'])
            .order('payment_date', { ascending: false });
        if (evErr) throw evErr;

        // IDs already matched to a statement line
        const { data: matched } = await supabase
            .from('practice_sars_statement_lines')
            .select('matched_payment_event_id')
            .eq('company_id', cid)
            .not('matched_payment_event_id', 'is', null);

        const matchedIds = new Set((matched || []).map(r => r.matched_payment_event_id));
        const unmatched  = (events || []).filter(e => !matchedIds.has(e.id));

        res.json({ events: unmatched, total: unmatched.length });
    } catch (err) {
        console.error('[sars-recon] unmatched-events error:', err);
        res.status(500).json({ error: 'Failed to load unmatched payment events' });
    }
});

module.exports = router;
