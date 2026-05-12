/**
 * ============================================================================
 * POS Receipts Routes - Checkout Charlie Module
 * ============================================================================
 * Receipt preview, print, deliver, and printer management.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(requireCompany);

/**
 * GET /api/receipts/preview/:saleId
 * Generate receipt preview data for a sale
 */
router.get('/preview/:saleId', async (req, res) => {
  try {
    const { data: sale, error } = await supabase
      .from('sales')
      .select('*, sale_items(*, products(product_name, barcode)), sale_payments(*), customers(name, phone, email)')
      .eq('id', req.params.saleId)
      .eq('company_id', req.companyId)
      .single();

    if (error || !sale) return res.status(404).json({ error: 'Sale not found' });

    // Get company info for receipt header
    const { data: company } = await supabase
      .from('companies')
      .select('company_name, trading_name, vat_number, contact_phone, address')
      .eq('id', req.companyId)
      .single();

    // Get receipt settings
    const { data: settings } = await supabase
      .from('company_settings')
      .select('receipt_header, receipt_footer, vat_rate')
      .eq('company_id', req.companyId)
      .maybeSingle();

    res.json({
      receipt: {
        company: company || {},
        sale,
        items: sale.sale_items || [],
        payments: sale.sale_payments || [],
        customer: sale.customers || null,
        header: settings?.receipt_header || '',
        footer: settings?.receipt_footer || 'Thank you for shopping with us!',
        generated_at: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/receipts/print/:saleId
 * Trigger print for a receipt (returns print-ready data)
 */
router.post('/print/:saleId', async (req, res) => {
  try {
    const { data: sale, error } = await supabase
      .from('sales')
      .select('*, sale_items(*, products(product_name, barcode)), sale_payments(*)')
      .eq('id', req.params.saleId)
      .eq('company_id', req.companyId)
      .single();

    if (error || !sale) return res.status(404).json({ error: 'Sale not found' });

    const { data: company } = await supabase
      .from('companies')
      .select('company_name, trading_name, vat_number, contact_phone, address')
      .eq('id', req.companyId)
      .single();

    posAuditFromReq(req, POS_EVENTS.RECEIPT_PRINTED, {
      saleId:        sale.id,
      tillSessionId: sale.till_session_id || null,
      afterSnapshot: { sale_id: sale.id, receipt_number: sale.receipt_number, total_amount: sale.total_amount },
    });

    res.json({
      success: true,
      printData: {
        company: company || {},
        sale,
        items: sale.sale_items || [],
        payments: sale.sale_payments || [],
        printed_at: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/receipts/deliver/:saleId
 * Send receipt via email/sms
 */
router.post('/deliver/:saleId', async (req, res) => {
  try {
    const { method, destination } = req.body;
    // Placeholder - actual delivery would use email/SMS service
    res.json({
      success: true,
      message: `Receipt delivery via ${method || 'email'} queued`,
      destination
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/receipts/settings
 * Get receipt/printer settings for the company
 */
router.get('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data || { receipt_header: '', receipt_footer: 'Thank you for shopping with us!' } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/receipts/settings
 * Update receipt settings
 */
router.put('/settings', async (req, res) => {
  try {
    const { receipt_header, receipt_footer, receipt_prefix } = req.body;
    const updates = {};
    if (receipt_header !== undefined) updates.receipt_header = receipt_header;
    if (receipt_footer !== undefined) updates.receipt_footer = receipt_footer;
    if (receipt_prefix !== undefined) updates.receipt_prefix = receipt_prefix;
    updates.updated_by_user_id = req.user.userId;

    const { data: existing } = await supabase
      .from('company_settings')
      .select('id')
      .eq('company_id', req.companyId)
      .maybeSingle();

    let data, error;
    if (existing) {
      ({ data, error } = await supabase
        .from('company_settings')
        .update(updates)
        .eq('company_id', req.companyId)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('company_settings')
        .insert({ company_id: req.companyId, ...updates })
        .select()
        .single());
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json({ settings: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/receipts/printers
 * List available printers (stub - hardware dependent)
 */
router.get('/printers', async (req, res) => {
  res.json({ printers: [{ id: 'default', name: 'Default Printer', status: 'ready', type: 'thermal' }] });
});

/**
 * POST /api/receipts/printers/:id/test
 */
router.post('/printers/:id/test', async (req, res) => {
  res.json({ success: true, message: 'Test page sent to printer' });
});

/**
 * PUT /api/receipts/printers/:id
 */
router.put('/printers/:id', async (req, res) => {
  res.json({ success: true, printer: { id: req.params.id, ...req.body } });
});

module.exports = router;
