/**
 * ============================================================================
 * Payroll Items Master Routes - Payroll Module
 * ============================================================================
 * Master list of payroll earning/deduction types per company.
 * Replaces localStorage DataAccess.getPayrollItems().
 *
 * IRP5 code integration:
 *   When a payroll item's irp5_code is created or changed, a Sean learning
 *   event is emitted asynchronously so Sean can build IRP5 mapping intelligence
 *   across clients over time.  The event is fire-and-forget — a failure does
 *   NOT cause the payroll item save to fail.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const IRP5Learning = require('../../../sean/irp5-learning');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * Emit a Sean IRP5 learning event asynchronously (fire-and-forget).
 * Errors are logged but never cause the caller to fail.
 */
function _emitIRP5Event(params) {
  IRP5Learning.recordLearningEvent(params).catch(err => {
    console.error('[Paytime→Sean] IRP5 learning event failed (non-fatal):', err.message);
  });
}

/**
 * GET /api/payroll/items
 */
router.get('/', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { type } = req.query; // 'earning' or 'deduction'

    let query = supabase
      .from('payroll_items_master')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('item_type', { ascending: true })
      .order('name');

    if (type) query = query.eq('item_type', type);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ items: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/items
 */
router.post('/', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { code, name, item_type, is_taxable, is_recurring, default_amount, description, irp5_code, category, tax_treatment, paye_projection_type, affects_uif } = req.body;

    if (!code || !name || !item_type) {
      return res.status(400).json({ error: 'code, name, and item_type are required' });
    }

    // Validate IRP5 code format if supplied
    if (irp5_code && !/^\d{4,6}$/.test(String(irp5_code).trim())) {
      return res.status(400).json({ error: `Invalid IRP5 code format: "${irp5_code}". Expected 4–6 digit SARS code.` });
    }

    // Validate tax_treatment — only meaningful for deductions, must be a known value
    const allowedTaxTreatments = ['net_only', 'pre_tax'];
    if (tax_treatment !== undefined && !allowedTaxTreatments.includes(tax_treatment)) {
      return res.status(400).json({ error: `Invalid tax_treatment: "${tax_treatment}". Must be net_only or pre_tax.` });
    }

    // Validate paye_projection_type
    const allowedProjectionTypes = ['FIXED_RECURRING', 'VARIABLE_AVERAGE', 'ONCE_OFF'];
    if (paye_projection_type !== undefined && !allowedProjectionTypes.includes(paye_projection_type)) {
      return res.status(400).json({ error: `Invalid paye_projection_type: "${paye_projection_type}". Must be FIXED_RECURRING, VARIABLE_AVERAGE, or ONCE_OFF.` });
    }

    const insertPayload = {
      company_id:           req.companyId,
      code,
      name,
      item_type,
      is_taxable:           is_taxable !== false,
      is_recurring:         is_recurring || false,
      default_amount:       default_amount || 0,
      description,
      is_active:            true,
      // tax_treatment: only store for deductions; default net_only for all others
      tax_treatment:        (item_type === 'deduction' && tax_treatment) ? tax_treatment : 'net_only',
      paye_projection_type: allowedProjectionTypes.includes(paye_projection_type) ? paye_projection_type : 'VARIABLE_AVERAGE',
      // affects_uif: default true — only items explicitly set to false are excluded from UIF base.
      // Preserves false correctly; null/undefined treated as true (UIF-applicable).
      affects_uif:          affects_uif === false ? false : true
    };

    if (irp5_code) {
      insertPayload.irp5_code            = String(irp5_code).trim();
      insertPayload.irp5_code_updated_at = new Date().toISOString();
      insertPayload.irp5_code_updated_by = req.user?.userId || null;
    }

    const { data, error } = await supabase
      .from('payroll_items_master')
      .insert(insertPayload)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Emit Sean learning event if an IRP5 code was included at creation
    if (irp5_code && data) {
      _emitIRP5Event({
        companyId:       req.companyId,
        payrollItemId:   data.id,
        payrollItemName: name,
        itemCategory:    category || item_type || null,
        previousIrp5Code: null,
        newIrp5Code:     String(irp5_code).trim(),
        changeType:      'new_item',
        changedBy:       req.user?.userId || null
      });
    }

    res.status(201).json({ item: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/items/:id
 */
router.put('/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const allowed = ['code', 'name', 'item_type', 'is_taxable', 'is_recurring', 'default_amount', 'description', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Handle tax_treatment separately — validate value and only allow known values
    if (req.body.tax_treatment !== undefined) {
      const allowedTaxTreatments = ['net_only', 'pre_tax'];
      if (!allowedTaxTreatments.includes(req.body.tax_treatment)) {
        return res.status(400).json({ error: `Invalid tax_treatment: "${req.body.tax_treatment}". Must be net_only or pre_tax.` });
      }
      updates.tax_treatment = req.body.tax_treatment;
    }

    // Handle paye_projection_type — validate against allowed values
    if (req.body.paye_projection_type !== undefined) {
      const allowedProjectionTypes = ['FIXED_RECURRING', 'VARIABLE_AVERAGE', 'ONCE_OFF'];
      if (!allowedProjectionTypes.includes(req.body.paye_projection_type)) {
        return res.status(400).json({ error: `Invalid paye_projection_type: "${req.body.paye_projection_type}". Must be FIXED_RECURRING, VARIABLE_AVERAGE, or ONCE_OFF.` });
      }
      updates.paye_projection_type = req.body.paye_projection_type;
    }

    // Handle affects_uif — boolean, preserving explicit false correctly.
    // null/undefined = not being changed; false = excluded from UIF; true = included.
    if (req.body.affects_uif !== undefined) {
      updates.affects_uif = req.body.affects_uif === false ? false : true;
    }

    // Handle irp5_code change separately — needs IRP5 code validation + Sean event
    const newIrp5Code = req.body.irp5_code !== undefined
      ? (req.body.irp5_code === '' || req.body.irp5_code === null ? null : String(req.body.irp5_code).trim())
      : undefined;

    if (newIrp5Code !== undefined && newIrp5Code !== null) {
      if (!/^\d{4,6}$/.test(newIrp5Code)) {
        return res.status(400).json({ error: `Invalid IRP5 code format: "${newIrp5Code}". Expected 4–6 digit SARS code.` });
      }
      updates.irp5_code            = newIrp5Code;
      updates.irp5_code_updated_at = new Date().toISOString();
      updates.irp5_code_updated_by = req.user?.userId || null;
    } else if (newIrp5Code === null) {
      // Explicit clear — allowed, but we don't emit a learning event for clearing
      updates.irp5_code            = null;
      updates.irp5_code_updated_at = new Date().toISOString();
      updates.irp5_code_updated_by = req.user?.userId || null;
    }

    // Fetch the current row first so we know the previous irp5_code and item name
    // (needed for Sean event and for validating company ownership)
    const { data: existing, error: fetchError } = await supabase
      .from('payroll_items_master')
      .select('id, company_id, name, irp5_code, item_type, category')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Payroll item not found' });
    }

    const { data, error } = await supabase
      .from('payroll_items_master')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Sync affects_uif (and paye_projection_type if changed) to payroll_items by name.
    // payroll_items is the calculation-time table used by PayrollDataService.
    // When the admin changes affects_uif in the UI, existing payroll_items records
    // for this company + item name must reflect the new value so calculations are correct.
    // Fire-and-forget: failure does not block the master save.
    const itemName = updates.name || existing.name;
    const calcSync = {};
    if (updates.affects_uif       !== undefined) calcSync.affects_uif       = updates.affects_uif;
    if (updates.paye_projection_type !== undefined) calcSync.paye_projection_type = updates.paye_projection_type;
    if (Object.keys(calcSync).length > 0) {
      supabase
        .from('payroll_items')
        .update(calcSync)
        .eq('company_id', req.companyId)
        .ilike('name', itemName)
        .then(() => {})
        .catch(syncErr => {
          console.warn('[Paytime] affects_uif sync to payroll_items failed (non-fatal):', syncErr.message);
        });
    }

    // Emit Sean learning event if irp5_code was added or changed (not cleared)
    if (newIrp5Code && newIrp5Code !== existing.irp5_code) {
      const changeType = !existing.irp5_code ? 'code_added' : 'code_changed';
      _emitIRP5Event({
        companyId:        req.companyId,
        payrollItemId:    existing.id,
        payrollItemName:  updates.name || existing.name,
        itemCategory:     updates.item_type || existing.item_type || null,
        previousIrp5Code: existing.irp5_code || null,
        newIrp5Code,
        changeType,
        changedBy:        req.user?.userId || null
      });
    }

    res.json({ item: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE RECURRING ITEMS — employee_payroll_items table
// These endpoints manage per-employee recurring allowances and deductions.
// Backed by: payroll_items (master) and employee_payroll_items (assignments).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/payroll/items/employee?employee_id=X
 * Fetch all active recurring payroll items assigned to an employee.
 */
router.get('/employee', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { employee_id } = req.query;
    if (!employee_id || !/^\d+$/.test(String(employee_id))) {
      return res.status(400).json({ error: 'employee_id (integer) required' });
    }

    const { data, error } = await supabase
      .from('employee_payroll_items')
      .select(
        `id, payroll_item_id, amount, percentage, item_type,
         payroll_items(id, code, name, item_category, is_taxable, tax_treatment)`
      )
      .eq('company_id', req.companyId)
      .eq('employee_id', parseInt(employee_id))
      .eq('is_active', true)
      .order('created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/payroll/items/employee
 * Assign a recurring payroll item to an employee.
 * Creates a payroll_items master record if one doesn't already exist for this description.
 */
router.post('/employee', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { employee_id, description, item_type, amount, is_percentage, percentage_value, is_variable, is_taxable, paye_projection_type } = req.body;

    if (!employee_id || !description || !item_type) {
      return res.status(400).json({ error: 'employee_id, description, and item_type are required' });
    }
    if (!/^\d+$/.test(String(employee_id))) {
      return res.status(400).json({ error: 'employee_id must be an integer' });
    }

    // Validate paye_projection_type — default VARIABLE_AVERAGE (conservative safe default)
    const allowedProjectionTypes = ['FIXED_RECURRING', 'VARIABLE_AVERAGE', 'ONCE_OFF'];
    const resolvedProjectionType = allowedProjectionTypes.includes(paye_projection_type) ? paye_projection_type : 'VARIABLE_AVERAGE';

    // Map frontend item_type ('allowance', 'income', 'benefit', 'other', 'deduction')
    // to DB item_type ('earning', 'deduction', 'company_contribution')
    const dbItemType = item_type === 'deduction' ? 'deduction' : 'earning';

    // Look up affects_uif from payroll_items_master (the config-side table managed by the UI).
    // This ensures the calculation-side payroll_items record inherits the correct UIF flag
    // at creation time, and stays in sync when items are reassigned.
    // Best-effort: failure defaults to true (UIF-applicable) — safe conservative default.
    let resolvedAffectsUif = true;
    try {
      const { data: masterConfig } = await supabase
        .from('payroll_items_master')
        .select('affects_uif')
        .eq('company_id', req.companyId)
        .ilike('name', description)
        .maybeSingle();
      if (masterConfig && masterConfig.affects_uif === false) {
        resolvedAffectsUif = false;
      }
    } catch (_) { /* defaults to true */ }

    // Find an existing payroll_items master record for this company + description
    let masterItemId = null;
    const { data: existingMaster } = await supabase
      .from('payroll_items')
      .select('id')
      .eq('company_id', req.companyId)
      .ilike('name', description)
      .maybeSingle();

    if (existingMaster) {
      masterItemId = existingMaster.id;
      // Sync affects_uif and paye_projection_type from the master config into the
      // calculation record — ensures future calculations use the correct flags.
      const syncUpdates = { affects_uif: resolvedAffectsUif };
      if (paye_projection_type && allowedProjectionTypes.includes(paye_projection_type)) {
        syncUpdates.paye_projection_type = resolvedProjectionType;
      }
      await supabase
        .from('payroll_items')
        .update(syncUpdates)
        .eq('id', existingMaster.id)
        .eq('company_id', req.companyId);
    } else {
      // Generate a URL-safe code from the description
      const baseCode = description.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 45) || 'item';

      const tryInsert = async (code) => {
        return supabase
          .from('payroll_items')
          .insert({
            company_id:           req.companyId,
            code,
            name:                 description,
            item_type:            dbItemType,
            item_category:        item_type,
            is_taxable:           is_taxable !== false,
            is_recurring:         true,
            paye_projection_type: resolvedProjectionType,
            affects_uif:          resolvedAffectsUif
          })
          .select('id')
          .single();
      };

      let { data: created, error: createErr } = await tryInsert(baseCode);
      if (createErr && createErr.code === '23505') {
        // Unique code collision — add a numeric suffix
        const { data: c2, error: e2 } = await tryInsert(baseCode + '_' + Date.now().toString().slice(-6));
        if (e2) return res.status(500).json({ error: e2.message });
        created = c2;
      } else if (createErr) {
        return res.status(500).json({ error: createErr.message });
      }
      masterItemId = created.id;
    }

    // Build insert payload for employee_payroll_items
    const insertPayload = {
      company_id:      req.companyId,
      employee_id:     parseInt(employee_id),
      payroll_item_id: masterItemId,
      item_type:       dbItemType,
      is_active:       true
    };

    if (is_percentage) {
      insertPayload.percentage = parseFloat(percentage_value) || 0;
    } else if (!is_variable) {
      insertPayload.amount = parseFloat(amount) || 0;
    }
    // is_variable items leave both amount and percentage as null
    // so the user can enter the amount each period in the UI

    const { data: empItem, error: empErr } = await supabase
      .from('employee_payroll_items')
      .insert(insertPayload)
      .select()
      .single();

    if (empErr) return res.status(500).json({ error: empErr.message });
    res.status(201).json({ item: empItem });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/payroll/items/employee/:id
 * Update the amount or percentage of an employee recurring item.
 */
router.put('/employee/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { amount, percentage_value } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (amount !== undefined) updates.amount = parseFloat(amount) || 0;
    if (percentage_value !== undefined) updates.percentage = parseFloat(percentage_value) || 0;

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('employee_payroll_items')
      .update(updates)
      .eq('id', parseInt(req.params.id))
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/payroll/items/employee/:id
 * Soft-delete an employee recurring item (sets is_active = false).
 */
router.delete('/employee/:id', requirePermission('PAYROLL.CREATE'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('employee_payroll_items')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', parseInt(req.params.id))
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
