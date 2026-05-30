'use strict';

/**
 * Pilot Smoke Test Routes — /api/accounting/pilot-smoke-tests
 *
 * GET  /templates         — static test pack definition (categories + items)
 * GET  /runs              — list recent runs for the current company (last 30)
 * POST /runs              — create a new run with all test results initialised
 * GET  /runs/:id          — get a single run + all results (company-scoped)
 * PUT  /runs/:id          — update run header + save all test results atomically
 *
 * Permissions:
 *   pilot_smoke_test.view — GET templates, GET runs, GET runs/:id
 *   pilot_smoke_test.run  — POST runs, PUT runs/:id
 *
 * Company isolation: all queries include company_id from req.user.companyId.
 * No cross-company data is accessible through these endpoints.
 */

const express = require('express');
const { authenticate, hasPermission } = require('../middleware/auth');
const db = require('../config/database');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// STATIC TEST PACK — version "01"
// This is the canonical test checklist. It lives here (not in the DB) so
// that every test run always captures the current item definitions at the
// point the run was created — stored in pilot_smoke_test_results rows.
// ─────────────────────────────────────────────────────────────────────────────
const TEST_PACK_VERSION = '01';

const TEST_CATEGORIES = [
  {
    key: 'bank',
    name: 'Banking',
    tests: [
      { key: 'bank_import_statement',    name: 'Import bank statement',         severity: 'critical' },
      { key: 'bank_allocate_transaction', name: 'Allocate transaction',          severity: 'critical' },
      { key: 'bank_reconcile_transaction', name: 'Reconcile transaction',        severity: 'critical' },
      { key: 'bank_unmatched_flow',      name: 'Unmatched transaction flow',     severity: 'high'     },
      { key: 'bank_rules_suggestion',    name: 'Bank rules suggestion',          severity: 'normal'   },
    ]
  },
  {
    key: 'vat',
    name: 'VAT',
    tests: [
      { key: 'vat_generate_report',   name: 'Generate VAT report',              severity: 'critical' },
      { key: 'vat_warnings',          name: 'VAT warnings displayed',           severity: 'high'     },
      { key: 'vat_period_selection',  name: 'Period selection',                 severity: 'high'     },
      { key: 'vat_draft_finalized',   name: 'Draft / finalised behaviour',      severity: 'critical' },
    ]
  },
  {
    key: 'ar_ap',
    name: 'AR / AP',
    tests: [
      { key: 'ar_create_customer_invoice', name: 'Create customer invoice',     severity: 'critical' },
      { key: 'ar_post_invoice',            name: 'Post invoice to GL',          severity: 'critical' },
      { key: 'ar_record_payment',          name: 'Record customer payment',     severity: 'critical' },
      { key: 'ap_create_supplier_invoice', name: 'Create supplier invoice',     severity: 'critical' },
      { key: 'ap_supplier_payment',        name: 'Supplier payment',            severity: 'critical' },
    ]
  },
  {
    key: 'reports',
    name: 'Reports',
    tests: [
      { key: 'report_trial_balance',    name: 'Trial Balance',                  severity: 'critical' },
      { key: 'report_pl',               name: 'Profit & Loss',                  severity: 'critical' },
      { key: 'report_balance_sheet',    name: 'Balance Sheet',                  severity: 'critical' },
      { key: 'report_control_recon',    name: 'Control Reconciliation',         severity: 'high'     },
    ]
  },
  {
    key: 'historical',
    name: 'Historical Comparatives',
    tests: [
      { key: 'hist_save_comparative',    name: 'Save historical comparative',   severity: 'high'     },
      { key: 'hist_reload',              name: 'Reload saved comparative',      severity: 'high'     },
      { key: 'hist_finalize_protection', name: 'Finalise protection enforced',  severity: 'critical' },
    ]
  },
  {
    key: 'security',
    name: 'Security',
    tests: [
      { key: 'sec_company_switching', name: 'Company switching',                severity: 'critical' },
      { key: 'sec_role_restriction',  name: 'Role restriction checks',          severity: 'critical' },
    ]
  }
];

// Flatten all tests for easy lookup
const ALL_TESTS = TEST_CATEGORIES.flatMap(cat =>
  cat.tests.map(t => ({ ...t, category: cat.key }))
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /templates
// Returns the full static test pack definition for the current version.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/templates',
  authenticate,
  hasPermission('pilot_smoke_test.view'),
  (req, res) => {
    res.json({
      version: TEST_PACK_VERSION,
      totalTests: ALL_TESTS.length,
      categories: TEST_CATEGORIES
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /runs
// Returns the 30 most recent runs for the current company (header data only).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/runs',
  authenticate,
  hasPermission('pilot_smoke_test.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    try {
      const result = await db.query(
        `SELECT id, tester_name, build_version, notes,
                total_count, passed_count, failed_count, blocked_count, not_tested_count,
                created_at, updated_at
           FROM pilot_smoke_test_runs
          WHERE company_id = $1
          ORDER BY created_at DESC
          LIMIT 30`,
        [companyId]
      );
      res.json({ runs: result.rows });
    } catch (err) {
      console.error('[pilot-smoke-tests] GET /runs error:', err);
      res.status(500).json({ error: 'Failed to load test runs' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /runs
// Creates a new run. All test results are initialised as 'not_tested'.
// Body: { testerName, buildVersion?, notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/runs',
  authenticate,
  hasPermission('pilot_smoke_test.run'),
  async (req, res) => {
    const companyId = req.user.companyId;
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    const { testerName, buildVersion, notes } = req.body;
    if (!testerName || !testerName.trim()) {
      return res.status(400).json({ error: 'testerName is required' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Create the run header
      const runResult = await client.query(
        `INSERT INTO pilot_smoke_test_runs
           (company_id, tester_name, build_version, notes, total_count, not_tested_count)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING *`,
        [
          companyId,
          testerName.trim(),
          buildVersion ? buildVersion.trim() : null,
          notes ? notes.trim() : null,
          ALL_TESTS.length
        ]
      );
      const run = runResult.rows[0];

      // Initialise one result row per test item
      const values = ALL_TESTS.map((t, i) => {
        const base = i * 5;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      });
      const params = ALL_TESTS.flatMap(t => [
        run.id,
        companyId,
        t.category,
        t.key,
        t.name
      ]);
      await client.query(
        `INSERT INTO pilot_smoke_test_results
           (run_id, company_id, category, test_key, test_name)
         VALUES ${values.join(', ')}`,
        params
      );

      // Fetch results to return in the response
      const resultsResult = await client.query(
        `SELECT * FROM pilot_smoke_test_results WHERE run_id = $1 ORDER BY id`,
        [run.id]
      );

      await client.query('COMMIT');

      res.status(201).json({ run, results: resultsResult.rows });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[pilot-smoke-tests] POST /runs error:', err);
      res.status(500).json({ error: 'Failed to create test run' });
    } finally {
      client.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /runs/:id
// Returns a single run + all results. Enforces company scope.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/runs/:id',
  authenticate,
  hasPermission('pilot_smoke_test.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const runId = parseInt(req.params.id, 10);
    if (!companyId)          return res.status(400).json({ error: 'Company context required' });
    if (isNaN(runId) || runId < 1) return res.status(400).json({ error: 'Invalid run id' });

    try {
      const runResult = await db.query(
        `SELECT * FROM pilot_smoke_test_runs WHERE id = $1 AND company_id = $2`,
        [runId, companyId]
      );
      if (!runResult.rows.length) {
        return res.status(404).json({ error: 'Test run not found' });
      }

      const resultsResult = await db.query(
        `SELECT * FROM pilot_smoke_test_results WHERE run_id = $1 ORDER BY id`,
        [runId]
      );

      res.json({ run: runResult.rows[0], results: resultsResult.rows });
    } catch (err) {
      console.error('[pilot-smoke-tests] GET /runs/:id error:', err);
      res.status(500).json({ error: 'Failed to load test run' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /runs/:id
// Saves results for an existing run. Updates run header + all result rows.
//
// Body:
//   { testerName?, buildVersion?, notes?,
//     results: [ { testKey, status, notes?, screenshotRef?, errorText? }, ... ] }
//
// Summary counters are recalculated from the submitted results and persisted.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/runs/:id',
  authenticate,
  hasPermission('pilot_smoke_test.run'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const runId = parseInt(req.params.id, 10);
    if (!companyId)          return res.status(400).json({ error: 'Company context required' });
    if (isNaN(runId) || runId < 1) return res.status(400).json({ error: 'Invalid run id' });

    const { testerName, buildVersion, notes, results } = req.body;
    if (!Array.isArray(results)) {
      return res.status(400).json({ error: 'results array is required' });
    }

    // Validate all statuses before touching the DB
    const VALID_STATUSES = new Set(['pass', 'fail', 'blocked', 'not_tested']);
    for (const r of results) {
      if (!r.testKey) return res.status(400).json({ error: 'Each result must have a testKey' });
      if (!VALID_STATUSES.has(r.status)) {
        return res.status(400).json({ error: `Invalid status '${r.status}' for testKey '${r.testKey}'` });
      }
    }

    // Recalculate summary counts
    const counts = { pass: 0, fail: 0, blocked: 0, not_tested: 0 };
    for (const r of results) counts[r.status]++;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Verify the run belongs to this company
      const check = await client.query(
        `SELECT id FROM pilot_smoke_test_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [runId, companyId]
      );
      if (!check.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Test run not found' });
      }

      // Update run header + summary counters
      await client.query(
        `UPDATE pilot_smoke_test_runs
            SET tester_name      = COALESCE($1, tester_name),
                build_version    = COALESCE($2, build_version),
                notes            = COALESCE($3, notes),
                passed_count     = $4,
                failed_count     = $5,
                blocked_count    = $6,
                not_tested_count = $7,
                updated_at       = now()
          WHERE id = $8 AND company_id = $9`,
        [
          testerName ? testerName.trim() : null,
          buildVersion !== undefined ? (buildVersion ? buildVersion.trim() : null) : null,
          notes !== undefined ? (notes ? notes.trim() : null) : null,
          counts.pass,
          counts.fail,
          counts.blocked,
          counts.not_tested,
          runId,
          companyId
        ]
      );

      // Upsert each result row
      for (const r of results) {
        await client.query(
          `UPDATE pilot_smoke_test_results
              SET status         = $1,
                  notes          = $2,
                  screenshot_ref = $3,
                  error_text     = $4,
                  updated_at     = now()
            WHERE run_id = $5 AND test_key = $6 AND company_id = $7`,
          [
            r.status,
            r.notes    || null,
            r.screenshotRef || null,
            r.errorText     || null,
            runId,
            r.testKey,
            companyId
          ]
        );
      }

      // Fetch fresh run + results to return
      const runResult = await client.query(
        `SELECT * FROM pilot_smoke_test_runs WHERE id = $1`,
        [runId]
      );
      const resultsResult = await client.query(
        `SELECT * FROM pilot_smoke_test_results WHERE run_id = $1 ORDER BY id`,
        [runId]
      );

      await client.query('COMMIT');

      res.json({ run: runResult.rows[0], results: resultsResult.rows });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[pilot-smoke-tests] PUT /runs/:id error:', err);
      res.status(500).json({ error: 'Failed to save test run' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
