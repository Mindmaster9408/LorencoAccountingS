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
const { clean, idNumberError, taxNumberError } = require('../utils/saIdentity');

const router = express.Router();

/** Does employees.tax_number_pending exist yet (migration 030)? Cached once known. */
let _hasPendingCol = null;
async function hasPendingColumn() {
  if (_hasPendingCol !== null) return _hasPendingCol;
  const { error } = await supabase.from('employees').select('tax_number_pending').limit(1);
  // Only remember "exists": a missing column is re-checked, so migration 030 takes effect without a restart.
  if (!error) _hasPendingCol = true;
  return !error;
}
const NEEDS_030 = '"Not yet registered with SARS" needs database update 030 — fill in the tax number for now.';

/** Name of another ACTIVE employee in this company with the same ID number, or null (WN-04). */
async function findDuplicateId(companyId, idNumber, excludeId) {
  const v = clean(idNumber);
  if (!v) return null;
  let q = supabase.from('employees').select('id, first_name, last_name')
    .eq('company_id', companyId).eq('is_active', true).eq('id_number', v);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q.limit(1);
  const d = (data || [])[0];
  return d ? (`${d.first_name || ''} ${d.last_name || ''}`.trim() || ('#' + d.id)) : null;
}

/**
 * Paytime spec 06 VPA-05: a Target PAYE entry needs a reason (and a valid amount) —
 * enforced here, not only on the screen. Like Fase 10, only NEW or CHANGED entries are
 * checked, so an older entry never blocks saving the rest of the list.
 */
function voluntaryTaxProblems(next, prev) {
  if (next === null) return [];
  if (!Array.isArray(next)) return ['voluntary_tax_config must be a list'];
  const before = {};
  (Array.isArray(prev) ? prev : []).forEach(e => { if (e && e.id != null) before[String(e.id)] = e; });
  const problems = [];
  next.forEach(e => {
    if (!e || e.type !== 'target_paye') return;
    const was = e.id != null ? before[String(e.id)] : null;
    if (was && was.type === 'target_paye' && String(was.target_paye) === String(e.target_paye) &&
        String(was.description || '') === String(e.description || '')) return;   // unchanged
    if (!String(e.description || '').trim()) problems.push('A reason is required for a Target PAYE entry');
    const amt = Number(e.target_paye);
    if (!(amt >= 0) || !isFinite(amt)) problems.push('Target PAYE amount must be zero or more');
  });
  return [...new Set(problems)];
}

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
    // Paytime Fase 10 (spec 03 WN-01/02/03/04): ID or passport required and valid; SARS tax
    // number required and valid unless "not yet registered with SARS" is ticked; no second
    // active employee with the same ID number in this company. Re-activates the tax-number
    // requirement that was switched off for testing on 2026-04-20.
    const taxPending = req.body.tax_number_pending === true;
    if (taxPending && !clean(tax_number) && !(await hasPendingColumn())) return res.status(409).json({ error: NEEDS_030 });
    const problems = [];
    const idErr = idNumberError(id_number);
    if (idErr) problems.push(idErr);
    if (clean(tax_number) || !taxPending) {
      const taxErr = taxNumberError(tax_number);
      if (taxErr) problems.push(taxErr);
    }
    if (problems.length) return res.status(400).json({ error: problems.join('; '), problems });
    const dupe = await findDuplicateId(req.companyId, id_number, null);
    if (dupe) return res.status(409).json({ error: 'Another active employee (' + dupe + ') already has this ID number', code: 'DUPLICATE_ID' });

    const { data, error } = await supabase
      .from('employees')
      .insert({
        company_id: req.companyId,
        first_name,
        last_name,
        email,
        phone,
        employee_code: employee_number || `EMP-${Date.now()}`,
        department,
        position,
        employment_status: employment_status || 'active',
        hire_date: hire_date || new Date().toISOString().split('T')[0],
        hourly_rate: hourly_rate || 0,
        salary: 0,
        tax_number: clean(tax_number) || null,
        id_number: clean(id_number),
        ...(taxPending && await hasPendingColumn() ? { tax_number_pending: true } : {}),
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
      'voluntary_tax_config',
      // "not yet registered with SARS" (migration 030, spec 03 WN-02)
      'tax_number_pending'
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
    // Paytime Fase 10: validate only what changes, so an existing incomplete record can still
    // be edited — but a changed ID / tax number must be valid, and clearing the tax number
    // needs "not yet registered with SARS".
    const problems = [];
    if (updates.id_number !== undefined && clean(updates.id_number) !== clean(old.id_number)) {
      const idErr = idNumberError(updates.id_number);
      if (idErr) problems.push(idErr);
      else {
        updates.id_number = clean(updates.id_number);
        const dupe = await findDuplicateId(req.companyId, updates.id_number, old.id);
        if (dupe) return res.status(409).json({ error: 'Another active employee (' + dupe + ') already has this ID number', code: 'DUPLICATE_ID' });
      }
    }
    const pendingAfter = updates.tax_number_pending !== undefined ? updates.tax_number_pending === true : old.tax_number_pending === true;
    if (updates.tax_number !== undefined && clean(updates.tax_number) !== clean(old.tax_number)) {
      if (clean(updates.tax_number) || !pendingAfter) {
        const taxErr = taxNumberError(updates.tax_number);
        if (taxErr) problems.push(taxErr);
      }
      updates.tax_number = clean(updates.tax_number) || null;
    }
    if (updates.voluntary_tax_config !== undefined) {
      problems.push(...voluntaryTaxProblems(updates.voluntary_tax_config, old.voluntary_tax_config));
    }
    if (problems.length) return res.status(400).json({ error: problems.join('; '), problems });
    if (updates.tax_number) updates.tax_number_pending = false;   // a valid number replaces the flag
    if (updates.tax_number_pending !== undefined && !(await hasPendingColumn())) {
      if (updates.tax_number_pending === true && !clean(updates.tax_number !== undefined ? updates.tax_number : old.tax_number)) {
        return res.status(409).json({ error: NEEDS_030 });
      }
      delete updates.tax_number_pending;
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
module.exports.voluntaryTaxProblems = voluntaryTaxProblems;
