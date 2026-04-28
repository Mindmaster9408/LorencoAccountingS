/**
 * ============================================================================
 * Payroll Transactions & Payslips Routes - Payroll Module
 * ============================================================================
 * Processes individual employee payslips within a pay period.
 * Converted from payroll-engine.js localStorage logic to API.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { getEmployeeFilter, requirePaytimeModule } = require('../services/paytimeAccess');
const PayrollDataService = require('../services/PayrollDataService');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/payroll/transactions
 * List payroll transactions for a period.
 * Applies paytimeAccess visibility filter — restricted users only see their allowed employees.
 */
router.get('/', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), async (req, res) => {
  try {
    const { period_id, employee_id } = req.query;

    // Reject non-integer employee_id (e.g. old localStorage string IDs like "emp-abc123")
    if (employee_id && !/^\d+$/.test(String(employee_id))) {
      return res.json({ transactions: [], data: [], current_inputs: [], overtimes: [] });
    }

    // Resolve which employees this user can see
    const filter = await getEmployeeFilter(req.user.role, req.user.userId, req.companyId);

    let query = supabase
      .from('payroll_transactions')
      .select('*, employees(first_name, last_name, employee_code, classification), payslip_items(*)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });

    if (period_id) query = query.eq('period_id', period_id);
    if (employee_id) query = query.eq('employee_id', parseInt(employee_id));

    // Apply employee scope filter at the transaction level
    if (filter.type === 'ids') {
      if (filter.ids.length === 0) return res.json({ transactions: [] });
      query = query.in('employee_id', filter.ids);
    } else if (filter.type === 'classification') {
      // Filter by joining employees.classification — use inner join via !inner
      // Since Supabase doesn't directly support nested WHERE on joined tables,
      // resolve the visible employee IDs first (classification='public')
      const { data: visibleEmps } = await supabase
        .from('employees')
        .select('id')
        .eq('company_id', req.companyId)
        .eq('classification', 'public')
        .eq('is_active', true);
      const visibleIds = (visibleEmps || []).map(e => e.id);
      if (visibleIds.length === 0) return res.json({ transactions: [] });
      query = query.in('employee_id', visibleIds);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ transactions: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERIOD INPUTS (current inputs, overtime, short-time, multi-rate)
// These must be before /:id to avoid param capture
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/transactions/period-inputs
 * Load all period-specific inputs for display in the payslip UI.
 * Returns overtime, shortTime, currentInputs, multiRate arrays
 * with real DB IDs (used for individual deletes via re-save).
 */
router.get('/period-inputs', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { employee_id, period_key } = req.query;
    if (!employee_id || !period_key) {
      return res.status(400).json({ error: 'employee_id and period_key required' });
    }
    if (!/^\d+$/.test(String(employee_id))) {
      return res.json({ overtime: [], shortTime: [], currentInputs: [], multiRate: [] });
    }

    const { data: period } = await supabase
      .from('payroll_periods').select('id')
      .eq('company_id', req.companyId)
      .eq('period_key', period_key)
      .maybeSingle();

    if (!period) {
      return res.json({ overtime: [], shortTime: [], currentInputs: [], multiRate: [] });
    }

    const empId = parseInt(employee_id);
    const periodId = period.id;

    const [otRes, stRes, ciRes, mrRes] = await Promise.all([
      supabase.from('payroll_overtime')
        .select('id, hours, rate_multiplier, description')
        .eq('company_id', req.companyId).eq('employee_id', empId)
        .eq('payroll_period_id', periodId).eq('is_deleted', false),
      supabase.from('payroll_short_time')
        .select('id, hours_missed, description')
        .eq('company_id', req.companyId).eq('employee_id', empId)
        .eq('payroll_period_id', periodId).eq('is_deleted', false),
      supabase.from('payroll_period_inputs')
        .select('id, description, amount, item_type')
        .eq('company_id', req.companyId).eq('employee_id', empId)
        .eq('payroll_period_id', periodId).eq('is_deleted', false),
      supabase.from('payroll_multi_rate')
        .select('id, hours, rate_multiplier, description')
        .eq('company_id', req.companyId).eq('employee_id', empId)
        .eq('payroll_period_id', periodId).eq('is_deleted', false)
    ]);

    res.json({
      overtime:      otRes.data || [],
      shortTime:     stRes.data || [],
      currentInputs: ciRes.data || [],
      multiRate:     mrRes.data || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/transactions/inputs
 * Save current period inputs for an employee.
 * Replaces the full set for this employee+period (delete-then-insert).
 * Writes to payroll_period_inputs (the table PayrollDataService reads).
 */
router.post('/inputs', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { employee_id, period_key, inputs } = req.body;
    if (!employee_id || !period_key) {
      return res.status(400).json({ error: 'employee_id and period_key required' });
    }

    const period = await PayrollDataService.fetchPeriod(req.companyId, period_key, supabase);
    const periodId = period ? period.id : null;
    if (!periodId) return res.status(404).json({ error: 'Period not found' });

    // Replace the full set for this employee+period
    await supabase.from('payroll_period_inputs').delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', employee_id)
      .eq('payroll_period_id', periodId);

    if (inputs && inputs.length > 0) {
      const records = inputs.map(i => {
        const rawType = i.type || i.input_type || 'earning';
        // Normalize to valid DB enum: only 'deduction' maps to 'deduction'; everything else is 'earning'
        const itemType = rawType === 'deduction' ? 'deduction' : 'earning';
        return {
          company_id: req.companyId,
          payroll_period_id: periodId,
          employee_id: parseInt(employee_id),
          item_type: itemType,
          description: i.description || i.name || '',
          amount: parseFloat(i.amount) || 0,
          is_deleted: false
        };
      });
      const { error } = await supabase.from('payroll_period_inputs').insert(records);
      if (error) return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/transactions/overtime
 * Save overtime entries for an employee in a period.
 * Replaces the full set. Writes to payroll_overtime (the table PayrollDataService reads).
 */
router.post('/overtime', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { employee_id, period_key, entries } = req.body;
    if (!employee_id || !period_key) {
      return res.status(400).json({ error: 'employee_id and period_key required' });
    }

    const period = await PayrollDataService.fetchPeriod(req.companyId, period_key, supabase);
    const periodId = period ? period.id : null;
    if (!periodId) return res.status(404).json({ error: 'Period not found' });

    // Replace full set for this employee+period
    await supabase.from('payroll_overtime').delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', employee_id)
      .eq('payroll_period_id', periodId);

    if (entries && entries.length > 0) {
      const records = entries.map(e => ({
        company_id: req.companyId,
        payroll_period_id: periodId,
        employee_id: parseInt(employee_id),
        hours: parseFloat(e.hours) || 0,
        rate_multiplier: parseFloat(e.rate_multiplier) || 1.5,
        description: e.description || 'Overtime',
        is_deleted: false
      }));
      const { error } = await supabase.from('payroll_overtime').insert(records);
      if (error) return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/transactions/short-time
 * Save short-time entries for an employee in a period.
 * Writes to payroll_short_time (the table PayrollDataService reads).
 */
router.post('/short-time', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { employee_id, period_key, entries } = req.body;
    if (!employee_id || !period_key) {
      return res.status(400).json({ error: 'employee_id and period_key required' });
    }

    const period = await PayrollDataService.fetchPeriod(req.companyId, period_key, supabase);
    const periodId = period ? period.id : null;
    if (!periodId) return res.status(404).json({ error: 'Period not found' });

    await supabase.from('payroll_short_time').delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', employee_id)
      .eq('payroll_period_id', periodId);

    if (entries && entries.length > 0) {
      const records = entries.map(e => ({
        company_id: req.companyId,
        payroll_period_id: periodId,
        employee_id: parseInt(employee_id),
        hours_missed: parseFloat(e.hours_missed || e.hours) || 0,
        description: e.description || e.reason || 'Short time',
        is_deleted: false
      }));
      const { error } = await supabase.from('payroll_short_time').insert(records);
      if (error) return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/transactions/multi-rate
 * Save multi-rate entries for an employee in a period.
 * Writes to payroll_multi_rate (the table PayrollDataService reads).
 */
router.post('/multi-rate', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { employee_id, period_key, entries } = req.body;
    if (!employee_id || !period_key) {
      return res.status(400).json({ error: 'employee_id and period_key required' });
    }

    const period = await PayrollDataService.fetchPeriod(req.companyId, period_key, supabase);
    const periodId = period ? period.id : null;
    if (!periodId) return res.status(404).json({ error: 'Period not found' });

    await supabase.from('payroll_multi_rate').delete()
      .eq('company_id', req.companyId)
      .eq('employee_id', employee_id)
      .eq('payroll_period_id', periodId);

    if (entries && entries.length > 0) {
      const records = entries.map(e => ({
        company_id: req.companyId,
        payroll_period_id: periodId,
        employee_id: parseInt(employee_id),
        hours: parseFloat(e.hours) || 0,
        rate_multiplier: parseFloat(e.rate_multiplier) || 1,
        description: e.description || 'Multi-rate',
        is_deleted: false
      }));
      const { error } = await supabase.from('payroll_multi_rate').insert(records);
      if (error) return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/transactions/status
 * Update payslip status by employee+period
 */
router.put('/status', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { employee_id, period_key, status } = req.body;
    if (!employee_id || !period_key || !status) {
      return res.status(400).json({ error: 'employee_id, period_key, and status required' });
    }

    const { data: period } = await supabase
      .from('payroll_periods').select('id')
      .eq('company_id', req.companyId).eq('period_key', period_key).single();

    if (!period) return res.status(404).json({ error: 'Period not found' });

    const { data, error } = await supabase
      .from('payroll_transactions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('company_id', req.companyId)
      .eq('employee_id', employee_id)
      .eq('period_id', period.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ transaction: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/payroll/transactions/:id
 * Get a specific payroll transaction with all payslip items
 */
router.get('/:id', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payroll_transactions')
      .select('*, employees(full_name, employee_number, email), payslip_items(*)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ transaction: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/transactions
 * Create a payroll transaction (process payslip for an employee in a period)
 *
 * This replaces the localStorage-based payroll engine calculation.
 * The frontend should send calculated values, or this endpoint can calculate.
 */
router.post('/', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const {
      period_id, employee_id,
      basic_salary, gross_pay, net_pay,
      total_earnings, total_deductions,
      paye_tax, uif_employee, uif_employer,
      items, // Array of payslip line items
      notes
    } = req.body;

    if (!period_id || !employee_id) {
      return res.status(400).json({ error: 'period_id and employee_id are required' });
    }

    // Verify employee belongs to company
    const { data: emp } = await supabase
      .from('employees')
      .select('id, full_name, basic_salary')
      .eq('id', employee_id)
      .eq('company_id', req.companyId)
      .single();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const salary = basic_salary || emp.basic_salary || 0;

    // Create transaction
    const { data: txn, error: txnError } = await supabase
      .from('payroll_transactions')
      .insert({
        company_id: req.companyId,
        period_id,
        employee_id,
        basic_salary: salary,
        gross_pay: gross_pay || salary,
        total_earnings: total_earnings || salary,
        total_deductions: total_deductions || 0,
        paye_tax: paye_tax || 0,
        uif_employee: uif_employee || 0,
        uif_employer: uif_employer || 0,
        net_pay: net_pay || salary,
        status: 'draft',
        notes,
        created_by: req.user.userId
      })
      .select()
      .single();

    if (txnError) return res.status(500).json({ error: txnError.message });

    // Insert payslip items
    if (items && items.length > 0) {
      const payslipItems = items.map(item => ({
        transaction_id: txn.id,
        item_code: item.code || item.item_code,
        item_name: item.name || item.item_name,
        item_type: item.type || item.item_type, // 'earning' or 'deduction'
        amount: item.amount,
        is_taxable: item.is_taxable !== false,
        is_recurring: item.is_recurring || false,
        notes: item.notes
      }));

      const { error: itemsError } = await supabase.from('payslip_items').insert(payslipItems);
      if (itemsError) console.error('Error inserting payslip items:', itemsError.message);
    }

    await auditFromReq(req, 'CREATE', 'payroll_transaction', txn.id, {
      module: 'payroll',
      newValue: {
        employee: emp.full_name,
        gross_pay: txn.gross_pay,
        net_pay: txn.net_pay,
      }
    });

    res.status(201).json({ transaction: txn });
  } catch (err) {
    console.error('Create transaction error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/transactions/:id
 * Update payroll transaction
 */
router.put('/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const allowed = [
      'basic_salary', 'gross_pay', 'net_pay', 'total_earnings', 'total_deductions',
      'paye_tax', 'uif_employee', 'uif_employer', 'status', 'notes'
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('payroll_transactions')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Transaction not found' });

    await auditFromReq(req, 'UPDATE', 'payroll_transaction', req.params.id, {
      module: 'payroll', newValue: updates
    });

    res.json({ transaction: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/payroll/transactions/:id
 * Only allowed for draft transactions
 */
router.delete('/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { data: txn } = await supabase
      .from('payroll_transactions')
      .select('status')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft transactions can be deleted' });
    }

    // Delete payslip items first
    await supabase.from('payslip_items').delete().eq('transaction_id', req.params.id);

    // Delete transaction
    const { error } = await supabase
      .from('payroll_transactions')
      .delete()
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'DELETE', 'payroll_transaction', req.params.id, { module: 'payroll' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
