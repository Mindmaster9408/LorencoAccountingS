/**
 * ============================================================================
 * Feature Flag Service — Lorenco Ecosystem
 * ============================================================================
 * Centralised, database-backed feature flag system for safe, gradual rollout.
 *
 * Rollout levels (in order of increasing exposure):
 *   disabled        — completely off for everyone
 *   superuser       — only isSuperAdmin users
 *   test_client     — superusers + companies listed in allowed_company_ids
 *   selected_clients — superusers + a broader explicit list of companies
 *   all             — fully rolled out to all companies
 *
 * Usage (backend route):
 *   const { featureFlags } = require('../../services/featureFlags');
 *   const enabled = await featureFlags.isEnabled('PAYTIME_NEW_PAYSLIP_UI', req);
 *
 * Usage (middleware — blocks route entirely if flag is off):
 *   const { requireFeatureFlag } = require('../../services/featureFlags');
 *   router.get('/new-payslip', requireFeatureFlag('PAYTIME_NEW_PAYSLIP_UI'), handler);
 *
 * Flags are cached in memory for CACHE_TTL_MS to avoid DB hits on every request.
 * Call featureFlags.invalidateCache() after any flag mutation.
 * ============================================================================
 */

const { supabase } = require('../config/database');

// Cache TTL — 2 minutes in production, instant in test
const CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 2 * 60 * 1000;

class FeatureFlagService {
  constructor() {
    this._cache = new Map();       // flagKey → { flag, expiresAt }
    this._allCachedAt = null;      // timestamp of last full-list cache
    this._allFlags = null;         // full list cache
  }

  // ── Low-level DB fetch ──────────────────────────────────────────────────────

  async _fetchFlag(flagKey) {
    const { data, error } = await supabase
      .from('feature_flags')
      .select('*')
      .eq('flag_key', flagKey)
      .maybeSingle();

    if (error) {
      console.error('[FeatureFlags] DB error fetching flag:', flagKey, error.message);
      return null;
    }
    return data;
  }

  async _fetchAllFlags() {
    const { data, error } = await supabase
      .from('feature_flags')
      .select('*')
      .order('app')
      .order('flag_key');

    if (error) {
      console.error('[FeatureFlags] DB error fetching all flags:', error.message);
      return [];
    }
    return data || [];
  }

  // ── Cache management ───────────────────────────────────────────────────────

  _getCached(flagKey) {
    const entry = this._cache.get(flagKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(flagKey);
      return null;
    }
    return entry.flag;
  }

  _setCache(flag) {
    this._cache.set(flag.flag_key, {
      flag,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
  }

  /** Invalidate all cached flags. Call after any flag create/update/delete. */
  invalidateCache() {
    this._cache.clear();
    this._allCachedAt = null;
    this._allFlags = null;
  }

  // ── Core evaluation ────────────────────────────────────────────────────────

  /**
   * Check whether a feature flag is enabled for the given request context.
   *
   * @param {string} flagKey - The flag identifier, e.g. 'PAYTIME_NEW_PAYSLIP_UI'
   * @param {object} context - { companyId, isSuperAdmin }
   *                           (pass req directly or a plain object)
   * @returns {Promise<boolean>}
   */
  async isEnabled(flagKey, context = {}) {
    const companyId   = context.companyId   ?? context.user?.companyId   ?? null;
    const isSuperAdmin = context.isSuperAdmin ?? context.user?.isSuperAdmin ?? false;

    // Super admins always see all features regardless of flag state.
    // This is intentional: super admins are the first testers.
    // If you need to hide something even from super admins, set is_active=false.
    if (isSuperAdmin) return true;

    // Fetch from cache or DB
    let flag = this._getCached(flagKey);
    if (!flag) {
      flag = await this._fetchFlag(flagKey);
      if (flag) this._setCache(flag);
    }

    // Unknown flag → disabled
    if (!flag) return false;

    // Inactive flag → disabled for everyone (including test clients)
    if (!flag.is_active) return false;

    return this._evaluate(flag, { companyId, isSuperAdmin });
  }

  /**
   * Evaluate a flag object against context. Flag must be active (is_active=true).
   * @private
   */
  _evaluate(flag, { companyId, isSuperAdmin }) {
    switch (flag.rollout_level) {
      case 'disabled':
        return false;

      case 'superuser':
        // Only super admins — already handled above but kept for directness
        return isSuperAdmin === true;

      case 'test_client': {
        // Superusers + companies in allowed_company_ids[]
        if (isSuperAdmin) return true;
        const allowed = Array.isArray(flag.allowed_company_ids) ? flag.allowed_company_ids : [];
        return allowed.map(Number).includes(Number(companyId));
      }

      case 'selected_clients': {
        // Superusers + explicit company list (broader than test_client)
        if (isSuperAdmin) return true;
        const allowed = Array.isArray(flag.allowed_company_ids) ? flag.allowed_company_ids : [];
        return allowed.map(Number).includes(Number(companyId));
      }

      case 'all':
        // Full rollout — available to all authenticated users
        return true;

      default:
        return false;
    }
  }

  // ── Admin operations ───────────────────────────────────────────────────────

  /**
   * List all feature flags. Results are cached briefly for list views.
   */
  async listFlags(app = null) {
    const now = Date.now();
    if (this._allFlags && this._allCachedAt && (now - this._allCachedAt) < CACHE_TTL_MS) {
      return app ? this._allFlags.filter(f => f.app === app) : this._allFlags;
    }
    const flags = await this._fetchAllFlags();
    this._allFlags = flags;
    this._allCachedAt = now;
    return app ? flags.filter(f => f.app === app) : flags;
  }

  /**
   * Create a new feature flag.
   * @param {object} data - { flag_key, display_name, description, app, rollout_level, allowed_company_ids }
   * @param {number} updatedBy - user ID of creator
   */
  async createFlag(data, updatedBy) {
    const payload = {
      flag_key:            data.flag_key.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      display_name:        data.display_name,
      description:         data.description || null,
      app:                 data.app || 'global',
      is_active:           data.is_active !== undefined ? Boolean(data.is_active) : false,
      rollout_level:       data.rollout_level || 'disabled',
      allowed_company_ids: Array.isArray(data.allowed_company_ids) ? data.allowed_company_ids : [],
      updated_by:          updatedBy || null,
      updated_at:          new Date().toISOString()
    };

    const { data: created, error } = await supabase
      .from('feature_flags')
      .insert(payload)
      .select()
      .single();

    if (error) throw new Error('Failed to create feature flag: ' + error.message);
    this.invalidateCache();
    return created;
  }

  /**
   * Update an existing feature flag.
   * @param {string} flagKey
   * @param {object} updates - partial { display_name, description, is_active, rollout_level, allowed_company_ids }
   * @param {number} updatedBy - user ID of updater
   */
  async updateFlag(flagKey, updates, updatedBy) {
    const payload = { updated_at: new Date().toISOString(), updated_by: updatedBy || null };

    if (updates.display_name   !== undefined) payload.display_name   = updates.display_name;
    if (updates.description    !== undefined) payload.description    = updates.description;
    if (updates.is_active      !== undefined) payload.is_active      = Boolean(updates.is_active);
    if (updates.rollout_level  !== undefined) payload.rollout_level  = updates.rollout_level;
    if (updates.app            !== undefined) payload.app            = updates.app;
    if (updates.allowed_company_ids !== undefined) {
      payload.allowed_company_ids = Array.isArray(updates.allowed_company_ids)
        ? updates.allowed_company_ids
        : [];
    }

    const { data: updated, error } = await supabase
      .from('feature_flags')
      .update(payload)
      .eq('flag_key', flagKey.toUpperCase())
      .select()
      .single();

    if (error) throw new Error('Failed to update feature flag: ' + error.message);
    this.invalidateCache();
    return updated;
  }

  /**
   * Delete a feature flag.
   */
  async deleteFlag(flagKey) {
    const { error } = await supabase
      .from('feature_flags')
      .delete()
      .eq('flag_key', flagKey.toUpperCase());

    if (error) throw new Error('Failed to delete feature flag: ' + error.message);
    this.invalidateCache();
  }

  /**
   * Get a single flag by key (admin view, no evaluation).
   */
  async getFlag(flagKey) {
    return await this._fetchFlag(flagKey.toUpperCase());
  }

  /**
   * Convenience: return a summary object for the frontend
   * showing which flags are enabled for the current context.
   */
  async getEnabledFlagsForContext(context = {}) {
    const allFlags = await this.listFlags();
    const results = {};
    for (const flag of allFlags) {
      results[flag.flag_key] = flag.is_active && this._evaluate(flag, {
        companyId:   context.companyId ?? null,
        isSuperAdmin: context.isSuperAdmin ?? false
      });
    }
    return results;
  }
}

// Singleton instance shared across the process
const featureFlags = new FeatureFlagService();

/**
 * Express middleware — blocks route if flag is not enabled for current user/company.
 * Returns 404 (not 403) intentionally: behaves as if the feature doesn't exist yet.
 *
 * Usage:
 *   router.get('/new-payslip', requireFeatureFlag('PAYTIME_NEW_PAYSLIP_UI'), handler);
 */
function requireFeatureFlag(flagKey) {
  return async (req, res, next) => {
    try {
      const context = {
        companyId:    req.companyId    || req.user?.companyId    || null,
        isSuperAdmin: req.user?.isSuperAdmin ?? false
      };
      const enabled = await featureFlags.isEnabled(flagKey, context);
      if (!enabled) {
        return res.status(404).json({ error: 'Feature not available' });
      }
      next();
    } catch (err) {
      console.error('[FeatureFlags] requireFeatureFlag error:', err.message);
      // Fail closed — if flag service is broken, deny access
      return res.status(503).json({ error: 'Feature flag service unavailable' });
    }
  };
}

module.exports = { featureFlags, requireFeatureFlag };
