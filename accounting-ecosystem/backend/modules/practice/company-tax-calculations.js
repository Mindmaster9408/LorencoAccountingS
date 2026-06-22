/* =============================================================
   Practice Company Tax — Draft Calculation Engine  (Codebox 32)

   DRAFT / REVIEW ONLY. NOT SARS-final.
   NOT ITR14 submission. NOT eFiling integration. NOT tax advice.
   All output requires accountant review before use.
   Clearly marked DRAFT ESTIMATE on every calculation.

   Mounted ADDITIONALLY at /api/practice/company-tax (fallthrough after company-tax.js).
   Routes in this file (specific before generic):
     GET  /calculations/:id/events       ← registered first
     POST /calculations/:id/submit-review
     POST /calculations/:id/approve
     POST /calculations/:id/reject
     GET  /calculations/:id
     PUT  /calculations/:id
     GET  /:returnId/calculations
     POST /:returnId/calculations/run-draft
   ============================================================= */
'use strict';

const express  = require('express');
const router   = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

// ─── Constants ────────────────────────────────────────────────────────────────

const CALC_STATUSES = [
    'draft','ready_for_review','reviewed','approved','rejected','cancelled',
];

// Flat company tax rate placeholder — 27% is the standard SA company rate.
// MUST be reviewed against SARS published rate for the specific tax year.
// This is a safe default for the draft estimate engine only.
const CT_RATE_PLACEHOLDER = 0.27;
const CT_RATE_VERSION      = 'PLACEHOLDER_27PCT';

// Adjustment types that add to taxable income (positive adjustments)
const ADD_BACK_TYPES    = ['add_back'];
const DISALLOW_TYPES    = ['disallowance'];

// Adjustment types that reduce taxable income (negative adjustments)
const DEDUCTION_TYPES   = ['deduction'];
const ALLOWANCE_TYPES   = ['allowance', 'capital_allowance', 'section_24c', 'doubtful_debt', 'donation'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n) {
    return Math.round((n || 0) * 100) / 100;
}

async function verifyReturnBelongsToCompany(cid, returnId) {
    if (!returnId) return null;
    const { data } = await supabase
        .from('practice_company_tax_returns')
        .select('*')
        .eq('id', parseInt(returnId))
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifyCalcBelongsToCompany(cid, calcId) {
    if (!calcId) return null;
    const { data } = await supabase
        .from('practice_company_tax_calculations')
        .select('*')
        .eq('id', parseInt(calcId))
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function logCalcEvent(cid, calcId, returnId, eventType, extras = {}) {
    try {
        await supabase.from('practice_company_tax_calculation_events').insert({
            company_id:             cid,
            calculation_id:         calcId,
            company_tax_return_id:  returnId,
            event_type:             eventType,
            old_status:             extras.old_status    || null,
            new_status:             extras.new_status    || null,
            actor_user_id:          extras.actor_user_id || null,
            notes:                  extras.notes         || null,
            metadata:               extras.metadata      || {},
        });
    } catch (_) { /* non-fatal */ }
}

// ─── Core Calculation Logic ───────────────────────────────────────────────────

async function runCompanyTaxDraftCalc(cid, taxReturn) {
    const returnId = taxReturn.id;
    const taxYear  = taxReturn.tax_year;

    // ── Input: accounting profit from AFS capture ──────────────────────────────
    const profit   = round2(taxReturn.accounting_profit_loss || 0);
    const alBf     = round2(taxReturn.assessed_loss_brought_forward || 0);
    const alUtilised = round2(taxReturn.assessed_loss_utilised || 0);

    // ── Input: fetch adjustments from DB (never trust frontend totals) ─────────
    const { data: adjRows } = await supabase
        .from('practice_company_tax_adjustments')
        .select('adjustment_type, amount, description')
        .eq('company_tax_return_id', returnId)
        .eq('company_id', cid);

    const adjustments = adjRows || [];
    const adjCount = adjustments.length;

    let add_back_total    = 0;
    let disallowance_total = 0;
    let deduction_total   = 0;
    let allowance_total   = 0;

    adjustments.forEach(function (adj) {
        const amount = round2(adj.amount || 0);
        if (ADD_BACK_TYPES.includes(adj.adjustment_type))  add_back_total    += amount;
        else if (DISALLOW_TYPES.includes(adj.adjustment_type)) disallowance_total += amount;
        else if (DEDUCTION_TYPES.includes(adj.adjustment_type)) deduction_total   += amount;
        else if (ALLOWANCE_TYPES.includes(adj.adjustment_type)) allowance_total   += amount;
        // 'assessed_loss' and 'other' types: not summed — handled via AFS fields
    });

    add_back_total    = round2(add_back_total);
    disallowance_total = round2(disallowance_total);
    deduction_total   = round2(deduction_total);
    allowance_total   = round2(allowance_total);

    // ── Taxable income computation ─────────────────────────────────────────────
    // profit + add_backs + disallowances - deductions - allowances - assessed_loss
    const taxable_pre_loss = round2(profit + add_back_total + disallowance_total - deduction_total - allowance_total);
    const floored = taxable_pre_loss - alUtilised < 0;
    const taxable_income_estimate = Math.max(0, round2(taxable_pre_loss - alUtilised));

    // ── Company tax rate — placeholder only ────────────────────────────────────
    // No bracket table exists for company tax (flat rate).
    // MUST be reviewed against SARS published rate for the tax year.
    const company_tax_rate   = CT_RATE_PLACEHOLDER;
    const normal_tax_estimate = round2(taxable_income_estimate * company_tax_rate);

    // ── Provisional tax offset — safe DB lookup ────────────────────────────────
    let provisional_tax_paid  = null;
    let provSource            = null;
    let provWarning           = true;

    if (taxReturn.related_provisional_tax_plan_id) {
        try {
            const { data: planRow } = await supabase
                .from('practice_provisional_tax_plans')
                .select('id, status')
                .eq('id', taxReturn.related_provisional_tax_plan_id)
                .eq('company_id', cid)
                .single();

            if (planRow) {
                const { data: periods } = await supabase
                    .from('practice_provisional_tax_periods')
                    .select('period_type, amount_submitted, amount_paid, status')
                    .eq('plan_id', planRow.id)
                    .eq('company_id', cid)
                    .in('status', ['submitted', 'paid']);

                if (periods && periods.length > 0) {
                    let sum = 0;
                    periods.forEach(function (p) {
                        // Prefer amount_paid; fall back to amount_submitted
                        const paidAmt = parseFloat(p.amount_paid || p.amount_submitted || 0);
                        sum += paidAmt;
                    });
                    provisional_tax_paid = round2(sum);
                    provSource  = 'provisional_tax_plan_id_' + planRow.id;
                    provWarning = false;
                }
            }
        } catch (_) {
            // Non-fatal — leave provisional_tax_paid null, warn below
        }
    }

    // ── Estimated payable / refund ─────────────────────────────────────────────
    let estimated_tax_payable = null;
    let estimated_refund      = null;

    if (provisional_tax_paid !== null) {
        const diff = round2(normal_tax_estimate - provisional_tax_paid);
        if (diff >= 0) {
            estimated_tax_payable = diff;
            estimated_refund      = 0;
        } else {
            estimated_tax_payable = 0;
            estimated_refund      = Math.abs(diff);
        }
    }

    // ── Build warning flags ────────────────────────────────────────────────────
    const warnings = ['DRAFT_COMPANY_TAX_REVIEW_REQUIRED', 'COMPANY_TAX_RATE_REQUIRES_REVIEW'];

    if (!taxReturn.accounting_profit_loss && taxReturn.accounting_profit_loss !== 0) {
        warnings.push('MISSING_ACCOUNTING_PROFIT');
    }
    if (adjCount === 0) {
        warnings.push('NO_TAX_ADJUSTMENTS_CAPTURED');
    }
    if (alBf > 0 || alUtilised > 0) {
        warnings.push('ASSESSED_LOSS_REQUIRES_REVIEW');
    }
    if (alBf > 0 && alUtilised > alBf) {
        warnings.push('ASSESSED_LOSS_UTILISED_EXCEEDS_AVAILABLE');
    }
    if (floored) {
        warnings.push('TAXABLE_INCOME_FLOORED_AT_ZERO');
    }
    if (provWarning) {
        warnings.push('PROVISIONAL_TAX_OFFSET_NOT_LINKED');
    }

    // ── Build calculation lines ────────────────────────────────────────────────
    const lines = [];
    lines.push({
        label: 'Accounting Profit / (Loss)',
        amount: profit,
        note: 'From AFS Inputs capture. Verify against signed AFS.',
    });
    lines.push({
        label: 'Add: Add-back Adjustments',
        amount: add_back_total,
        note: adjustments.filter(function(a){ return ADD_BACK_TYPES.includes(a.adjustment_type); }).length + ' add-back adjustment(s) summed.',
    });
    lines.push({
        label: 'Add: Disallowances',
        amount: disallowance_total,
        note: adjustments.filter(function(a){ return DISALLOW_TYPES.includes(a.adjustment_type); }).length + ' disallowance adjustment(s) summed.',
    });
    lines.push({
        label: 'Less: Deductions',
        amount: deduction_total,
        note: adjustments.filter(function(a){ return DEDUCTION_TYPES.includes(a.adjustment_type); }).length + ' deduction adjustment(s) summed.',
    });
    lines.push({
        label: 'Less: Allowances / Capital Allowances',
        amount: allowance_total,
        note: adjustments.filter(function(a){ return ALLOWANCE_TYPES.includes(a.adjustment_type); }).length + ' allowance adjustment(s) summed. Includes capital allowances, s24C, doubtful debt, donations.',
    });
    lines.push({
        label: 'Income Before Assessed Loss',
        amount: taxable_pre_loss,
        note: 'Profit ± adjustments before assessed loss offset.',
    });
    lines.push({
        label: 'Less: Assessed Loss Utilised',
        amount: alUtilised,
        note: 'From return fields. Assessed loss B/F: ' + alBf.toFixed(2) + '. REQUIRES ACCOUNTANT REVIEW — carry-forward rules not enforced here.',
    });
    lines.push({
        label: 'Taxable Income Estimate',
        amount: taxable_income_estimate,
        note: floored
            ? 'Floored at zero — pre-assessed-loss figure was negative. Excess loss may be available to carry forward.'
            : 'DRAFT estimate only. Not SARS-final.',
    });
    lines.push({
        label: 'Company Tax Rate',
        amount: null,
        rate:   (CT_RATE_PLACEHOLDER * 100).toFixed(2) + '%',
        note:   'PLACEHOLDER ' + CT_RATE_VERSION + '. Verify SARS published rate for year ' + taxYear + '. SMMEs and other entity types may qualify for different rates.',
    });
    lines.push({
        label: 'Normal Tax Estimate',
        amount: normal_tax_estimate,
        note:   'Taxable income × ' + (CT_RATE_PLACEHOLDER * 100).toFixed(2) + '%. DRAFT — accountant review required.',
    });
    lines.push({
        label: 'Less: Provisional Tax Paid',
        amount: provisional_tax_paid,
        note:   provWarning
            ? 'Not linked — set related_provisional_tax_plan_id on the return to auto-populate.'
            : 'Sum of submitted/paid periods from provisional tax plan ' + provSource + '.',
    });

    if (estimated_tax_payable !== null) {
        lines.push({
            label: 'Estimated Tax Payable to SARS',
            amount: estimated_tax_payable,
            note:   'DRAFT — requires full accountant review. Not for submission.',
        });
        lines.push({
            label: 'Estimated Refund from SARS',
            amount: estimated_refund,
            note:   'DRAFT — requires full accountant review. Not for submission.',
        });
    } else {
        lines.push({
            label: 'Estimated Payable / Refund',
            amount: null,
            note:   'Cannot compute — provisional tax offset not available. Link a provisional tax plan to calculate.',
        });
    }

    // ── Assumptions ───────────────────────────────────────────────────────────
    const assumptions = [
        'Company tax rate is a placeholder (' + (CT_RATE_PLACEHOLDER * 100) + '% SA standard). Verify against SARS for this tax year and entity type.',
        'Add-back types summed: add_back. Disallowance types summed: disallowance.',
        'Deduction types summed: deduction. Allowance types summed: allowance, capital_allowance, section_24c, doubtful_debt, donation.',
        'Assessed loss utilised taken from AFS capture fields — not from multi-year carry-forward schedule.',
        'Provisional tax offset: ' + (provWarning ? 'not available (no linked plan or no submitted/paid periods).' : 'sourced from ' + provSource + '.'),
        'SBC (Small Business Corporation) rates, ring-fenced loss rules, CGT, dividends tax, and other entity-specific adjustments are NOT applied.',
        adjCount + ' adjustment(s) captured at time of calculation. Re-run draft to update after adding adjustments.',
    ];

    return {
        accounting_profit_loss:         profit,
        add_back_total,
        disallowance_total,
        deduction_total,
        allowance_total,
        assessed_loss_brought_forward:  alBf,
        assessed_loss_utilised:         alUtilised,
        taxable_income_estimate,
        company_tax_rate:               CT_RATE_PLACEHOLDER,
        normal_tax_estimate,
        provisional_tax_paid,
        estimated_tax_payable,
        estimated_refund,
        tax_config_source:              'placeholder',
        tax_config_version:             CT_RATE_VERSION,
        warning_flags:                  warnings,
        calculation_lines:              lines,
        assumptions,
    };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// CRITICAL: 3-segment paths (calculations/:id/events, calculations/:id/submit-review, etc.)
// MUST be registered BEFORE 2-segment paths (calculations/:id, :returnId/calculations).

// ── GET /calculations/:id/events ──────────────────────────────────────────────

router.get('/calculations/:id/events', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);
    if (isNaN(calcId)) return res.status(400).json({ error: 'Invalid calculation id' });

    const calc = await verifyCalcBelongsToCompany(cid, calcId);
    if (!calc) return res.status(404).json({ error: 'Calculation not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_calculation_events')
        .select('*')
        .eq('calculation_id', calcId)
        .eq('company_id', cid)
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ events: data || [] });
});

// ── POST /calculations/:id/submit-review ──────────────────────────────────────

router.post('/calculations/:id/submit-review', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);
    if (isNaN(calcId)) return res.status(400).json({ error: 'Invalid calculation id' });

    const existing = await verifyCalcBelongsToCompany(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (!['draft', 'rejected'].includes(existing.calculation_status)) {
        return res.status(400).json({ error: 'Only draft or rejected calculations can be submitted for review' });
    }

    try {
        const { data: calc, error } = await supabase
            .from('practice_company_tax_calculations')
            .update({
                calculation_status: 'ready_for_review',
                updated_at:         new Date().toISOString(),
                updated_by:         req.user?.id || null,
            })
            .eq('id', calcId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logCalcEvent(cid, calcId, existing.company_tax_return_id, 'company_tax_calculation_submitted_review', {
            old_status:    existing.calculation_status,
            new_status:    'ready_for_review',
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'company_tax_calculation_submitted_review', { calculation_id: calcId });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /calculations/:id/approve ────────────────────────────────────────────

router.post('/calculations/:id/approve', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);
    if (isNaN(calcId)) return res.status(400).json({ error: 'Invalid calculation id' });

    const existing = await verifyCalcBelongsToCompany(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (!['ready_for_review', 'reviewed'].includes(existing.calculation_status)) {
        return res.status(400).json({ error: 'Calculation must be ready_for_review or reviewed to approve' });
    }

    const now = new Date().toISOString();
    try {
        const { data: calc, error } = await supabase
            .from('practice_company_tax_calculations')
            .update({
                calculation_status: 'approved',
                reviewed_at:        now,
                reviewed_by:        req.user?.id || null,
                approved_at:        now,
                approved_by:        req.user?.id || null,
                updated_at:         now,
                updated_by:         req.user?.id || null,
            })
            .eq('id', calcId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logCalcEvent(cid, calcId, existing.company_tax_return_id, 'company_tax_calculation_approved', {
            old_status:    existing.calculation_status,
            new_status:    'approved',
            actor_user_id: req.user?.id,
            notes:         req.body.notes || null,
        });
        await auditFromReq(req, 'company_tax_calculation_approved', { calculation_id: calcId });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /calculations/:id/reject ─────────────────────────────────────────────

router.post('/calculations/:id/reject', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);
    if (isNaN(calcId)) return res.status(400).json({ error: 'Invalid calculation id' });

    const existing = await verifyCalcBelongsToCompany(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (!['ready_for_review', 'reviewed'].includes(existing.calculation_status)) {
        return res.status(400).json({ error: 'Calculation must be ready_for_review or reviewed to reject' });
    }

    const reason = (req.body.rejection_reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'rejection_reason is required' });

    try {
        const { data: calc, error } = await supabase
            .from('practice_company_tax_calculations')
            .update({
                calculation_status: 'rejected',
                rejection_reason:   reason,
                updated_at:         new Date().toISOString(),
                updated_by:         req.user?.id || null,
            })
            .eq('id', calcId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logCalcEvent(cid, calcId, existing.company_tax_return_id, 'company_tax_calculation_rejected', {
            old_status:    existing.calculation_status,
            new_status:    'rejected',
            actor_user_id: req.user?.id,
            notes:         reason,
        });
        await auditFromReq(req, 'company_tax_calculation_rejected', { calculation_id: calcId, reason });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /calculations/:id ─────────────────────────────────────────────────────

router.get('/calculations/:id', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);
    if (isNaN(calcId)) return res.status(400).json({ error: 'Invalid calculation id' });

    const calc = await verifyCalcBelongsToCompany(cid, calcId);
    if (!calc) return res.status(404).json({ error: 'Calculation not found' });

    res.json({ calculation: calc });
});

// ── PUT /calculations/:id ─────────────────────────────────────────────────────

router.put('/calculations/:id', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);
    if (isNaN(calcId)) return res.status(400).json({ error: 'Invalid calculation id' });

    const existing = await verifyCalcBelongsToCompany(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });

    if (['approved'].includes(existing.calculation_status)) {
        return res.status(400).json({ error: 'Approved calculations cannot be edited' });
    }

    const ALLOWED = ['calculation_name', 'notes', 'internal_notes'];
    const updates = { updated_at: new Date().toISOString(), updated_by: req.user?.id || null };
    ALLOWED.forEach(function(k) {
        if (k in req.body) updates[k] = req.body[k];
    });

    const { data, error } = await supabase
        .from('practice_company_tax_calculations')
        .update(updates)
        .eq('id', calcId)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ calculation: data });
});

// ── GET /:returnId/calculations ───────────────────────────────────────────────

router.get('/:returnId/calculations', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);
    if (isNaN(returnId)) return res.status(400).json({ error: 'Invalid returnId' });

    const taxReturn = await verifyReturnBelongsToCompany(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Company tax return not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_calculations')
        .select('*')
        .eq('company_tax_return_id', returnId)
        .eq('company_id', cid)
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ calculations: data || [] });
});

// ── POST /:returnId/calculations/run-draft ────────────────────────────────────

router.post('/:returnId/calculations/run-draft', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);
    if (isNaN(returnId)) return res.status(400).json({ error: 'Invalid returnId' });

    // Verify return, profile, and client all belong to this company
    const taxReturn = await verifyReturnBelongsToCompany(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Company tax return not found' });

    // Verify profile
    if (taxReturn.taxpayer_profile_id) {
        const { data: profile } = await supabase
            .from('practice_taxpayer_profiles')
            .select('id')
            .eq('id', taxReturn.taxpayer_profile_id)
            .eq('company_id', cid)
            .single();
        if (!profile) return res.status(403).json({ error: 'Taxpayer profile does not belong to this company' });
    }

    // Verify client
    if (taxReturn.client_id) {
        const { data: client } = await supabase
            .from('practice_clients')
            .select('id')
            .eq('id', taxReturn.client_id)
            .eq('company_id', cid)
            .single();
        if (!client) return res.status(403).json({ error: 'Client does not belong to this company' });
    }

    try {
        // Run the draft calculation — all inputs fetched from DB
        const result = await runCompanyTaxDraftCalc(cid, taxReturn);

        // Determine next version number
        const { data: prevCalcs } = await supabase
            .from('practice_company_tax_calculations')
            .select('calculation_version')
            .eq('company_tax_return_id', returnId)
            .eq('company_id', cid)
            .order('calculation_version', { ascending: false })
            .limit(1);

        const nextVersion = prevCalcs && prevCalcs.length > 0
            ? (prevCalcs[0].calculation_version || 0) + 1
            : 1;

        const calcName = req.body.calculation_name
            || 'Draft v' + nextVersion + ' — ' + taxReturn.return_name;

        // Store calculation — all values server-side computed
        const { data: calc, error: insertErr } = await supabase
            .from('practice_company_tax_calculations')
            .insert({
                company_id:                     cid,
                company_tax_return_id:          returnId,
                client_id:                      taxReturn.client_id,
                taxpayer_profile_id:            taxReturn.taxpayer_profile_id,
                tax_year:                       taxReturn.tax_year,
                calculation_name:               calcName,
                calculation_status:             'draft',

                accounting_profit_loss:         result.accounting_profit_loss,
                add_back_total:                 result.add_back_total,
                deduction_total:                result.deduction_total,
                allowance_total:                result.allowance_total,
                disallowance_total:             result.disallowance_total,
                assessed_loss_brought_forward:  result.assessed_loss_brought_forward,
                assessed_loss_utilised:         result.assessed_loss_utilised,
                taxable_income_estimate:        result.taxable_income_estimate,

                company_tax_rate:               result.company_tax_rate,
                normal_tax_estimate:            result.normal_tax_estimate,
                provisional_tax_paid:           result.provisional_tax_paid,
                estimated_tax_payable:          result.estimated_tax_payable,
                estimated_refund:               result.estimated_refund,

                tax_config_source:              result.tax_config_source,
                tax_config_version:             result.tax_config_version,
                calculation_version:            nextVersion,
                warning_flags:                  result.warning_flags,
                calculation_lines:              result.calculation_lines,
                assumptions:                    result.assumptions,

                notes:                          req.body.notes || null,
                created_by:                     req.user?.id || null,
                updated_by:                     req.user?.id || null,
            })
            .select()
            .single();

        if (insertErr) throw insertErr;

        await logCalcEvent(cid, calc.id, returnId, 'company_tax_calculation_run', {
            new_status:    'draft',
            actor_user_id: req.user?.id,
            metadata: {
                version:               nextVersion,
                taxable_income:        result.taxable_income_estimate,
                normal_tax:            result.normal_tax_estimate,
                warning_count:         result.warning_flags.length,
                adjustment_count:      (result.add_back_total !== 0 || result.deduction_total !== 0 || result.allowance_total !== 0 || result.disallowance_total !== 0),
            },
        });
        await auditFromReq(req, 'company_tax_calculation_run', {
            calculation_id: calc.id,
            return_id: returnId,
            version: nextVersion,
        });

        res.status(201).json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
