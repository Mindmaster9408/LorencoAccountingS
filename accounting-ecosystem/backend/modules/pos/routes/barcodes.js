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

    // Advance the sequence until it lands on a barcode not already assigned
    // to a product (found live 2026-08-20: the old version trusted
    // current_sequence blindly and could hand out a barcode a product
    // already had — e.g. after a manually-typed barcode landed inside the
    // same numeric range, or the counter was ever reset/restored out of
    // sync with products). Company-scoped, same as /check/:barcode above.
    // Capped so a corrupted counter/runaway loop fails loudly instead of
    // hanging the request.
    let sequence = settings.current_sequence || 1000;
    let barcode;
    const MAX_ATTEMPTS = 1000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const digits12 = (prefix + String(sequence).padStart(12 - prefix.length, '0')).slice(0, 12);
      const checkDigit = ean13CheckDigit(digits12);
      const candidate = digits12 + checkDigit;

      const { data: existing, error: checkError } = await supabase
        .from('products')
        .select('id')
        .eq('company_id', req.companyId)
        .eq('barcode', candidate)
        .limit(1);

      if (checkError) return res.status(500).json({ error: checkError.message });

      if (!existing || existing.length === 0) {
        barcode = candidate;
        break;
      }
      sequence++;
    }

    if (!barcode) {
      return res.status(500).json({ error: 'Could not find an unused barcode — please check barcode_settings for this company.' });
    }

    // Persist the sequence one past the barcode just handed out, so the
    // next call starts searching from there instead of re-checking the
    // same already-assigned values every time.
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
