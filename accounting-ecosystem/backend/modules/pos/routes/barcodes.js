/**
 * ============================================================================
 * POS Barcode Routes - Checkout Charlie Module
 * ============================================================================
 * Barcode checking, generation, and EAN-13 support.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();

router.use(requireCompany);

/**
 * Calculate EAN-13 check digit
 */
function ean13CheckDigit(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * POST /api/barcode/check/:barcode
 * Check if a barcode already exists in the company's products
 */
router.post('/check/:barcode', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, barcode, is_active')
      .eq('company_id', req.companyId)
      .eq('barcode', req.params.barcode)
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });

    if (data && data.length > 0) {
      res.json({ exists: true, product: data[0] });
    } else {
      res.json({ exists: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/barcode/generate
 * Generate a new unique barcode for the company
 */
// Found live 2026-08-01 (site-wide permission sweep) — mutates the
// company's shared barcode sequence with no gate at all. Its only caller,
// generateBarcode() (frontend-pos/index.html), is reached solely from the
// Products settings form, already management-only since Settings was
// restricted earlier the same day — so this can't regress any cashier
// flow. /check/:barcode (above) is left untouched — same caller context,
// but read-only, no state to protect.
router.post('/generate', requirePermission('PRODUCTS.CREATE'), async (req, res) => {
  try {
    const { type } = req.body;

    // Get or create barcode settings
    let { data: settings } = await supabase
      .from('barcode_settings')
      .select('*')
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!settings) {
      const { data: newSettings, error: createError } = await supabase
        .from('barcode_settings')
        .insert({
          company_id: req.companyId,
          company_prefix: '600',
          current_sequence: 1000,
          barcode_type: 'EAN13'
        })
        .select()
        .single();

      if (createError) return res.status(500).json({ error: createError.message });
      settings = newSettings;
    }

    const prefix = settings.company_prefix || '600';
    const sequence = settings.current_sequence || 1000;
    const digits12 = (prefix + String(sequence).padStart(12 - prefix.length, '0')).slice(0, 12);
    const checkDigit = ean13CheckDigit(digits12);
    const barcode = digits12 + checkDigit;

    // Increment sequence
    await supabase
      .from('barcode_settings')
      .update({
        current_sequence: sequence + 1,
        last_generated: barcode,
        updated_at: new Date().toISOString()
      })
      .eq('company_id', req.companyId);

    res.json({ barcode, type: type || 'EAN13' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
