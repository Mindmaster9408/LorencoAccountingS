/**
 * ============================================================================
 * Payroll Employees Routes - Payroll Module
 * ============================================================================
 * Employee payroll data (salary, bank details, tax info).
 * Converted from localStorage (DataAccess) to Supabase API.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { getEmployeeFilter, applyFilter, canViewEmployee, requirePaytimeModule } = require('../services/paytimeAccess');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/payroll/employees
 * Get employees with their payroll-specific data.
 * Applies paytimeAccess visibility filter — restricted users only see their allowed employees.
 */
router.get('/', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const filter = await getEmployeeFilter(req.user.role, req.user.userId, req.companyId);

    let query = supabase
      .from('employees')
      .select('*, employee_bank_details(*)')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('last_name');

    query = applyFilter(query, filter);

    const { data: employees, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ employees: employees || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL LOG — must be before /:id to avoid param capture
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/employees/historical-log
 */
router.get('/historical-log', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payroll_historical')
      .select('employee_id, period_key, source, imported_at, employees(full_name, employee_code)')
      .eq('company_id', req.companyId)
      .order('imported_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/payroll/employees/:id
 */
router.get('/:id', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    // Reject non-integer IDs (e.g. old localStorage string IDs like "emp-abc123")
    if (!/^\d+$/.test(String(req.params.id))) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const { data, error } = await supabase
      .from('employees')
      .select('*, employee_bank_details(*)')
      .eq('id', parseInt(req.params.id))
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Employee not found' });

    // Visibility gate — restricted users cannot fetch employees outside their scope
    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, data);
    if (!visible) return res.status(403).json({ error: 'Access denied — employee not in your visible scope' });

    res.json({ employee: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/employees/:id/salary
 * Update salary information
 */
router.put('/:id/salary', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const { basic_salary, hourly_rate, payment_frequency } = req.body;

    const { data: old } = await supabase
      .from('employees')
      .select('id, classification, basic_salary, hourly_rate, payment_frequency')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!old) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, old);
    if (!visible) return res.status(403).json({ error: 'Access denied — employee not in your visible scope' });

    const updates = {};
    if (basic_salary !== undefined) updates.basic_salary = basic_salary;
    if (hourly_rate !== undefined) updates.hourly_rate = hourly_rate;
    if (payment_frequency !== undefined) updates.payment_frequency = payment_frequency;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'employee_salary', req.params.id, {
      module: 'payroll',
      oldValue: old,
      newValue: updates,
    });

    res.json({ employee: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/employees/:id/bank-details
 * Update bank details
 */
router.put('/:id/bank-details', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = req.params.id;
    const { bank_name, account_number, branch_code, account_type } = req.body;

    // Verify employee belongs to company + visibility check
    const { data: emp } = await supabase
      .from('employees')
      .select('id, classification')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied — employee not in your visible scope' });

    // Upsert bank details
    const { data, error } = await supabase
      .from('employee_bank_details')
      .upsert({
        employee_id: empId,
        bank_name,
        account_number,
        branch_code,
        account_type: account_type || 'savings',
        updated_at: new Date().toISOString()
      }, { onConflict: 'employee_id' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'bank_details', empId, {
      module: 'payroll',
      metadata: { bank_name }
    });

    res.json({ bank_details: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE NOTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/employees/:id/notes
 */
router.get('/:id/notes', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employee_notes')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('employee_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/employees/:id/notes
 */
router.post('/:id/notes', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes) return res.status(400).json({ error: 'notes field is required' });

    const records = (Array.isArray(notes) ? notes : [notes]).map(n => ({
      company_id: req.companyId,
      employee_id: parseInt(req.params.id),
      note_type: n.note_type || 'general',
      content: typeof n === 'string' ? n : n.content,
      created_by: req.user.userId
    }));

    const { data, error } = await supabase.from('employee_notes').insert(records).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL PAYROLL RECORDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/employees/:id/historical?period=YYYY-MM
 */
router.get('/:id/historical', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    // Visibility gate before returning historical payroll data
    const { data: emp } = await supabase
      .from('employees')
      .select('id, classification')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied — employee not in your visible scope' });

    const { period } = req.query;
    let query = supabase
      .from('payroll_historical')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('employee_id', req.params.id);

    if (period) query = query.eq('period_key', period);

    const { data, error } = await query.order('period_key', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // If period specified, return single record
    if (period) {
      res.json({ data: (data && data[0]) || null });
    } else {
      res.json({ data: data || [] });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/employees/:id/historical
 */
router.post('/:id/historical', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { period_key, gross, paye, uif, net, source } = req.body;
    if (!period_key) return res.status(400).json({ error: 'period_key is required' });

    const { data, error } = await supabase
      .from('payroll_historical')
      .upsert({
        company_id: req.companyId,
        employee_id: parseInt(req.params.id),
        period_key,
        gross: gross || 0,
        paye: paye || 0,
        uif: uif || 0,
        net: net || 0,
        source: source || 'manual'
      }, { onConflict: 'company_id,employee_id,period_key' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/payroll/employees/:id
 * Deactivate (soft-delete) an employee. Sets is_active = false.
 * Payroll history is preserved.
 */
router.delete('/:id', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    if (!empId) return res.status(400).json({ error: 'Invalid employee ID' });

    // Ensure employee belongs to this company before deactivating
    const { data: existing, error: fetchErr } = await supabase
      .from('employees')
      .select('id, first_name, last_name, employee_number')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Employee not found' });

    const { error } = await supabase
      .from('employees')
      .update({ is_active: false })
      .eq('id', empId)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'employee', empId, {
      action: 'deactivated',
      employee_number: existing.employee_number,
      name: (existing.first_name || '') + ' ' + (existing.last_name || '')
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/payroll/employees/:id/historical?period=YYYY-MM
 */
router.delete('/:id/historical', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ error: 'period query parameter required' });

    const { error } = await supabase
      .from('payroll_historical')
      .delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', req.params.id)
      .eq('period_key', period);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYROLL NARRATIVE (per employee per period)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/employees/:id/narrative?period=YYYY-MM
 */
router.get('/:id/narrative', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ error: 'period query parameter required' });

    const { data, error } = await supabase
      .from('employee_notes')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('employee_id', req.params.id)
      .eq('note_type', 'narrative_' + period)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: (data && data[0]) ? data[0].content : null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/employees/:id/narrative
 */
router.post('/:id/narrative', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { period_key, narrative } = req.body;
    if (!period_key || !narrative) return res.status(400).json({ error: 'period_key and narrative required' });

    // Upsert by deleting old and inserting new
    await supabase
      .from('employee_notes')
      .delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', req.params.id)
      .eq('note_type', 'narrative_' + period_key);

    const { data, error } = await supabase.from('employee_notes').insert({
      company_id: req.companyId,
      employee_id: parseInt(req.params.id),
      note_type: 'narrative_' + period_key,
      content: typeof narrative === 'string' ? narrative : JSON.stringify(narrative),
      created_by: req.user.userId
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/payroll/employees/:id/narrative?period=YYYY-MM
 */
router.delete('/:id/narrative', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ error: 'period query parameter required' });

    const { error } = await supabase
      .from('employee_notes')
      .delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', req.params.id)
      .eq('note_type', 'narrative_' + period);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION (Director, Contractor, Work Hours Type, UIF Exempt)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/employees/:id/classification
 */
router.get('/:id/classification', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);

    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('id, classification, is_director, is_contractor, employment_type')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied' });

    const { data: payrollSetup } = await supabase
      .from('employee_payroll_setup')
      .select('uif_exempt')
      .eq('employee_id', empId)
      .eq('company_id', req.companyId)
      .single();

    res.json({
      classification: {
        is_director:     emp.is_director    || false,
        is_contractor:   emp.is_contractor  || false,
        uif_exempt:      payrollSetup?.uif_exempt || false,
        employment_type: emp.employment_type || 'full_time',
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/employees/:id/classification
 * Body: { is_director, is_contractor, uif_exempt, employment_type }
 */
router.put('/:id/classification', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const { is_director, is_contractor, uif_exempt, employment_type } = req.body;

    const { data: emp } = await supabase
      .from('employees')
      .select('id, classification, is_director, is_contractor')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied' });

    // Update employees table
    const empUpdates = { updated_at: new Date().toISOString() };
    if (is_director   !== undefined) empUpdates.is_director   = is_director;
    if (is_contractor !== undefined) empUpdates.is_contractor = is_contractor;
    if (employment_type !== undefined) empUpdates.employment_type = employment_type;

    const { error: empErr } = await supabase
      .from('employees')
      .update(empUpdates)
      .eq('id', empId)
      .eq('company_id', req.companyId);

    if (empErr) return res.status(500).json({ error: empErr.message });

    // Upsert uif_exempt in employee_payroll_setup
    if (uif_exempt !== undefined) {
      const { error: psErr } = await supabase
        .from('employee_payroll_setup')
        .upsert({
          employee_id: empId,
          company_id:  req.companyId,
          uif_exempt,
          updated_at:  new Date().toISOString()
        }, { onConflict: 'employee_id,company_id' });

      if (psErr) return res.status(500).json({ error: psErr.message });
    }

    await auditFromReq(req, 'UPDATE', 'employee_classification', empId, {
      module: 'payroll',
      newValue: { is_director, is_contractor, uif_exempt, employment_type }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORK SCHEDULE (Regular Hours)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_WORKING_DAYS = [
  { day: 'mon', enabled: true,  type: 'normal', partial_hours: null },
  { day: 'tue', enabled: true,  type: 'normal', partial_hours: null },
  { day: 'wed', enabled: true,  type: 'normal', partial_hours: null },
  { day: 'thu', enabled: true,  type: 'normal', partial_hours: null },
  { day: 'fri', enabled: true,  type: 'normal', partial_hours: null },
  { day: 'sat', enabled: false, type: 'normal', partial_hours: null },
  { day: 'sun', enabled: false, type: 'normal', partial_hours: null },
];

function calcFullDaysPerWeek(workingDays, hoursPerDay) {
  if (!hoursPerDay || hoursPerDay <= 0) return 0;
  return workingDays.reduce((sum, d) => {
    if (!d.enabled) return sum;
    if (d.type === 'partial' && d.partial_hours != null) {
      return sum + (d.partial_hours / hoursPerDay);
    }
    return sum + 1;
  }, 0);
}

/**
 * GET /api/payroll/employees/:id/work-schedule
 */
router.get('/:id/work-schedule', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);

    const { data: emp, error: empErr } = await supabase
      .from('employees')
      .select('id, classification')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (empErr && empErr.code !== 'PGRST116') {
      console.error('[work-schedule GET] employees query error:', empErr);
    }
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied' });

    // maybeSingle() — employee may not have a work schedule row yet; returns null without error
    const { data, error: wsErr } = await supabase
      .from('employee_work_schedule')
      .select('*')
      .eq('employee_id', empId)
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (wsErr) {
      console.error('[work-schedule GET] employee_work_schedule query error:', wsErr);
    }

    res.json({
      work_schedule: data || {
        is_hourly_paid:     false,
        hours_per_day:      8.0,
        schedule_type:      'fixed',
        working_days:       DEFAULT_WORKING_DAYS,
        full_days_per_week: 5.0,
      }
    });
  } catch (err) {
    console.error('[work-schedule GET] unhandled exception:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

/**
 * PUT /api/payroll/employees/:id/work-schedule
 * Body: { is_hourly_paid, hours_per_day, schedule_type, working_days }
 */
router.put('/:id/work-schedule', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const { is_hourly_paid, hours_per_day, schedule_type, working_days } = req.body;

    const { data: emp } = await supabase
      .from('employees')
      .select('id, classification')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied' });

    const days = working_days || DEFAULT_WORKING_DAYS;
    const hpd  = parseFloat(hours_per_day) || 8.0;
    const fdpw = Math.round(calcFullDaysPerWeek(days, hpd) * 1000) / 1000;

    const { error } = await supabase
      .from('employee_work_schedule')
      .upsert({
        employee_id:        empId,
        company_id:         req.companyId,
        is_hourly_paid:     is_hourly_paid || false,
        hours_per_day:      hpd,
        schedule_type:      schedule_type || 'fixed',
        working_days:       days,
        full_days_per_week: fdpw,
        updated_at:         new Date().toISOString()
      }, { onConflict: 'employee_id,company_id' });

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'employee_work_schedule', empId, {
      module: 'payroll',
      newValue: { is_hourly_paid, hours_per_day: hpd, schedule_type, full_days_per_week: fdpw }
    });

    res.json({ success: true, full_days_per_week: fdpw });
  } catch (err) {
    console.error('[work-schedule PUT] unhandled exception:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ETI (Employment Tax Incentive)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/employees/:id/eti
 */
router.get('/:id/eti', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);

    const { data: emp } = await supabase
      .from('employees')
      .select('id, classification')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied' });

    const { data } = await supabase
      .from('employee_eti')
      .select('*')
      .eq('employee_id', empId)
      .eq('company_id', req.companyId)
      .single();

    res.json({
      eti: data || {
        status:                   'qualified_not_claiming',
        min_wage_input_type:      'company_setup',
        min_wage_amount:          null,
        original_employment_date: null,
        disqualified_months_before: 0,
        sez_post_march_2019:      false,
        sez_pre_march_2019:       false,
        effective_date:           new Date().toISOString().split('T')[0],
        history:                  [],
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/employees/:id/eti
 * Body: { status, min_wage_input_type, min_wage_amount, original_employment_date,
 *         disqualified_months_before, sez_post_march_2019, sez_pre_march_2019, effective_date }
 * Automatically records a history entry when status changes.
 */
router.put('/:id/eti', requirePermission('PAYROLL.CREATE'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const {
      status, min_wage_input_type, min_wage_amount,
      original_employment_date, disqualified_months_before,
      sez_post_march_2019, sez_pre_march_2019, effective_date
    } = req.body;

    const { data: emp } = await supabase
      .from('employees')
      .select('id, classification')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const visible = await canViewEmployee(req.user.role, req.user.userId, req.companyId, emp);
    if (!visible) return res.status(403).json({ error: 'Access denied' });

    // Load existing record to build history entry
    const { data: existing } = await supabase
      .from('employee_eti')
      .select('*')
      .eq('employee_id', empId)
      .eq('company_id', req.companyId)
      .single();

    const existingHistory = existing?.history || [];
    const changes = {};

    if (status !== undefined && status !== existing?.status) {
      changes.status = { from: existing?.status || null, to: status };
    }

    // Only append history when status changes
    const newHistory = Object.keys(changes).length > 0
      ? [...existingHistory, {
          effective_date: effective_date || new Date().toISOString().split('T')[0],
          changes,
          recorded_at: new Date().toISOString(),
          recorded_by: req.user.userId
        }]
      : existingHistory;

    const payload = {
      employee_id:               empId,
      company_id:                req.companyId,
      status:                    status                    ?? existing?.status                    ?? 'qualified_not_claiming',
      min_wage_input_type:       min_wage_input_type       ?? existing?.min_wage_input_type       ?? 'company_setup',
      min_wage_amount:           min_wage_amount           ?? existing?.min_wage_amount           ?? null,
      original_employment_date:  original_employment_date  ?? existing?.original_employment_date  ?? null,
      disqualified_months_before: disqualified_months_before ?? existing?.disqualified_months_before ?? 0,
      sez_post_march_2019:       sez_post_march_2019       ?? existing?.sez_post_march_2019       ?? false,
      sez_pre_march_2019:        sez_pre_march_2019        ?? existing?.sez_pre_march_2019        ?? false,
      effective_date:            effective_date            ?? existing?.effective_date            ?? new Date().toISOString().split('T')[0],
      history:                   newHistory,
      updated_at:                new Date().toISOString()
    };

    const { error } = await supabase
      .from('employee_eti')
      .upsert(payload, { onConflict: 'employee_id,company_id' });

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'employee_eti', empId, {
      module: 'payroll',
      newValue: { status, min_wage_input_type, effective_date }
    });

    res.json({ success: true, history: newHistory });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
