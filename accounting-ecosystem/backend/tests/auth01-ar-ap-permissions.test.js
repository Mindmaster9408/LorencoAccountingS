'use strict';

/**
 * AUTH-01 — AR/AP Permission Hardening Tests
 *
 * Verifies the PERMISSIONS map in accounting/middleware/auth.js has the correct
 * granular AR/AP keys, and that the hasPermission() middleware correctly allows
 * and blocks the four Lorenco roles (admin, accountant, bookkeeper, viewer).
 *
 * All tests use pure logic simulation — no Express routes, no database calls.
 *
 * Scenarios covered:
 *   TEST-AUTH-01  Viewer cannot create AR invoices.
 *   TEST-AUTH-02  Viewer cannot post AR invoices.
 *   TEST-AUTH-03  Viewer cannot void AR invoices.
 *   TEST-AUTH-04  Viewer can view AR invoices.
 *   TEST-AUTH-05  Bookkeeper can create AR invoice drafts.
 *   TEST-AUTH-06  Bookkeeper cannot post AR invoices.
 *   TEST-AUTH-07  Bookkeeper cannot void AR invoices.
 *   TEST-AUTH-08  Accountant can post AR invoices.
 *   TEST-AUTH-09  Accountant can void AR invoices.
 *   TEST-AUTH-10  Admin (super_admin ECO role) has all permissions after role mapping.
 *   TEST-AUTH-11  Payment routes require ar.payment.record / ap.payment.record.
 *   TEST-AUTH-12  OCR / AP invoice create requires ap.invoice.create.
 *   TEST-AUTH-13  PO status approval requires ap.purchase_order.approve (accountant+admin only).
 *   TEST-AUTH-14  Existing company scope unaffected — companyId passthrough unchanged.
 *   TEST-AUTH-15  Unknown permission key returns 403 (not silent pass).
 *   TEST-AUTH-16  All new permission keys present in PERMISSIONS map.
 */

const {
  authenticate,
  hasPermission,
  PERMISSIONS,
} = require('../modules/accounting/middleware/auth');

// ── Simulation helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal req object with the given ECO JWT shape.
 * companyId is pre-set as if ECO's global authenticateToken already ran.
 */
function makeReq({ ecoRole, email = 'user@test.com', companyId = 42, isSuperAdmin = false }) {
  return {
    user: {
      userId:       1,
      id:           1,
      role:         ecoRole,
      email,
      fullName:     'Test User',
      companyId,
      isSuperAdmin,
    },
    companyId,
    ip:             '127.0.0.1',
    get: () => 'TestAgent',
  };
}

/**
 * Run `authenticate` then `hasPermission(key)` on a synthetic req and return the
 * HTTP status that would be sent (200 = passed, 401 = no user, 403 = blocked).
 */
function checkPermission(req, permKey) {
  let result = null;
  const res = {
    status: (code) => ({ json: (body) => { result = { status: code, body }; } }),
  };

  // First run authenticate (role mapping)
  let authPassed = false;
  const next = () => { authPassed = true; };
  authenticate(req, res, next);
  if (!authPassed) return result; // 401

  // Then run hasPermission
  let permPassed = false;
  const nextPerm = () => { permPassed = true; };
  hasPermission(permKey)(req, res, nextPerm);
  if (permPassed) return { status: 200 };
  return result; // 403
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────

describe('AUTH-01 — AR/AP Permission Hardening', () => {

  // ── Viewer: view only ───────────────────────────────────────────────────────

  describe('TEST-AUTH-01: Viewer cannot create AR invoices', () => {
    it('returns 403 for viewer on ar.invoice.create', () => {
      const req = makeReq({ ecoRole: 'viewer' });
      const r = checkPermission(req, 'ar.invoice.create');
      expect(r.status).toBe(403);
    });
  });

  describe('TEST-AUTH-02: Viewer cannot post AR invoices', () => {
    it('returns 403 for viewer on ar.invoice.post', () => {
      const req = makeReq({ ecoRole: 'viewer' });
      const r = checkPermission(req, 'ar.invoice.post');
      expect(r.status).toBe(403);
    });
  });

  describe('TEST-AUTH-03: Viewer cannot void AR invoices', () => {
    it('returns 403 for viewer on ar.invoice.void', () => {
      const req = makeReq({ ecoRole: 'viewer' });
      const r = checkPermission(req, 'ar.invoice.void');
      expect(r.status).toBe(403);
    });
  });

  describe('TEST-AUTH-04: Viewer can view AR invoices', () => {
    it('returns 200 for viewer on ar.invoice.view', () => {
      const req = makeReq({ ecoRole: 'viewer' });
      const r = checkPermission(req, 'ar.invoice.view');
      expect(r.status).toBe(200);
    });
  });

  // ── Bookkeeper: create/edit drafts, record payments ─────────────────────────

  describe('TEST-AUTH-05: Bookkeeper can create AR invoice drafts', () => {
    it('returns 200 for bookkeeper on ar.invoice.create', () => {
      const req = makeReq({ ecoRole: 'bookkeeper' });
      const r = checkPermission(req, 'ar.invoice.create');
      expect(r.status).toBe(200);
    });
  });

  describe('TEST-AUTH-06: Bookkeeper cannot post AR invoices', () => {
    it('returns 403 for bookkeeper on ar.invoice.post', () => {
      const req = makeReq({ ecoRole: 'bookkeeper' });
      const r = checkPermission(req, 'ar.invoice.post');
      expect(r.status).toBe(403);
    });
  });

  describe('TEST-AUTH-07: Bookkeeper cannot void AR invoices', () => {
    it('returns 403 for bookkeeper on ar.invoice.void', () => {
      const req = makeReq({ ecoRole: 'bookkeeper' });
      const r = checkPermission(req, 'ar.invoice.void');
      expect(r.status).toBe(403);
    });
  });

  // ── Accountant: post and void ────────────────────────────────────────────────

  describe('TEST-AUTH-08: Accountant can post AR invoices', () => {
    it('returns 200 for accountant on ar.invoice.post', () => {
      const req = makeReq({ ecoRole: 'accountant' });
      const r = checkPermission(req, 'ar.invoice.post');
      expect(r.status).toBe(200);
    });
  });

  describe('TEST-AUTH-09: Accountant can void AR invoices', () => {
    it('returns 200 for accountant on ar.invoice.void', () => {
      const req = makeReq({ ecoRole: 'accountant' });
      const r = checkPermission(req, 'ar.invoice.void');
      expect(r.status).toBe(200);
    });
  });

  // ── Admin: all permissions via role mapping ──────────────────────────────────

  describe('TEST-AUTH-10: Admin (super_admin ECO role) passes all permissions after role mapping', () => {
    const permKeys = [
      'ar.invoice.view', 'ar.invoice.create', 'ar.invoice.edit',
      'ar.invoice.post', 'ar.invoice.void', 'ar.payment.record',
      'ap.invoice.view', 'ap.invoice.create', 'ap.invoice.edit',
      'ap.invoice.void', 'ap.payment.record', 'ap.purchase_order.approve',
    ];

    it.each(permKeys)('super_admin passes %s', (key) => {
      const req = makeReq({ ecoRole: 'super_admin' });
      const r = checkPermission(req, key);
      expect(r.status).toBe(200);
    });

    it('business_owner maps to admin and passes ar.invoice.post', () => {
      const req = makeReq({ ecoRole: 'business_owner' });
      const r = checkPermission(req, 'ar.invoice.post');
      expect(r.status).toBe(200);
    });

    it('administrator maps to admin and passes ap.purchase_order.approve', () => {
      const req = makeReq({ ecoRole: 'administrator' });
      const r = checkPermission(req, 'ap.purchase_order.approve');
      expect(r.status).toBe(200);
    });
  });

  // ── Payment routes ───────────────────────────────────────────────────────────

  describe('TEST-AUTH-11: Payment routes require ar.payment.record / ap.payment.record', () => {
    it('viewer cannot record AR payment', () => {
      expect(checkPermission(makeReq({ ecoRole: 'viewer' }), 'ar.payment.record').status).toBe(403);
    });
    it('viewer cannot record AP payment', () => {
      expect(checkPermission(makeReq({ ecoRole: 'viewer' }), 'ap.payment.record').status).toBe(403);
    });
    it('bookkeeper can record AR payment', () => {
      expect(checkPermission(makeReq({ ecoRole: 'bookkeeper' }), 'ar.payment.record').status).toBe(200);
    });
    it('bookkeeper can record AP payment', () => {
      expect(checkPermission(makeReq({ ecoRole: 'bookkeeper' }), 'ap.payment.record').status).toBe(200);
    });
    it('accountant can record AR payment', () => {
      expect(checkPermission(makeReq({ ecoRole: 'accountant' }), 'ar.payment.record').status).toBe(200);
    });
  });

  // ── OCR / AP invoice create ──────────────────────────────────────────────────

  describe('TEST-AUTH-12: OCR / AP invoice create requires ap.invoice.create', () => {
    it('viewer cannot create AP invoices or use OCR', () => {
      expect(checkPermission(makeReq({ ecoRole: 'viewer' }), 'ap.invoice.create').status).toBe(403);
    });
    it('bookkeeper can create AP invoices (and use OCR)', () => {
      expect(checkPermission(makeReq({ ecoRole: 'bookkeeper' }), 'ap.invoice.create').status).toBe(200);
    });
    it('accountant can create AP invoices', () => {
      expect(checkPermission(makeReq({ ecoRole: 'accountant' }), 'ap.invoice.create').status).toBe(200);
    });
  });

  // ── PO approval ─────────────────────────────────────────────────────────────

  describe('TEST-AUTH-13: PO status approval requires accountant or admin', () => {
    it('viewer cannot approve PO status', () => {
      expect(checkPermission(makeReq({ ecoRole: 'viewer' }), 'ap.purchase_order.approve').status).toBe(403);
    });
    it('bookkeeper cannot approve PO status', () => {
      expect(checkPermission(makeReq({ ecoRole: 'bookkeeper' }), 'ap.purchase_order.approve').status).toBe(403);
    });
    it('accountant can approve PO status', () => {
      expect(checkPermission(makeReq({ ecoRole: 'accountant' }), 'ap.purchase_order.approve').status).toBe(200);
    });
    it('admin can approve PO status', () => {
      expect(checkPermission(makeReq({ ecoRole: 'super_admin' }), 'ap.purchase_order.approve').status).toBe(200);
    });
  });

  // ── Company scope passthrough ────────────────────────────────────────────────

  describe('TEST-AUTH-14: Company scope unaffected — companyId preserved through authenticate', () => {
    it('authenticate preserves req.companyId on req.user.companyId', () => {
      const req = makeReq({ ecoRole: 'accountant', companyId: 77 });
      const res = { status: () => ({ json: () => {} }) };
      let passed = false;
      authenticate(req, res, () => { passed = true; });
      expect(passed).toBe(true);
      expect(req.user.companyId).toBe(77);
      expect(req.companyId).toBe(77);
    });
  });

  // ── Unknown permission key hard-fails ───────────────────────────────────────

  describe('TEST-AUTH-15: Unknown permission key returns 403 (not silent pass)', () => {
    it('hasPermission with unknown key returns 403', () => {
      const req = makeReq({ ecoRole: 'super_admin' });
      // Run authenticate first to set up req.user properly
      authenticate(req, { status: () => ({ json: () => {} }) }, () => {});

      // Suppress expected console.error from the unknown-permission guard
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      let result = null;
      const res = { status: (code) => ({ json: (body) => { result = { status: code, body }; } }) };
      hasPermission('ar.invoice.this.key.does.not.exist')(req, res, () => { result = { status: 200 }; });
      spy.mockRestore();
      expect(result.status).toBe(403);
    });
  });

  // ── All new permission keys present ─────────────────────────────────────────

  describe('TEST-AUTH-16: All new permission keys are present in PERMISSIONS map', () => {
    const requiredKeys = [
      'ar.invoice.view',
      'ar.invoice.create',
      'ar.invoice.edit',
      'ar.invoice.post',
      'ar.invoice.void',
      'ar.payment.record',
      'ap.invoice.view',
      'ap.invoice.create',
      'ap.invoice.edit',
      'ap.invoice.void',
      'ap.payment.record',
      'ap.purchase_order.approve',
    ];

    it.each(requiredKeys)('PERMISSIONS has key: %s', (key) => {
      // Use bracket notation — toHaveProperty treats dots as nested paths
      expect(PERMISSIONS[key]).toBeDefined();
      expect(Array.isArray(PERMISSIONS[key])).toBe(true);
      expect(PERMISSIONS[key].length).toBeGreaterThan(0);
    });
  });

});
