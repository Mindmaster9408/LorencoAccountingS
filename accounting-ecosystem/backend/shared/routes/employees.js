/**
 * ============================================================================
 * Employee Routes - Unified Ecosystem (Shared)
 * ============================================================================
 * Combined employee management used by both POS and Payroll modules.
 * BUG FIX #2: All queries filter by company_id from JWT token.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/employees
 * List all employees for the current company
 */
router.get('/', requirePermission('EMPLOYEES.VIEW'), async (req, res) => {
  try {
    const companyId = req.companyId;
    const { status, department, search, include_inactive } = req.query;

    let query = supabase
      .from('employees')
      .select('*')
      .eq('company_id', companyId);

    // Default: active employees only. Pass ?include_inactive=true to include terminated/inactive.
    if (include_inactive !== 'true') {
      query = query.eq('is_active', true);
    }

    if (status && status !== 'all') {
      query = query.eq('employment_status', status);
    }
    if (department) {
      query = query.eq('department', department);
    }
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,employee_code.ilike.%${search}%,email.ilike.%${search}%`);
    }

    query = query.order('last_name');

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Alias employee_code → employee_number so all frontend consumers use consistent field name
    // Alias hire_date → date_appointed for employee-detail.html compatibility
    const employees = (data || []).map(emp => ({
      ...emp,
      employee_number: emp.employee_number || emp.employee_code || '',
      date_appointed: emp.date_appointed || emp.hire_date || null
    }));

    res.json({ employees });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/employees/:id
 */
router.get('/:id', requirePermission('EMPLOYEES.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Employee not found' });
    res.json({ employee: { ...data, employee_number: data.employee_number || data.employee_code || '', date_appointed: data.date_appointed || data.hire_date || null } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/employees
 * Create a new employee
 */
router.post('/', requirePermission('EMPLOYEES.CREATE'), async (req, res) => {
  try {
    const {
      first_name, last_name, email, phone, id_number, employee_number,
      department, position, employment_status, hire_date,
      hourly_rate, tax_number
    } = req.body;

    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'first_name and last_name are required' });
    }
    // TAX NUMBER REQUIRED — DEACTIVATED FOR TESTING (2026-04-20) — RE-ACTIVATE: uncomment the block below
    // if (!tax_number) {
    //   return res.status(400).json({ error: 'tax_number is required — all employees must have a SARS tax reference number for PAYE compliance' });
    // }

    const { data, error } = await supabase
      .from('employees')
      .insert({
        company_id: req.companyId,
        first_name,
        last_name,
        email,
        phone,
        id_number,
        employee_code: employee_number || `EMP-${Date.now()}`,
        department,
        position,
        employment_status: employment_status || 'active',
        hire_date: hire_date || new Date().toISOString().split('T')[0],
        hourly_rate: hourly_rate || 0,
        salary: 0,
        tax_number,
        is_active: true
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'CREATE', 'employee', data.id, { newValue: data });
    res.status(201).json({ employee: { ...data, employee_number: data.employee_number || data.employee_code || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/employees/:id
 */
router.put('/:id', requirePermission('EMPLOYEES.EDIT'), async (req, res) => {
  try {
    const id = req.params.id;

    // Get old data for audit
    const { data: old } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', req.companyId)
      .single();

    if (!old) return res.status(404).json({ error: 'Employee not found' });

    const allowed = [
      'first_name', 'last_name', 'email', 'phone', 'id_number',
      'department', 'position', 'employment_status', 'hire_date', 'termination_date',
      'hourly_rate', 'salary', 'tax_number', 'is_active',
      // Payroll-detail fields added by payroll-schema.js auto-migration
      'job_title', 'payment_method', 'medical_aid_members', 'tax_directive',
      'basic_salary', 'bank_name', 'account_holder', 'account_number', 'branch_code',
      // Voluntary PAYE over-deduction config (migration 012)
      'voluntary_tax_config'
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    // Map employee_number → employee_code (DB column name)
    if (req.body.employee_number !== undefined) updates.employee_code = req.body.employee_number;
    // Frontend uses date_appointed; DB column is hire_date — always map when present
    if (req.body.date_appointed !== undefined) {
      updates.hire_date = req.body.date_appointed || null;
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'employee', id, { oldValue: old, newValue: data });
    res.json({ employee: { ...data, employee_number: data.employee_number || data.employee_code || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/employees/:id/end-service
 * End of Service — marks employee inactive with a termination date and optional reason.
 * Preserves all payroll history. Employee is excluded from future active payroll runs
 * because GET /employees now defaults to is_active=true.
 *
 * Body: { termination_date, termination_reason? }
 */
router.post('/:id/end-service', requirePermission('EMPLOYEES.DELETE'), async (req, res) => {
  try {
    const empId = req.params.id;
    const { termination_date, termination_reason } = req.body;

    if (!termination_date) {
      return res.status(400).json({ error: 'termination_date is required' });
    }

    // Verify employee belongs to this company and is currently active
    const { data: existing, error: fetchErr } = await supabase
      .from('employees')
      .select('id, first_name, last_name, employee_code, is_active')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (fetchErr || !existing) return res.status(404).json({ error: 'Employee not found' });
    if (!existing.is_active) {
      return res.status(409).json({ error: 'Employee is already inactive' });
    }

    // Set inactive + termination date
    const { data, error } = await supabase
      .from('employees')
      .update({
        is_active:          false,
        employment_status:  'terminated',
        termination_date:   termination_date,
        updated_at:         new Date().toISOString(),
      })
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Store termination reason in employee_notes if provided
    if (termination_reason && termination_reason.trim()) {
      await supabase.from('employee_notes').insert({
        company_id:  req.companyId,
        employee_id: parseInt(empId),
        note_type:   'termination_reason',
        content:     termination_reason.trim(),
        created_by:  req.user.userId,
      });
    }

    const empName = `${existing.first_name || ''} ${existing.last_name || ''}`.trim();
    await auditFromReq(req, 'UPDATE', 'employee', empId, {
      action:           'end_of_service',
      employee_code:    existing.employee_code,
      name:             empName,
      termination_date: termination_date,
    });

    res.json({ success: true, employee: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/employees/:id (soft delete)
 */
router.delete('/:id', requirePermission('EMPLOYEES.DELETE'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('employees')
      .update({
        is_active:         false,
        employment_status: 'terminated',
        termination_date:  new Date().toISOString().split('T')[0],
        updated_at:        new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'employee', req.params.id);
    res.json({ success: true, message: 'Employee deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
