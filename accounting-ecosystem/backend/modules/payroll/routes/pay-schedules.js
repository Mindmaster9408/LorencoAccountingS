/**
 * ============================================================================
 * Pay Schedules Routes — /api/payroll/pay-schedules
 * ============================================================================
 * CRUD for company-level pay schedule definitions.
 *
 * A pay schedule defines WHEN a group of employees gets paid.
 * Employees are assigned one schedule each via employees.pay_schedule_id.
 * Pay runs can be filtered by schedule to process only the relevant group.
 *
 * Tax note: pay schedules are operational grouping only.
 *   PAYE/UIF calculations remain per-employee and roll up to company level
 *   regardless of which schedule group was processed.
 *
 * Endpoints:
 *   GET    /api/payroll/pay-schedules          — list active schedules for company
 *   POST   /api/payroll/pay-schedules          — create schedule (PAYROLL.APPROVE)
 *   PUT    /api/payroll/pay-schedules/:id      — update schedule (PAYROLL.APPROVE)
 *   DELETE /api/payroll/pay-schedules/:id      — soft-delete / deactivate (PAYROLL.APPROVE)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

const VALID_FREQUENCIES = ['monthly', 'weekly', 'bi_weekly'];

// ─── GET /api/payroll/pay-schedules ──────────────────────────────────────────
/**
 * List all active pay schedules for the current company.
 * Also returns the count of employees assigned to each schedule.
 */
router.get('/', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('company_pay_schedules')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('display_order')
      .order('created_at');

    if (error) return res.status(500).json({ error: error.message });

    // Enrich each schedule with an employee count
    const schedules = data || [];
    await Promise.all(schedules.map(async (s) => {
      try {
        const { count } = await supabase
          .from('employees')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', req.companyId)
          .eq('pay_schedule_id', s.id)
          .eq('is_active', true);
        s.employee_count = count || 0;
      } catch (_) {
        s.employee_count = 0;
      }
    }));

    res.json({ schedules });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/payroll/pay-schedules ─────────────────────────────────────────
/**
 * Create a new pay schedule for the current company.
 *
 * Body: { schedule_name, frequency_type, monthly_day?, is_last_day_of_month?, weekly_day?, display_order? }
 */
router.post('/', requirePermission('PAYROLL.APPROVE'), async (req, res) => {
  try {
    const {
      schedule_name, frequency_type,
      monthly_day, is_last_day_of_month,
      weekly_day, display_order
    } = req.body;

    if (!schedule_name || !schedule_name.trim()) {
      return res.status(400).json({ error: 'schedule_name is required' });
    }
    if (!frequency_type || !VALID_FREQUENCIES.includes(frequency_type)) {
      return res.status(400).json({ error: 'frequency_type must be monthly, weekly, or bi_weekly' });
    }
    // Validate monthly_day range
    if (monthly_day !== undefined && monthly_day !== null) {
      const day = parseInt(monthly_day, 10);
      if (isNaN(day) || day < 1 || day > 31) {
        return res.status(400).json({ error: 'monthly_day must be between 1 and 31' });
      }
    }
    // Validate weekly_day range
    if (weekly_day !== undefined && weekly_day !== null) {
      const wd = parseInt(weekly_day, 10);
      if (isNaN(wd) || wd < 0 || wd > 6) {
        return res.status(400).json({ error: 'weekly_day must be between 0 (Sun) and 6 (Sat)' });
      }
    }

    const { data, error } = await supabase
      .from('company_pay_schedules')
      .insert({
        company_id:           req.companyId,
        schedule_name:        schedule_name.trim(),
        frequency_type,
        monthly_day:          monthly_day !== undefined ? parseInt(monthly_day, 10) || null : null,
        is_last_day_of_month: is_last_day_of_month === true || is_last_day_of_month === 'true',
        weekly_day:           weekly_day !== undefined ? parseInt(weekly_day, 10) : null,
        display_order:        parseInt(display_order, 10) || 0
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A schedule with that name already exists for this company' });
      }
      return res.status(500).json({ error: error.message });
    }

    await auditFromReq(req, 'CREATE', 'pay_schedule', data.id, { newValue: data });
    res.status(201).json({ schedule: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PUT /api/payroll/pay-schedules/:id ──────────────────────────────────────
/**
 * Update an existing pay schedule.
 * Multi-tenant safe: verifies schedule belongs to req.companyId.
 */
router.put('/:id', requirePermission('PAYROLL.APPROVE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid schedule id' });

    // Confirm ownership
    const { data: existing, error: checkErr } = await supabase
      .from('company_pay_schedules')
      .select('id')
      .eq('id', id)
      .eq('company_id', req.companyId)
      .single();

    if (checkErr || !existing) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const allowed = ['schedule_name', 'frequency_type', 'monthly_day', 'is_last_day_of_month', 'weekly_day', 'display_order'];
    const updates = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.schedule_name) updates.schedule_name = String(updates.schedule_name).trim();
    if (updates.frequency_type && !VALID_FREQUENCIES.includes(updates.frequency_type)) {
      return res.status(400).json({ error: 'Invalid frequency_type' });
    }

    const { data, error } = await supabase
      .from('company_pay_schedules')
      .update(updates)
      .eq('id', id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'pay_schedule', id, { newValue: data });
    res.json({ schedule: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE /api/payroll/pay-schedules/:id ───────────────────────────────────
/**
 * Soft-delete (deactivate) a pay schedule.
 * Employees currently on this schedule will have pay_schedule_id remain (ON DELETE SET NULL
 * only fires on hard delete). They should be reassigned before deactivating.
 */
router.delete('/:id', requirePermission('PAYROLL.APPROVE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid schedule id' });

    // Check if employees are still assigned — warn but allow deactivation
    const { count } = await supabase
      .from('employees')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', req.companyId)
      .eq('pay_schedule_id', id)
      .eq('is_active', true);

    const { error } = await supabase
      .from('company_pay_schedules')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'pay_schedule', id);
    res.json({ success: true, employees_affected: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
