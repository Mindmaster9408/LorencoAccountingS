/**
 * ============================================================================
 * Payroll Employee Sync Tests
 * ============================================================================
 * Validates sync service:
 *   1. Detects employees in KV store not in master table
 *   2. Creates missing master records correctly
 *   3. Prevents duplicates
 *   4. Preserves payroll history
 *   5. Works per-company only (no cross-tenant leakage)
 *
 * Run: npm test -- payroll-employee-sync.test.js
 * ============================================================================
 */

'use strict';

const { Pool } = require('pg');
const {
  detectUnsyncedEmployees,
  syncUnsyncedEmployees
} = require('../routes/payroll-employee-sync');

/**
 * Test setup: Connect to test database
 */
let pool;
const TEST_COMPANY_ID = 999;
const TEST_COMPANY_ID_2 = 998;

beforeAll(async () => {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL
  });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Helper: Clean up test data after each test
 */
async function cleanupTestData() {
  const client = await pool.connect();
  try {
    // Delete test employees
    await client.query(
      'DELETE FROM employees WHERE company_id = $1',
      [TEST_COMPANY_ID]
    );
    await client.query(
      'DELETE FROM employees WHERE company_id = $1',
      [TEST_COMPANY_ID_2]
    );

    // Delete test KV data
    await client.query(
      'DELETE FROM payroll_kv_store_eco WHERE company_id = ANY($1)',
      [[TEST_COMPANY_ID.toString(), TEST_COMPANY_ID_2.toString()]]
    );
  } finally {
    client.release();
  }
}

/**
 * Helper: Insert KV employees (simulates payrun additions)
 */
async function insertKVEmployees(companyId, employees) {
  const client = await pool.connect();
  try {
    const key = `employees_${companyId}`;
    await client.query(
      `INSERT INTO payroll_kv_store_eco (company_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, key) DO UPDATE SET value = $3`,
      [companyId.toString(), key, JSON.stringify(employees)]
    );
  } finally {
    client.release();
  }
}

/**
 * Helper: Insert master employees
 */
async function insertMasterEmployee(companyId, code, firstName, lastName, email, idNumber) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO employees (company_id, employee_code, first_name, last_name, email, id_number, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id`,
      [companyId, code, firstName, lastName, email, idNumber]
    );
    return result.rows[0].id;
  } finally {
    client.release();
  }
}

// ============================================================================
// TEST CASES
// ============================================================================

describe('Payroll Employee Sync Service', () => {

  afterEach(async () => {
    await cleanupTestData();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: Detect unsynced employees
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 1: Detects employees in KV store not in master table', async () => {
    // Setup: Add employees to KV store only (not master)
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'John Doe', employee_code: 'EMP001', email: 'john@example.com' },
      { id: '002', name: 'Jane Smith', employee_code: 'EMP002', email: 'jane@example.com' }
    ]);

    // Execute: Detect unsynced
    const unsynced = await detectUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: Both should be detected as unsynced
    expect(unsynced.length).toBe(2);
    expect(unsynced[0].name).toBe('John Doe');
    expect(unsynced[1].name).toBe('Jane Smith');
    console.log('✓ TEST 1 PASSED: Unsynced employees detected correctly');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: No duplic detection when employee already in master
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 2: Does NOT detect employees already in master table', async () => {
    // Setup: Add to master
    await insertMasterEmployee(TEST_COMPANY_ID, 'EMP001', 'John', 'Doe', 'john@example.com', 'ID12345');

    // Add SAME employee to KV store (user added same employee twice)
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'John Doe', employee_code: 'EMP001', email: 'john@example.com' }
    ]);

    // Execute: Detect unsynced
    const unsynced = await detectUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: Should be empty (already in master)
    expect(unsynced.length).toBe(0);
    console.log('✓ TEST 2 PASSED: No false duplicates detected');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Sync creates missing master records
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 3: Sync creates missing master records from KV data', async () => {
    // Setup: 2 employees in KV only
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'Alice Brown', employee_code: 'EMP001', email: 'alice@example.com', id_number: 'ID001' },
      { id: '002', name: 'Bob Green', employee_code: 'EMP002', email: 'bob@example.com', id_number: 'ID002' }
    ]);

    // Execute: Sync
    const result = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: Both created
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.created).toBe(2);
    expect(result.failed.length).toBe(0);

    // Verify master table now has them
    const client = await pool.connect();
    try {
      const checkResult = await client.query(
        'SELECT COUNT(*) as cnt FROM employees WHERE company_id = $1',
        [TEST_COMPANY_ID]
      );
      expect(checkResult.rows[0].cnt).toBe(2);
    } finally {
      client.release();
    }

    console.log('✓ TEST 3 PASSED: Master records created correctly');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Sync prevents duplicate creation (idempotent)
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 4: Sync is idempotent—re-running does not create duplicates', async () => {
    // Setup: Add to KV
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'Carol Davis', employee_code: 'EMP001', email: 'carol@example.com' }
    ]);

    // Execute: First sync
    const result1 = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);
    expect(result1.created).toBe(1);

    // Re-run sync (should detect no unsynced now)
    const result2 = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: No creation on second run
    expect(result2.total).toBe(0);
    expect(result2.created).toBe(0);

    // Verify only 1 master record exists
    const client = await pool.connect();
    try {
      const checkResult = await client.query(
        'SELECT COUNT(*) as cnt FROM employees WHERE company_id = $1',
        [TEST_COMPANY_ID]
      );
      expect(checkResult.rows[0].cnt).toBe(1);
    } finally {
      client.release();
    }

    console.log('✓ TEST 4 PASSED: Sync is idempotent (no duplicate creation)');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: Sync matches by email to prevent duplicates
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 5: Sync matches existing employees by email', async () => {
    // Setup: Insert master with email
    const masterId = await insertMasterEmployee(
      TEST_COMPANY_ID, 'OLD001', 'David', 'Evans', 'david@example.com', 'ID111'
    );

    // Add SAME employee to KV with different code/name but same email
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: 'NEW001', name: 'Dave Evans', employee_code: 'NEW001', email: 'david@example.com' }
    ]);

    // Execute: Sync
    const result = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: Should LINK to existing, not create new
    expect(result.created).toBe(0);
    expect(result.linked).toBe(1);
    expect(result.failed.length).toBe(0);

    // Verify still only 1 master record
    const client = await pool.connect();
    try {
      const checkResult = await client.query(
        'SELECT COUNT(*) as cnt FROM employees WHERE company_id = $1',
        [TEST_COMPANY_ID]
      );
      expect(checkResult.rows[0].cnt).toBe(1);
    } finally {
      client.release();
    }

    console.log('✓ TEST 5 PASSED: Email matching prevents duplicates');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6: Per-company isolation (no cross-tenant data leakage)
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 6: Sync respects company isolation—does not affect other companies', async () => {
    // Setup: Add employees to TWO companies in KV
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'Employee A', employee_code: 'EMP001', email: 'empA@example.com' }
    ]);
    await insertKVEmployees(TEST_COMPANY_ID_2, [
      { id: '002', name: 'Employee B', employee_code: 'EMP002', email: 'empB@example.com' }
    ]);

    // Execute: Sync ONLY company 1
    const result = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: Only company 1 employee synced
    expect(result.total).toBe(1);
    expect(result.created).toBe(1);

    // Verify: Company 1 has 1 employee, Company 2 has 0
    const client = await pool.connect();
    try {
      const count1 = await client.query(
        'SELECT COUNT(*) as cnt FROM employees WHERE company_id = $1',
        [TEST_COMPANY_ID]
      );
      const count2 = await client.query(
        'SELECT COUNT(*) as cnt FROM employees WHERE company_id = $1',
        [TEST_COMPANY_ID_2]
      );

      expect(count1.rows[0].cnt).toBe(1);
      expect(count2.rows[0].cnt).toBe(0);
    } finally {
      client.release();
    }

    console.log('✓ TEST 6 PASSED: Company isolation enforced');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7: Sync preserves existing payroll history
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 7: Sync does not affect existing payroll/payslip data', async () => {
    // Setup: Create employee and payroll data in KV
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'Ellen Foster', employee_code: 'EMP001', email: 'ellen@example.com' }
    ]);

    // Add payroll data in KV for this employee
    const client = await pool.connect();
    try {
      const key = `emp_payroll_${TEST_COMPANY_ID}_001`;
      await client.query(
        `INSERT INTO payroll_kv_store_eco (company_id, key, value)
         VALUES ($1, $2, $3)`,
        [TEST_COMPANY_ID.toString(), key, JSON.stringify({ basic_salary: 50000 })]
      );
    } finally {
      client.release();
    }

    // Execute: Sync
    const result = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);
    expect(result.created).toBe(1);

    // Verify: Payroll data still intact in KV
    const kvCheck = await pool.query(
      `SELECT value FROM payroll_kv_store_eco WHERE company_id = $1 AND key = $2`,
      [TEST_COMPANY_ID.toString(), `emp_payroll_${TEST_COMPANY_ID}_001`]
    );

    const payrollData = kvCheck.rows[0].value;
    expect(payrollData.basic_salary).toBe(50000);

    console.log('✓ TEST 7 PASSED: Payroll data preserved after sync');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 8: Partial failure (some create, some link)
  // ──────────────────────────────────────────────────────────────────────────
  test('TEST 8: Handles mixed scenario (some new creates, some matches)', async () => {
    // Setup: Master has 1 employee
    await insertMasterEmployee(
      TEST_COMPANY_ID, 'EMP001', 'Frank', 'Green', 'frank@example.com', 'ID001'
    );

    // KV has: 1 matching + 2 new
    await insertKVEmployees(TEST_COMPANY_ID, [
      { id: '001', name: 'Frank Green', employee_code: 'EMP001', email: 'frank@example.com' },
      { id: '002', name: 'Grace Harris', employee_code: 'EMP002', email: 'grace@example.com' },
      { id: '003', name: 'Henry Irving', employee_code: 'EMP003', email: 'henry@example.com' }
    ]);

    // Execute: Sync
    const result = await syncUnsyncedEmployees(pool, TEST_COMPANY_ID);

    // Assert: 1 new, 1 link, 0 failures
    expect(result.total).toBe(3);
    expect(result.created).toBe(2);
    expect(result.linked).toBe(1);
    expect(result.failed.length).toBe(0);

    console.log('✓ TEST 8 PASSED: Mixed sync handled correctly');
  });

});
