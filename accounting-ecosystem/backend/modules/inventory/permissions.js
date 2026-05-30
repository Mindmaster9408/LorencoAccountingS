'use strict';

/**
 * ============================================================================
 * Inventory Module — Centralized Permission Constants (Codebox 11)
 * ============================================================================
 *
 * Single source of truth for permission strings used across all inventory
 * route files. Prevents typos and makes refactoring safe.
 *
 * Usage in route files:
 *   const { requirePerm, PERM } = require('../permissions');
 *   router.post('/:id/approve', requirePerm(PERM.PO_APPROVE), handler);
 *
 * All permissions map to INVENTORY.* entries in backend/config/permissions.js.
 * Role assignments live there — not here.
 *
 * Hard rules:
 *   - No role names hardcoded here
 *   - No business logic here — this is constants + middleware binding only
 *   - Backend permission check is ALWAYS authoritative
 *   - Frontend visibility is UX only — never security
 * ============================================================================
 */

const { requirePermission } = require('../../middleware/auth');

// Permission string constants — map to PERMISSIONS.INVENTORY.* in config
const PERM = Object.freeze({
  VIEW:              'INVENTORY.VIEW',
  RECEIVE:           'INVENTORY.RECEIVE',
  ADJUST:            'INVENTORY.ADJUST',
  CONFIGURE:         'INVENTORY.CONFIGURE',
  PO_CREATE:         'INVENTORY.PO_CREATE',
  PO_APPROVE:        'INVENTORY.PO_APPROVE',
  WO_MANAGE:         'INVENTORY.WO_MANAGE',
  WO_COMPLETE:       'INVENTORY.WO_COMPLETE',
  WO_CLOSE:          'INVENTORY.WO_CLOSE',
  COUNT_CONDUCT:     'INVENTORY.COUNT_CONDUCT',
  COUNT_APPROVE:     'INVENTORY.COUNT_APPROVE',
  COST_VIEW:         'INVENTORY.COST_VIEW',
  REPORTS_VIEW:      'INVENTORY.REPORTS_VIEW',
  TRANSFER:          'INVENTORY.TRANSFER',
  TRANSFER_CREATE:   'INVENTORY.TRANSFER_CREATE',
  SO_MANAGE:         'INVENTORY.SO_MANAGE',
  PRODUCTION_MANAGE: 'INVENTORY.PRODUCTION_MANAGE',
});

/**
 * Pre-bound requirePermission factory for inventory routes.
 * Equivalent to requirePermission(PERM.WHATEVER) but reads more cleanly.
 *
 * @param {string} permString — one of the PERM.* constants above
 * @returns Express middleware
 */
function requirePerm(permString) {
  return requirePermission(permString);
}

/**
 * Lightweight helper: resolve the inventory permission set for a given role.
 * Used by the frontend permissions endpoint to tell the UI which actions
 * to show/hide without requiring the frontend to know role names.
 *
 * Returns an object of { PERM_KEY: boolean } for the given role.
 *
 * @param {string} role
 * @returns {object}
 */
function getInventoryPermsForRole(role) {
  const { hasPermission } = require('../../config/permissions');
  return Object.fromEntries(
    Object.entries(PERM).map(([key, permString]) => {
      const [category, action] = permString.split('.');
      return [key, hasPermission(role, category, action)];
    })
  );
}

module.exports = { PERM, requirePerm, getInventoryPermsForRole };
