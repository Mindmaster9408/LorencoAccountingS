/**
 * ============================================================================
 * Paytime — Feature Flag Client Utility
 * ============================================================================
 * Checks feature flags from the backend API and caches results per session.
 * Use this to conditionally show/hide new features based on rollout status.
 *
 * Usage:
 *   // Check a single flag (returns boolean):
 *   const newUI = await FeatureFlags.isEnabled('PAYTIME_ENHANCED_PAYSLIP');
 *   if (newUI) showNewPayslipButton();
 *
 *   // Load all flags for current user upfront (batched, one API call):
 *   await FeatureFlags.loadAll();
 *   if (FeatureFlags.get('PAYTIME_BULK_PAYRUN')) enableBulkRun();
 *
 *   // Guard a DOM element (hides if flag is off):
 *   FeatureFlags.guardElement(document.getElementById('newFeatureBtn'), 'PAYTIME_BULK_PAYRUN');
 *
 * Cache: results are kept for the lifetime of the page (cleared on reload).
 * ============================================================================
 */

const FeatureFlags = (() => {
  // In-page cache: flagKey → boolean
  const _cache = {};
  let _loadAllPromise = null;
  let _allLoaded = false;

  function _getToken() {
    return localStorage.getItem('token') || localStorage.getItem('eco_token') || '';
  }

  function _authHeaders() {
    return {
      'Authorization': 'Bearer ' + _getToken(),
      'Content-Type': 'application/json'
    };
  }

  /**
   * Check a single flag via the API.
   * Result is cached in-page — subsequent calls are instant.
   *
   * @param {string} flagKey - e.g. 'PAYTIME_ENHANCED_PAYSLIP'
   * @returns {Promise<boolean>}
   */
  async function isEnabled(flagKey) {
    const key = flagKey.toUpperCase();
    if (key in _cache) return _cache[key];

    try {
      const resp = await fetch(`/api/feature-flags/check/${encodeURIComponent(key)}`, {
        headers: _authHeaders()
      });
      if (!resp.ok) {
        _cache[key] = false;
        return false;
      }
      const data = await resp.json();
      _cache[key] = Boolean(data.enabled);
      return _cache[key];
    } catch (err) {
      console.warn('[FeatureFlags] check failed for', key, '— defaulting to disabled');
      _cache[key] = false;
      return false;
    }
  }

  /**
   * Load ALL flags for the current user in a single API call.
   * Call this once at page load, then use get() for instant lookups.
   *
   * @returns {Promise<void>}
   */
  async function loadAll() {
    if (_allLoaded) return;
    if (_loadAllPromise) return _loadAllPromise;

    _loadAllPromise = (async () => {
      try {
        const resp = await fetch('/api/feature-flags/my-flags', {
          headers: _authHeaders()
        });
        if (resp.ok) {
          const data = await resp.json();
          const flags = data.flags || {};
          for (const [k, v] of Object.entries(flags)) {
            _cache[k.toUpperCase()] = Boolean(v);
          }
          _allLoaded = true;
        }
      } catch (err) {
        console.warn('[FeatureFlags] loadAll failed — all flags default to disabled');
      } finally {
        _loadAllPromise = null;
      }
    })();

    return _loadAllPromise;
  }

  /**
   * Get a flag value from the in-page cache (synchronous, after loadAll()).
   * Returns false if loadAll() hasn't been called or flag is unknown.
   *
   * @param {string} flagKey
   * @returns {boolean}
   */
  function get(flagKey) {
    return _cache[flagKey.toUpperCase()] === true;
  }

  /**
   * Show or hide a DOM element based on a feature flag.
   * Elements are hidden (display:none) when flag is off.
   *
   * @param {HTMLElement|null} element
   * @param {string} flagKey
   * @param {object} [options]
   * @param {string} [options.displayStyle=''] - CSS display value when shown (default: '')
   */
  async function guardElement(element, flagKey, options = {}) {
    if (!element) return;
    const enabled = await isEnabled(flagKey);
    element.style.display = enabled ? (options.displayStyle || '') : 'none';
  }

  /**
   * Guard multiple elements with the same flag at once.
   *
   * @param {HTMLElement[]} elements
   * @param {string} flagKey
   */
  async function guardElements(elements, flagKey) {
    const enabled = await isEnabled(flagKey);
    (elements || []).forEach(el => {
      if (el) el.style.display = enabled ? '' : 'none';
    });
  }

  /**
   * Run a callback only if a flag is enabled.
   * Useful for lazy-initialising a feature section.
   *
   * @param {string} flagKey
   * @param {Function} callback - called with (isEnabled: boolean)
   */
  async function whenEnabled(flagKey, callback) {
    const enabled = await isEnabled(flagKey);
    if (enabled) {
      try { callback(true); } catch (err) { console.error('[FeatureFlags] whenEnabled callback error:', err); }
    }
  }

  return { isEnabled, loadAll, get, guardElement, guardElements, whenEnabled };
})();

// Make available globally for inline script usage
if (typeof window !== 'undefined') {
  window.FeatureFlags = FeatureFlags;
}
