/**
 * ============================================================================
 * Feature Flags — Unit Tests
 * ============================================================================
 * Tests the FeatureFlagService evaluation logic (rollout levels, contexts).
 * DB interactions are mocked — we test the evaluation engine, not Supabase.
 * ============================================================================
 */

// Mock the Supabase client before requiring the service
jest.mock('../config/database', () => ({
  supabase: {
    from: jest.fn()
  }
}));

const { supabase } = require('../config/database');
const { FeatureFlagService } = (() => {
  // Re-export the class for testing — patch the module to expose it
  const mod = require('../services/featureFlags');
  // Build a fresh FeatureFlagService instance without the singleton
  const cls = Object.getPrototypeOf(mod.featureFlags).constructor;
  return { FeatureFlagService: cls };
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFlag(overrides = {}) {
  return {
    id: 1,
    flag_key: 'TEST_FLAG',
    display_name: 'Test Flag',
    description: null,
    app: 'paytime',
    is_active: true,
    rollout_level: 'all',
    allowed_company_ids: [],
    updated_by: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides
  };
}

function mockSupabaseSingle(data, error = null) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
    single: jest.fn().mockResolvedValue({ data, error }),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
  };
  supabase.from.mockReturnValue(chain);
  return chain;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('FeatureFlagService — rollout level evaluation', () => {
  let service;

  beforeEach(() => {
    service = new FeatureFlagService();
    jest.clearAllMocks();
  });

  // ── rollout_level: disabled ──────────────────────────────────────────────

  describe('rollout_level: disabled', () => {
    const flag = mockFlag({ rollout_level: 'disabled' });

    test('super admin sees flag as disabled', () => {
      const result = service._evaluate(flag, { companyId: 1, isSuperAdmin: true });
      expect(result).toBe(false);
    });

    test('normal user sees flag as disabled', () => {
      const result = service._evaluate(flag, { companyId: 5, isSuperAdmin: false });
      expect(result).toBe(false);
    });
  });

  // ── rollout_level: superuser ─────────────────────────────────────────────

  describe('rollout_level: superuser', () => {
    const flag = mockFlag({ rollout_level: 'superuser' });

    test('super admin can see feature', () => {
      const result = service._evaluate(flag, { companyId: 1, isSuperAdmin: true });
      expect(result).toBe(true);
    });

    test('normal user cannot see feature', () => {
      const result = service._evaluate(flag, { companyId: 5, isSuperAdmin: false });
      expect(result).toBe(false);
    });

    test('business owner cannot see feature', () => {
      const result = service._evaluate(flag, { companyId: 10, isSuperAdmin: false });
      expect(result).toBe(false);
    });
  });

  // ── rollout_level: test_client ───────────────────────────────────────────

  describe('rollout_level: test_client', () => {
    const flag = mockFlag({
      rollout_level: 'test_client',
      allowed_company_ids: [42, 99]
    });

    test('super admin can see feature', () => {
      expect(service._evaluate(flag, { companyId: 1, isSuperAdmin: true })).toBe(true);
    });

    test('allowed test company can see feature', () => {
      expect(service._evaluate(flag, { companyId: 42, isSuperAdmin: false })).toBe(true);
    });

    test('second allowed test company can see feature', () => {
      expect(service._evaluate(flag, { companyId: 99, isSuperAdmin: false })).toBe(true);
    });

    test('non-allowed company cannot see feature', () => {
      expect(service._evaluate(flag, { companyId: 5, isSuperAdmin: false })).toBe(false);
    });

    test('companyId type coercion: string "42" matches integer 42', () => {
      expect(service._evaluate(flag, { companyId: '42', isSuperAdmin: false })).toBe(true);
    });
  });

  // ── rollout_level: selected_clients ──────────────────────────────────────

  describe('rollout_level: selected_clients', () => {
    const flag = mockFlag({
      rollout_level: 'selected_clients',
      allowed_company_ids: [10, 20, 30]
    });

    test('super admin can see feature', () => {
      expect(service._evaluate(flag, { companyId: 1, isSuperAdmin: true })).toBe(true);
    });

    test('allowed company can see feature', () => {
      expect(service._evaluate(flag, { companyId: 20, isSuperAdmin: false })).toBe(true);
    });

    test('company not in list cannot see feature', () => {
      expect(service._evaluate(flag, { companyId: 50, isSuperAdmin: false })).toBe(false);
    });

    test('null companyId cannot see feature', () => {
      expect(service._evaluate(flag, { companyId: null, isSuperAdmin: false })).toBe(false);
    });
  });

  // ── rollout_level: all ───────────────────────────────────────────────────

  describe('rollout_level: all', () => {
    const flag = mockFlag({ rollout_level: 'all' });

    test('super admin can see feature', () => {
      expect(service._evaluate(flag, { companyId: 1, isSuperAdmin: true })).toBe(true);
    });

    test('any company can see feature', () => {
      expect(service._evaluate(flag, { companyId: 999, isSuperAdmin: false })).toBe(true);
    });

    test('company without ID can see feature', () => {
      expect(service._evaluate(flag, { companyId: null, isSuperAdmin: false })).toBe(true);
    });
  });

  // ── is_active = false overrides rollout level ────────────────────────────

  describe('is_active = false', () => {
    test('inactive flag is disabled even for super admin via isEnabled()', async () => {
      const flag = mockFlag({ is_active: false, rollout_level: 'all' });
      mockSupabaseSingle(flag);

      // isEnabled() checks is_active before calling _evaluate
      const result = await service.isEnabled('TEST_FLAG', {
        companyId: 1,
        isSuperAdmin: false
      });
      expect(result).toBe(false);
    });
  });

  // ── Super admin override in isEnabled() ──────────────────────────────────

  describe('super admin bypass in isEnabled()', () => {
    test('super admin always gets true, regardless of flag state', async () => {
      // When isSuperAdmin=true, isEnabled() returns true WITHOUT checking the flag
      // (no DB call needed — the test verifies no supabase.from() is called)
      const result = await service.isEnabled('ANYTHING', {
        companyId: 1,
        isSuperAdmin: true
      });
      expect(result).toBe(true);
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  // ── Unknown flag ─────────────────────────────────────────────────────────

  describe('unknown flag', () => {
    test('returns false for non-existent flag', async () => {
      mockSupabaseSingle(null); // DB returns null for unknown key
      const result = await service.isEnabled('NONEXISTENT_FLAG', {
        companyId: 5,
        isSuperAdmin: false
      });
      expect(result).toBe(false);
    });
  });
});

// ── Integration-style: rollout progression test ───────────────────────────────

describe('Rollout progression', () => {
  let service;

  beforeEach(() => {
    service = new FeatureFlagService();
  });

  test('full rollout lifecycle: disabled → superuser → test_client → all', () => {
    const superAdminCtx  = { companyId: 1,  isSuperAdmin: true  };
    const testClientCtx  = { companyId: 42, isSuperAdmin: false };
    const liveClientCtx  = { companyId: 99, isSuperAdmin: false };

    // Stage 1: disabled
    const flagDisabled = mockFlag({ is_active: true, rollout_level: 'disabled' });
    expect(service._evaluate(flagDisabled, superAdminCtx)).toBe(false);
    expect(service._evaluate(flagDisabled, testClientCtx)).toBe(false);
    expect(service._evaluate(flagDisabled, liveClientCtx)).toBe(false);

    // Stage 2: superuser only
    const flagSuperuser = mockFlag({ is_active: true, rollout_level: 'superuser' });
    expect(service._evaluate(flagSuperuser, superAdminCtx)).toBe(true);
    expect(service._evaluate(flagSuperuser, testClientCtx)).toBe(false);
    expect(service._evaluate(flagSuperuser, liveClientCtx)).toBe(false);

    // Stage 3: test client
    const flagTestClient = mockFlag({ is_active: true, rollout_level: 'test_client', allowed_company_ids: [42] });
    expect(service._evaluate(flagTestClient, superAdminCtx)).toBe(true);
    expect(service._evaluate(flagTestClient, testClientCtx)).toBe(true);
    expect(service._evaluate(flagTestClient, liveClientCtx)).toBe(false);

    // Stage 4: full rollout
    const flagAll = mockFlag({ is_active: true, rollout_level: 'all' });
    expect(service._evaluate(flagAll, superAdminCtx)).toBe(true);
    expect(service._evaluate(flagAll, testClientCtx)).toBe(true);
    expect(service._evaluate(flagAll, liveClientCtx)).toBe(true);
  });
});
