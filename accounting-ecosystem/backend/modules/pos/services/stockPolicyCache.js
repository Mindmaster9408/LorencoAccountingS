/**
 * ============================================================================
 * POS Stock Policy Cache — shared service
 * ============================================================================
 * Caches allow_negative_stock_sales per companyId for 60 seconds.
 *
 * Shared between:
 *   sales.js    — reads via getStockPolicy()
 *   settings.js — invalidates via invalidateStockPolicyCache() after a
 *                 successful PUT /stock-policy upsert
 *
 * Keeping the cache in one module means both routes operate on the same Map
 * instance, so an invalidation in settings.js is immediately visible to the
 * next sale in sales.js within the same Node.js process.
 *
 * Fail-safe: any DB error or missing row returns false (deny negative stock).
 * ============================================================================
 */

const _cache = new Map();
const TTL_MS = 60_000; // 60 seconds

/**
 * Return the cached allow_negative_stock_sales for companyId, fetching from
 * the DB if the cache is cold or expired.
 *
 * @param {number} companyId
 * @param {object} supabase  — caller's supabase client (avoids a separate import)
 * @returns {Promise<boolean>}
 */
async function getStockPolicy(companyId, supabase) {
  const entry = _cache.get(companyId);
  if (entry && (Date.now() - entry.cachedAt) < TTL_MS) {
    return entry.allowNegativeStock;
  }
  try {
    const { data } = await supabase
      .from('company_settings')
      .select('allow_negative_stock_sales')
      .eq('company_id', companyId)
      .maybeSingle();
    const allow = data?.allow_negative_stock_sales ?? false;
    _cache.set(companyId, { allowNegativeStock: allow, cachedAt: Date.now() });
    return allow;
  } catch {
    // Fail safe: deny negative stock on any DB or runtime error.
    // Do NOT cache this result — let the next call retry the DB.
    return false;
  }
}

/**
 * Remove the cached entry for companyId.
 * Call this immediately after a successful allow_negative_stock_sales upsert
 * so the next sale fetches the fresh value from the DB with no TTL delay.
 *
 * @param {number} companyId
 */
function invalidateStockPolicyCache(companyId) {
  _cache.delete(companyId);
}

module.exports = { getStockPolicy, invalidateStockPolicyCache };
