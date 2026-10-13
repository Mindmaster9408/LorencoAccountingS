/**
 * ============================================================================
 * Tax table routes — /api/payroll/tax-tables   (spec 02, Fase 1)
 * ============================================================================
 *   GET  /   — all tax years (any payroll user; read-only for normal companies)
 *   PUT  /   — create / update one tax year. super_admin in the global payroll
 *              authority company only (spec 02 BT-07). Every change is audited
 *              with old and new values.
 *
 * The current tax year is also mirrored to the old KV key (__global__ tax_config)
 * so pages that still use the legacy frontend engine (Fase 9) show the same
 * figures. The backend calculation never reads that mirror once migration 027
 * has run.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { isGlobalPayrollAuthority } = require('../../../shared/utils/globalAuthority');
const PayrollEngine = require('../../../core/payroll-engine');
const { validateTaxTableRow, taxYearDates, isMissingTableError } = require('../services/taxTables');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const FIELDS = [
  'brackets', 'primary_rebate', 'secondary_rebate', 'tertiary_rebate',
  'uif_rate', 'uif_monthly_cap', 'sdl_rate',
  'medical_credit_main', 'medical_credit_first_dep', 'medical_credit_additional',
  'confirmed', 'source'
];

router.get('/', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payroll_tax_tables')
      .select('*')
      .order('tax_year', { ascending: true });
    if (error) {
      if (isMissingTableError(error)) return res.json({ success: true, migrated: false, tables: [] });
      return res.status(500).json({ success: false, error: error.message });
    }
    res.json({
      success: true,
      migrated: true,
      current_tax_year: PayrollEngine.getTaxYearForPeriod(new Date().toISOString().slice(0, 7)),
      can_edit: req.user && req.user.role === 'super_admin' && await isGlobalPayrollAuthority(req.companyId),
      tables: data || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.put('/', async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Only a super user may change tax tables' });
    }
    if (!(await isGlobalPayrollAuthority(req.companyId))) {
      return res.status(403).json({ success: false, error: 'Switch to the global payroll authority company (The Infinite Legacy) to change tax tables' });
    }

    const body = req.body || {};
    const row = { tax_year: String(body.tax_year || '').trim() };
    FIELDS.forEach(f => { if (body[f] !== undefined) row[f] = body[f]; });
    if (Array.isArray(row.brackets)) {
      row.brackets = row.brackets.map((b, i, all) => ({
        min:  Number(b.min),
        max:  i === all.length - 1 ? null : Number(b.max),
        base: Number(b.base),
        rate: Number(b.rate)
      }));
    }

    const { data: existing, error: exErr } = await supabase
      .from('payroll_tax_tables').select('*').eq('tax_year', row.tax_year).maybeSingle();
    if (exErr) {
      if (isMissingTableError(exErr)) {
        return res.status(409).json({ success: false, error: 'Run migration 027 (payroll_tax_tables) in Supabase first' });
      }
      return res.status(500).json({ success: false, error: exErr.message });
    }

    const merged = Object.assign({}, existing || {}, row);
    const problems = validateTaxTableRow(merged);
    if (problems.length) return res.status(400).json({ success: false, error: problems.join('; '), problems });

    // Always write the FULL merged row: Postgres checks NOT NULL on the insert half of an
    // upsert before resolving the conflict, so a partial row (e.g. only { confirmed:false })
    // would fail even though the year exists.
    const payload = { tax_year: row.tax_year };
    FIELDS.forEach(f => { if (merged[f] !== undefined) payload[f] = merged[f]; });
    Object.assign(payload, taxYearDates(row.tax_year), {
      updated_by: req.user.userId || null,
      updated_at: new Date().toISOString()
    });
    if (payload.confirmed === undefined) payload.confirmed = false;

    const { data: saved, error } = await supabase
      .from('payroll_tax_tables')
      .upsert(payload, { onConflict: 'tax_year' })
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    try {
      await auditFromReq(req, existing ? 'UPDATE' : 'CREATE', 'payroll_tax_tables', null, {
        module: 'payroll', tax_year: row.tax_year, oldValue: existing || null, newValue: saved
      });
    } catch (auditErr) {
      console.warn('[tax-tables] audit failed:', auditErr.message);
    }

    // Mirror the CURRENT confirmed year to the legacy KV key for pages still on the
    // frontend engine (Fase 9). Best-effort; never fails the save.
    const currentYear = PayrollEngine.getTaxYearForPeriod(new Date().toISOString().slice(0, 7));
    if (saved.tax_year === currentYear && saved.confirmed === true) {
      try {
        const legacy = {
          TAX_YEAR: saved.tax_year,
          BRACKETS: saved.brackets,
          PRIMARY_REBATE: Number(saved.primary_rebate), SECONDARY_REBATE: Number(saved.secondary_rebate),
          TERTIARY_REBATE: Number(saved.tertiary_rebate), UIF_RATE: Number(saved.uif_rate),
          UIF_MONTHLY_CAP: Number(saved.uif_monthly_cap), SDL_RATE: Number(saved.sdl_rate),
          MEDICAL_CREDIT_MAIN: Number(saved.medical_credit_main),
          MEDICAL_CREDIT_FIRST_DEP: Number(saved.medical_credit_first_dep),
          MEDICAL_CREDIT_ADDITIONAL: Number(saved.medical_credit_additional)
        };
        await supabase.from('payroll_kv_store_eco').upsert(
          { company_id: '__global__', key: 'tax_config', value: legacy, updated_at: new Date().toISOString() },
          { onConflict: 'company_id,key' }
        );
      } catch (mirrorErr) {
        console.warn('[tax-tables] legacy KV mirror failed (non-fatal):', mirrorErr.message);
      }
    }

    res.json({ success: true, table: saved });
  } catch (err) {
    console.error('[tax-tables] save error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
