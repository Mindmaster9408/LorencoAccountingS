/* =============================================================
   Practice Individual Income Tax — Draft Calculation Engine  (Codebox 28)

   DRAFT / REVIEW ONLY. NOT SARS-final.
   NOT eFiling submission. NOT tax advice.
   All output requires accountant review before use.

   Mounted ADDITIONALLY at /api/practice/individual-tax (alongside individual-tax.js).
   Routes in this file cover:
     GET    /:returnId/calculations
     POST   /:returnId/calculations/run-draft
     GET    /calculations/:id/events       ← registered before GET /calculations/:id
     POST   /calculations/:id/submit-review
     POST   /calculations/:id/approve
     POST   /calculations/:id/reject
     GET    /calculations/:id
     PUT    /calculations/:id
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }        = require('../../config/database');
const { auditFromReq }    = require('../../middleware/audit');
const { getConstants, computeTaxFromBrackets, CONSTANTS_VERSION } = require('./individual-tax-constants');

// ─── Constants ────────────────────────────────────────────────────────────────

const CALC_STATUSES = [
    'draft', 'ready_for_review', 'reviewed', 'approved', 'rejected', 'cancelled',
];

// Income types that imply an IRP5 / employment income certificate
const IRP5_INCOME_TYPES = ['salary', 'pension', 'annuity'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyReturnOwnership(cid, returnId) {
    const { data } = await supabase
        .from('practice_individual_tax_returns')
        .select('*')
        .eq('id', returnId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifyCalcOwnership(cid, calcId) {
    const { data } = await supabase
        .from('practice_individual_tax_calculations')
        .select('*')
        .eq('id', calcId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function logCalcEvent(cid, calcId, returnId, eventType, extras = {}) {
    await supabase.from('practice_individual_tax_calculation_events').insert({
        company_id:     cid,
        calculation_id: calcId,
        tax_return_id:  returnId,
        event_type:     eventType,
        old_status:     extras.old_status    || null,
        new_status:     extras.new_status    || null,
        actor_user_id:  extras.actor_user_id || null,
        notes:          extras.notes         || null,
        metadata:       extras.metadata      || {},
    });
}

// ─── Core Calculation Logic ───────────────────────────────────────────────────

async function runDraftCalculation(cid, taxReturn) {
    const returnId = taxReturn.id;
    const taxYear  = taxReturn.tax_year;

    // Fetch income entries
    const { data: incomeEntries } = await supabase
        .from('practice_individual_tax_income_entries')
        .select('income_type, gross_amount, tax_withheld')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid);

    // Fetch deduction entries
    const { data: deductionEntries } = await supabase
        .from('practice_individual_tax_deduction_entries')
        .select('deduction_type, amount')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid);

    const income     = incomeEntries     || [];
    const deductions = deductionEntries  || [];

    // ── Accumulate input totals ──────────────────────────────────────────────
    let gross_income_total  = 0;
    let paye_withheld       = 0;
    income.forEach(function (e) {
        gross_income_total += parseFloat(e.gross_amount  || 0);
        paye_withheld      += parseFloat(e.tax_withheld  || 0);
    });

    let deduction_total = 0;
    deductions.forEach(function (e) {
        deduction_total += parseFloat(e.amount || 0);
    });

    // Round all inputs to 2dp
    gross_income_total = Math.round(gross_income_total * 100) / 100;
    paye_withheld      = Math.round(paye_withheld      * 100) / 100;
    deduction_total    = Math.round(deduction_total    * 100) / 100;

    // Foundation: subtract deductions directly (caps NOT enforced in CB28 — CB29 adds cap tables)
    const taxable_after_deductions = Math.max(0, Math.round((gross_income_total - deduction_total) * 100) / 100);

    // ── Fetch tax constants — DB first, JS fallback ──────────────────────────
    // 1. Try active DB config for this tax year (global scope first, company-specific if exists)
    // 2. Fallback: JS hardcoded constants (individual-tax-constants.js)
    // 3. Neither: limited calculation, warnings added

    let constants      = null;
    let tableVersion   = 'MISSING';
    let constantSource = 'none';   // 'db' | 'js_fallback' | 'none'

    try {
        // Prefer company-specific active config, then global active config
        const { data: dbConfigs } = await supabase
            .from('practice_tax_year_configs')
            .select('*')
            .eq('tax_year',     taxYear)
            .eq('status',       'active')
            .eq('country_code', 'ZA')
            .or('company_id.is.null,company_id.eq.' + cid)
            .order('company_id', { ascending: false, nullsFirst: false })   // company-specific first
            .limit(1);

        if (dbConfigs && dbConfigs.length > 0) {
            const dbCfg = dbConfigs[0];

            // Load brackets for this config
            const { data: dbBrackets } = await supabase
                .from('practice_tax_brackets')
                .select('*')
                .eq('config_id', dbCfg.id)
                .order('bracket_order');

            const brackets = (dbBrackets || []).map(function (b) {
                return {
                    from: parseFloat(b.lower_bound),
                    to:   b.upper_bound != null ? parseFloat(b.upper_bound) : null,
                    base: parseFloat(b.base_tax),
                    rate: parseFloat(b.marginal_rate) / 100,   // stored as %, needs decimal
                };
            });

            constants = {
                version:  dbCfg.config_name,
                brackets: brackets,
                rebates:  {
                    primary:   dbCfg.primary_rebate   != null ? parseFloat(dbCfg.primary_rebate)   : 0,
                    secondary: dbCfg.secondary_rebate != null ? parseFloat(dbCfg.secondary_rebate) : 0,
                    tertiary:  dbCfg.tertiary_rebate  != null ? parseFloat(dbCfg.tertiary_rebate)  : 0,
                },
                thresholds: {
                    under_65:  dbCfg.tax_threshold_under_65 != null ? parseFloat(dbCfg.tax_threshold_under_65) : 0,
                    '65_to_74': dbCfg.tax_threshold_65_to_74 != null ? parseFloat(dbCfg.tax_threshold_65_to_74) : 0,
                    '75_plus':  dbCfg.tax_threshold_75_plus  != null ? parseFloat(dbCfg.tax_threshold_75_plus)  : 0,
                },
                _db_config_id: dbCfg.id,
            };
            tableVersion   = dbCfg.config_name;
            constantSource = 'db';
        }
    } catch (dbErr) {
        // DB lookup failure — fall through to JS constants
        constantSource = 'js_fallback';
    }

    // JS fallback if DB had no active config
    if (!constants) {
        const jsConsts = getConstants(taxYear);
        if (jsConsts) {
            constants      = jsConsts;
            tableVersion   = jsConsts.version || '?';
            constantSource = 'js_fallback';
        }
    }

    const hasBrackets  = !!(constants && constants.brackets && constants.brackets.length > 0);

    // ── Apply tax brackets ───────────────────────────────────────────────────
    let normal_tax_before_rebates = null;
    let primary_rebate            = null;
    let tax_after_rebates         = null;

    if (hasBrackets && taxable_after_deductions > 0) {
        normal_tax_before_rebates = computeTaxFromBrackets(taxable_after_deductions, constants.brackets);
        primary_rebate            = constants.rebates.primary;
        tax_after_rebates         = Math.max(0, Math.round((normal_tax_before_rebates - primary_rebate) * 100) / 100);
    }

    // ── Estimated payable / refund ───────────────────────────────────────────
    let estimated_tax_payable = null;
    let estimated_refund      = null;

    if (tax_after_rebates !== null) {
        const diff = Math.round((tax_after_rebates - paye_withheld) * 100) / 100;
        if (diff >= 0) {
            estimated_tax_payable = diff;
            estimated_refund      = 0;
        } else {
            estimated_tax_payable = 0;
            estimated_refund      = Math.abs(diff);
        }
    }

    // ── Build calculation lines ──────────────────────────────────────────────
    const lines = [];
    lines.push({ label: 'Gross Income (sum of all income entries)',  amount: gross_income_total,  note: income.length + ' income entry/entries' });
    lines.push({ label: 'Total Deductions (caps NOT applied — CB29)', amount: deduction_total,    note: deductions.length + ' deduction entry/entries. Deduction caps, RA 15% rule, and s18A cap not yet enforced.' });
    lines.push({ label: 'Taxable Income (before deduction caps)',    amount: taxable_after_deductions, note: 'Gross minus deductions. Foundation-level — CB29 will apply statutory caps.' });

    if (normal_tax_before_rebates !== null) {
        lines.push({ label: 'Normal Tax Before Rebates',            amount: normal_tax_before_rebates, note: 'Applied ' + (constants.version || 'unknown') + ' SARS brackets. DRAFT — verify with accountant.' });
        lines.push({ label: 'Less: Primary Rebate',                 amount: primary_rebate,           note: (constants.version || 'unknown') + ' primary rebate. Age-related secondary/tertiary rebates not applied — age not captured.' });
        lines.push({ label: 'Tax After Rebates',                    amount: tax_after_rebates,        note: '' });
    } else {
        lines.push({ label: 'Tax Calculation', amount: null, note: 'No tax table available for year ' + taxYear + '. Tax could not be computed.' });
    }

    lines.push({ label: 'Less: PAYE Withheld (from income entries)', amount: paye_withheld, note: 'Sum of tax_withheld from income entries.' });

    if (estimated_tax_payable !== null) {
        lines.push({ label: 'Estimated Tax Payable to SARS',         amount: estimated_tax_payable, note: 'DRAFT — requires full accountant review before submission.' });
        lines.push({ label: 'Estimated Refund from SARS',            amount: estimated_refund,      note: 'DRAFT — requires full accountant review before submission.' });
    }

    // ── Build warning flags ──────────────────────────────────────────────────
    const warnings = ['DRAFT_TAX_TABLE_REQUIRES_REVIEW', 'REVIEW_REQUIRED'];

    if (gross_income_total === 0) {
        warnings.push('NO_INCOME_DATA');
    }

    const hasIrp5Income = income.some(function (e) { return IRP5_INCOME_TYPES.includes(e.income_type); });
    if (!hasIrp5Income) {
        warnings.push('MISSING_IRP5_INCOME_ENTRY');
    }

    const hasTravelIncome  = income.some(function (e)     { return e.income_type === 'travel'; });
    const hasTravelDed     = deductions.some(function (e) { return e.deduction_type === 'travel'; });
    if (hasTravelIncome || hasTravelDed) {
        warnings.push('TRAVEL_LOGBOOK_NOT_CALCULATED');
    }

    const hasRentalIncome = income.some(function (e) { return e.income_type === 'rental'; });
    if (hasRentalIncome) {
        warnings.push('RENTAL_INCOME_NOT_DETAILED');
    }

    const hasCgtIncome = income.some(function (e) { return e.income_type === 'capital_gain'; });
    if (hasCgtIncome) {
        warnings.push('CGT_NOT_DETAILED');
    }

    const hasRaDed = deductions.some(function (e) { return e.deduction_type === 'retirement_annuity'; });
    if (hasRaDed) {
        warnings.push('RA_DEDUCTION_CAP_NOT_ENFORCED');
    }

    const hasMedDed = deductions.some(function (e) { return e.deduction_type === 'medical'; });
    if (hasMedDed) {
        warnings.push('MEDICAL_TAX_CREDIT_NOT_APPLIED');
    }

    if (!hasBrackets) {
        warnings.push('TAX_CONSTANTS_MISSING_CALC_LIMITED');
    }

    if (constantSource === 'js_fallback') {
        warnings.push('DB_TAX_CONFIG_NOT_FOUND_USING_JS_FALLBACK');
    }

    // ── Build assumptions list ───────────────────────────────────────────────
    const sourceLabel = constantSource === 'db'
        ? 'DB config: ' + tableVersion
        : constantSource === 'js_fallback'
            ? 'JS fallback constants: ' + CONSTANTS_VERSION + ' / ' + tableVersion
            : 'No tax constants available';

    const assumptions = [
        'Primary rebate only — secondary (65+) and tertiary (75+) rebates not applied (age not captured).',
        'Medical tax credits not applied — member count not available at this foundation level.',
        'Deduction caps not enforced — RA 15% cap, s18A 10% cap, travel fixed-cost tables not applied.',
        'Provisional tax paid not deducted — must be entered manually on the calculation.',
        'Tax table source: ' + sourceLabel + '. Verify SARS published rates for this year.',
    ];

    return {
        gross_income_total,
        taxable_income_total:     gross_income_total,   // foundation: no exclusions yet
        deduction_total,
        taxable_after_deductions,
        normal_tax_before_rebates,
        primary_rebate,
        secondary_rebate:         null,   // not applied — age not captured
        tertiary_rebate:          null,
        medical_tax_credit:       null,   // not applied — member count not captured
        additional_medical_credit:null,
        tax_after_rebates,
        paye_withheld,
        provisional_tax_paid:     null,
        estimated_tax_payable,
        estimated_refund,
        tax_table_version:        (constantSource === 'db' ? '[DB] ' : '[JS] ') + tableVersion,
        warning_flags:            warnings,
        calculation_lines:        lines,
        assumptions,
    };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// CRITICAL: /calculations/:id/... (3-segment) and /:returnId/calculations/... (3-segment)
// registered BEFORE the generic /calculations/:id (2-segment) and /:returnId/calculations (2-segment).

// ── GET /calculations/:id/events ──────────────────────────────────────────────

router.get('/calculations/:id/events', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);

    const calc = await verifyCalcOwnership(cid, calcId);
    if (!calc) return res.status(404).json({ error: 'Calculation not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_calculation_events')
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

    const existing = await verifyCalcOwnership(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (!['draft', 'rejected'].includes(existing.calculation_status))
        return res.status(400).json({ error: 'Only draft or rejected calculations can be submitted for review' });

    try {
        const { data: calc, error } = await supabase
            .from('practice_individual_tax_calculations')
            .update({ calculation_status: 'ready_for_review', updated_at: new Date().toISOString(), updated_by: req.user?.id || null })
            .eq('id', calcId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logCalcEvent(cid, calcId, existing.tax_return_id, 'individual_tax_calculation_submitted_review', {
            old_status: existing.calculation_status, new_status: 'ready_for_review',
            actor_user_id: req.user?.id,
        });
        await auditFromReq(req, 'individual_tax_calculation_submitted_review', { calculation_id: calcId });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /calculations/:id/approve ────────────────────────────────────────────

router.post('/calculations/:id/approve', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);

    const existing = await verifyCalcOwnership(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (!['ready_for_review', 'reviewed'].includes(existing.calculation_status))
        return res.status(400).json({ error: 'Calculation must be ready_for_review or reviewed to approve' });

    const now = new Date().toISOString();
    try {
        const { data: calc, error } = await supabase
            .from('practice_individual_tax_calculations')
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

        await logCalcEvent(cid, calcId, existing.tax_return_id, 'individual_tax_calculation_approved', {
            old_status: existing.calculation_status, new_status: 'approved',
            actor_user_id: req.user?.id,
            notes: req.body.notes || null,
        });
        await auditFromReq(req, 'individual_tax_calculation_approved', { calculation_id: calcId });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /calculations/:id/reject ─────────────────────────────────────────────

router.post('/calculations/:id/reject', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);

    const existing = await verifyCalcOwnership(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (!['ready_for_review', 'reviewed'].includes(existing.calculation_status))
        return res.status(400).json({ error: 'Calculation must be ready_for_review or reviewed to reject' });

    const reason = req.body.rejection_reason || null;
    try {
        const { data: calc, error } = await supabase
            .from('practice_individual_tax_calculations')
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

        await logCalcEvent(cid, calcId, existing.tax_return_id, 'individual_tax_calculation_rejected', {
            old_status: existing.calculation_status, new_status: 'rejected',
            actor_user_id: req.user?.id,
            notes: reason,
        });
        await auditFromReq(req, 'individual_tax_calculation_rejected', { calculation_id: calcId, reason });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /:returnId/calculations/run-draft ────────────────────────────────────

router.post('/:returnId/calculations/run-draft', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });
    if (taxReturn.status === 'cancelled') return res.status(400).json({ error: 'Cannot calculate on a cancelled return' });

    try {
        const result = await runDraftCalculation(cid, taxReturn);

        // Determine next calculation version
        const { data: existing } = await supabase
            .from('practice_individual_tax_calculations')
            .select('calculation_version')
            .eq('tax_return_id', returnId)
            .eq('company_id', cid)
            .order('calculation_version', { ascending: false })
            .limit(1);

        const nextVersion = existing && existing.length > 0
            ? (existing[0].calculation_version + 1)
            : 1;

        const calcName = 'Draft Calculation v' + nextVersion + ' — ' + taxReturn.tax_year;

        const { data: calc, error } = await supabase
            .from('practice_individual_tax_calculations')
            .insert({
                company_id:                 cid,
                tax_return_id:              returnId,
                client_id:                  taxReturn.client_id,
                taxpayer_profile_id:        taxReturn.taxpayer_profile_id,
                tax_year:                   taxReturn.tax_year,
                calculation_name:           calcName,
                calculation_status:         'draft',
                calculation_version:        nextVersion,

                gross_income_total:         result.gross_income_total,
                taxable_income_total:       result.taxable_income_total,
                deduction_total:            result.deduction_total,
                taxable_after_deductions:   result.taxable_after_deductions,
                normal_tax_before_rebates:  result.normal_tax_before_rebates,
                primary_rebate:             result.primary_rebate,
                secondary_rebate:           result.secondary_rebate,
                tertiary_rebate:            result.tertiary_rebate,
                medical_tax_credit:         result.medical_tax_credit,
                additional_medical_credit:  result.additional_medical_credit,
                tax_after_rebates:          result.tax_after_rebates,
                paye_withheld:              result.paye_withheld,
                provisional_tax_paid:       result.provisional_tax_paid,
                estimated_tax_payable:      result.estimated_tax_payable,
                estimated_refund:           result.estimated_refund,

                tax_table_version:          result.tax_table_version,
                warning_flags:              result.warning_flags,
                calculation_lines:          result.calculation_lines,
                assumptions:                result.assumptions,

                created_by:                 req.user?.id || null,
                updated_by:                 req.user?.id || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logCalcEvent(cid, calc.id, returnId, 'individual_tax_calculation_run', {
            actor_user_id: req.user?.id,
            metadata: {
                calculation_version: nextVersion,
                gross_income_total:  result.gross_income_total,
                warning_count:       result.warning_flags.length,
            },
        });
        await auditFromReq(req, 'individual_tax_calculation_run', {
            calculation_id: calc.id, tax_return_id: returnId, version: nextVersion,
        });

        res.status(201).json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /calculations/:id ─────────────────────────────────────────────────────

router.get('/calculations/:id', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);

    const calc = await verifyCalcOwnership(cid, calcId);
    if (!calc) return res.status(404).json({ error: 'Calculation not found' });

    res.json({ calculation: calc });
});

// ── PUT /calculations/:id ─────────────────────────────────────────────────────

router.put('/calculations/:id', async (req, res) => {
    const cid    = req.companyId;
    const calcId = parseInt(req.params.id);

    const existing = await verifyCalcOwnership(cid, calcId);
    if (!existing) return res.status(404).json({ error: 'Calculation not found' });
    if (existing.calculation_status === 'cancelled')
        return res.status(400).json({ error: 'Cannot modify a cancelled calculation' });

    const allowed = ['calculation_name', 'provisional_tax_paid', 'notes', 'internal_notes'];
    const updates = { updated_at: new Date().toISOString(), updated_by: req.user?.id || null };
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    if (updates.provisional_tax_paid != null)
        updates.provisional_tax_paid = parseFloat(updates.provisional_tax_paid);

    try {
        const { data: calc, error } = await supabase
            .from('practice_individual_tax_calculations')
            .update(updates)
            .eq('id', calcId)
            .eq('company_id', cid)
            .select()
            .single();
        if (error) throw error;

        await logCalcEvent(cid, calcId, existing.tax_return_id, 'individual_tax_calculation_updated', {
            actor_user_id: req.user?.id,
        });

        res.json({ calculation: calc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /:returnId/calculations ───────────────────────────────────────────────

router.get('/:returnId/calculations', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_calculations')
        .select('*')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .neq('calculation_status', 'cancelled')
        .order('calculation_version', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ calculations: data || [] });
});

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = router;
