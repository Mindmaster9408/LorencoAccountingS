/**
 * ============================================================================
 * Shared compare-and-swap stock adjustment — company-level products.stock_quantity
 * ============================================================================
 * Extracted from company-transfers.js (Workstream 81) so the exact same
 * primitive is reused by every feature that moves stock between two
 * different companies — company-transfers.js itself and, as of Workstream 87,
 * the Purchase Order delivery engine — rather than each maintaining its own
 * copy of this logic ("do not duplicate stock movement logic").
 *
 * Read current value, then UPDATE ... WHERE stock_quantity = <value read>,
 * so a concurrent change to the same product between read and write causes
 * the write to affect zero rows rather than silently overwriting it.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

/**
 * @returns {Promise<{ok:true, oldQty, newQty, product}|{ok:false, error, product?, oldQty?}>}
 */
async function adjustStockCAS(companyId, productId, delta, { allowNegative = false } = {}) {
  const { data: product } = await supabase
    .from('products').select('id, product_name, stock_quantity')
    .eq('id', productId).eq('company_id', companyId).single();
  if (!product) return { ok: false, error: 'Product not found' };

  const oldQty = parseFloat(product.stock_quantity || 0);
  const newQty = oldQty + delta;
  if (delta < 0 && newQty < 0 && !allowNegative) {
    return { ok: false, error: 'insufficient_stock', product, oldQty };
  }

  const { data: updated, error } = await supabase
    .from('products')
    .update({ stock_quantity: newQty, updated_at: new Date().toISOString() })
    .eq('id', productId).eq('company_id', companyId).eq('stock_quantity', oldQty)
    .select().maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: 'concurrent_update', product, oldQty };

  return { ok: true, oldQty, newQty, product };
}

module.exports = { adjustStockCAS };
