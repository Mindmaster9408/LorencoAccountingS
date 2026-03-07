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

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/payroll/employees
 * Get employees with their payroll-specific data
 */
router.get('/', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { data: employees, error } = await supabase
      .from('employees')
      .select('*, employee_bank_details(*)')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('full_name');

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
router.get('/:id', requirePermission('PAYROLL.VIEW'), async (req, res) => {
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
    res.json({ employee: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/employees/:id/salary
 * Update salary information
 */
router.put('/:id/salary', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { basic_salary, hourly_rate, payment_frequency } = req.body;

    const { data: old } = await supabase
      .from('employees')
      .select('basic_salary, hourly_rate, payment_frequency')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!old) return res.status(404).json({ error: 'Employee not found' });

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
router.put('/:id/bank-details', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const empId = req.params.id;
    const { bank_name, account_number, branch_code, account_type } = req.body;

    // Verify employee belongs to company
    const { data: emp } = await supabase
      .from('employees')
      .select('id')
      .eq('id', empId)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

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
router.get('/:id/historical', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
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

module.exports = router;
