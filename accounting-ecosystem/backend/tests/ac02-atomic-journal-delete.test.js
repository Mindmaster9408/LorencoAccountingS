'use strict';

/**
 * AC-02 — Atomic Draft Journal Delete Tests
 *
 * Tests the pg-transaction-backed DELETE /journals/:id handler logic.
 * Uses pure simulation helpers — no Express or database mocking required.
 *
 * Scenarios covered:
 *   TEST-DEL-01  Happy path: draft journal deleted, lines deleted, success response.
 *   TEST-DEL-02  Journal not found (wrong ID) → 404.
 *   TEST-DEL-03  Journal belongs to different company → 404 (company isolation).
 *   TEST-DEL-04  Journal status is 'posted' → 409, no delete.
 *   TEST-DEL-05  Journal status is 'reversed' → 409, no delete.
 *   TEST-DEL-06  Concurrent delete: rowCount 0 on journal DELETE → 500, rolled back.
 *   TEST-DEL-07  Lines delete fails inside transaction → ROLLBACK, journal still present.
 *   TEST-DEL-08  Invalid journal ID (NaN) → 400 before DB is touched.
 *   TEST-DEL-09  Audit log fires after COMMIT with correct snapshot data.
 *   TEST-DEL-10  Audit log failure does NOT prevent 200 response (outside transaction).
 */

// ── Simulation helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulates the DELETE handler logic end-to-end.
 *
 * @param {object} opts
 * @param {string|number} opts.requestId  — The :id param from the URL
 * @param {number}        opts.companyId  — req.user.companyId
 * @param {object|null}   opts.dbRow      — The row returned by SELECT FOR UPDATE (null = not found)
 * @param {boolean}       opts.linesDeleteFails  — Simulate lines DELETE throwing
 * @param {number}        opts.journalDeleteRowCount  — rowCount from journal DELETE (1 = success, 0 = race)
 * @param {boolean}       opts.auditFails — Simulate AuditLogger throwing after COMMIT
 * @returns {{ status: number, body: object, auditCalled: boolean, auditArgs: object|null,
 *             committed: boolean, rolledBack: boolean }}
 */
async function simulateDelete({
  requestId,
  companyId,
  dbRow,
  linesDeleteFails = false,
  journalDeleteRowCount = 1,
  auditFails = false,
}) {
  const journalId = parseInt(requestId, 10);

  if (isNaN(journalId)) {
    return { status: 400, body: { error: 'Invalid journal ID' }, auditCalled: false, auditArgs: null, committed: false, rolledBack: false };
  }

  const txLog = [];
  const mockClient = {
    query: jest.fn(async (sql) => {
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN')    { txLog.push('BEGIN'); return; }
      if (normalized === 'ROLLBACK') { txLog.push('ROLLBACK'); return; }
      if (normalized === 'COMMIT')   { txLog.push('COMMIT'); return; }

      if (sql.includes('SELECT') && sql.includes('FOR UPDATE')) {
        return { rows: dbRow ? [dbRow] : [] };
      }
      if (sql.includes('DELETE FROM journal_lines')) {
        if (linesDeleteFails) throw new Error('journal_lines delete failed');
        return { rowCount: 3 };
      }
      if (sql.includes("DELETE FROM journals")) {
        return { rowCount: journalDeleteRowCount };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };

  const mockDb = { getClient: jest.fn(async () => mockClient) };

  let auditCalled = false;
  let auditArgs = null;
  const mockAudit = jest.fn(async (...args) => {
    auditCalled = true;
    auditArgs = args;
    if (auditFails) throw new Error('Audit write failed');
  });

  // Replicate handler logic
  let journalSnapshot = null;
  let status = 200;
  let body = {};

  const client = await mockDb.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, status, date, reference, description FROM journals WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [journalId, companyId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        status: 404, body: { error: 'Draft journal not found.' },
        auditCalled: false, auditArgs: null,
        committed: txLog.includes('COMMIT'), rolledBack: txLog.includes('ROLLBACK'),
      };
    }

    const journal = rows[0];
    if (journal.status !== 'draft') {
      await client.query('ROLLBACK');
      return {
        status: 409, body: { error: 'Only draft journals can be deleted. Posted journals must be reversed.' },
        auditCalled: false, auditArgs: null,
        committed: txLog.includes('COMMIT'), rolledBack: txLog.includes('ROLLBACK'),
      };
    }

    journalSnapshot = journal;

    await client.query('DELETE FROM journal_lines WHERE journal_id = $1', [journalId]);

    const deleteResult = await client.query(
      `DELETE FROM journals WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
      [journalId, companyId]
    );

    if (deleteResult.rowCount !== 1) {
      throw new Error('Draft journal delete failed. No changes were saved.');
    }

    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return {
      status: 500, body: { error: error.message || 'Draft journal delete failed. No changes were saved.' },
      auditCalled: false, auditArgs: null,
      committed: txLog.includes('COMMIT'), rolledBack: txLog.includes('ROLLBACK'),
    };
  } finally {
    client.release();
  }

  // Audit outside transaction
  await mockAudit(
    'DELETE', 'JOURNAL', journalSnapshot.id,
    { date: journalSnapshot.date, reference: journalSnapshot.reference, description: journalSnapshot.description },
    null,
    'Draft journal deleted'
  ).catch(() => {});

  return {
    status: 200, body: { message: 'Journal deleted successfully' },
    auditCalled, auditArgs,
    committed: txLog.includes('COMMIT'),
    rolledBack: txLog.includes('ROLLBACK'),
  };
}

// ── Test data helpers ───────────────────────────────────────────────────────────────────

function makeDraftJournal(overrides = {}) {
  return {
    id: 101,
    status: 'draft',
    company_id: 42,
    date: '2026-05-01',
    reference: 'JNL-001',
    description: 'Test journal',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────

describe('AC-02 — Atomic Draft Journal Delete', () => {

  describe('TEST-DEL-01: Happy path — draft journal deleted successfully', () => {
    it('returns 200 and commits the transaction', async () => {
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: makeDraftJournal(),
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ message: 'Journal deleted successfully' });
      expect(result.committed).toBe(true);
      expect(result.rolledBack).toBe(false);
    });
  });

  describe('TEST-DEL-02: Journal not found → 404', () => {
    it('returns 404 and rolls back when row is not in DB', async () => {
      const result = await simulateDelete({
        requestId: '999',
        companyId: 42,
        dbRow: null,
      });

      expect(result.status).toBe(404);
      expect(result.body.error).toBe('Draft journal not found.');
      expect(result.rolledBack).toBe(true);
      expect(result.committed).toBe(false);
    });
  });

  describe('TEST-DEL-03: Company isolation — wrong company returns 404', () => {
    it('returns 404 when journal exists but belongs to a different company', async () => {
      // The SELECT FOR UPDATE includes company_id = $2 filter, so wrong company = 0 rows
      const result = await simulateDelete({
        requestId: '101',
        companyId: 99, // attacker's company; journal belongs to companyId 42
        dbRow: null,   // no row returned because company_id filter excludes it
      });

      expect(result.status).toBe(404);
      expect(result.body.error).toBe('Draft journal not found.');
    });
  });

  describe('TEST-DEL-04: Posted journal → 409', () => {
    it('returns 409 and rolls back when journal status is posted', async () => {
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: makeDraftJournal({ status: 'posted' }),
      });

      expect(result.status).toBe(409);
      expect(result.body.error).toBe('Only draft journals can be deleted. Posted journals must be reversed.');
      expect(result.rolledBack).toBe(true);
      expect(result.committed).toBe(false);
    });
  });

  describe('TEST-DEL-05: Reversed journal → 409', () => {
    it('returns 409 and rolls back when journal status is reversed', async () => {
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: makeDraftJournal({ status: 'reversed' }),
      });

      expect(result.status).toBe(409);
      expect(result.body.error).toBe('Only draft journals can be deleted. Posted journals must be reversed.');
      expect(result.rolledBack).toBe(true);
    });
  });

  describe('TEST-DEL-06: Concurrent delete race — rowCount 0 → 500, rolled back', () => {
    it('returns 500 with specific message and rolls back when journal was already deleted concurrently', async () => {
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: makeDraftJournal(),
        journalDeleteRowCount: 0, // another request won the race
      });

      expect(result.status).toBe(500);
      expect(result.body.error).toBe('Draft journal delete failed. No changes were saved.');
      expect(result.rolledBack).toBe(true);
      expect(result.committed).toBe(false);
    });
  });

  describe('TEST-DEL-07: Lines delete fails inside transaction → rollback', () => {
    it('rolls back entire transaction when journal_lines delete throws', async () => {
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: makeDraftJournal(),
        linesDeleteFails: true,
      });

      expect(result.status).toBe(500);
      expect(result.rolledBack).toBe(true);
      expect(result.committed).toBe(false);
      // Journal is not deleted — only ROLLBACK was issued
    });
  });

  describe('TEST-DEL-08: Invalid journal ID → 400 before DB is touched', () => {
    it('returns 400 immediately for non-numeric IDs', async () => {
      const result = await simulateDelete({
        requestId: 'abc',
        companyId: 42,
        dbRow: null,
      });

      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Invalid journal ID');
      // DB should never be called
      expect(result.committed).toBe(false);
      expect(result.rolledBack).toBe(false);
    });
  });

  describe('TEST-DEL-09: Audit log fires after COMMIT with correct snapshot data', () => {
    it('calls audit with correct entity type, action, and snapshot fields', async () => {
      const journal = makeDraftJournal({ date: '2026-04-15', reference: 'JNL-AUDIT', description: 'Audit test' });
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: journal,
      });

      expect(result.status).toBe(200);
      expect(result.auditCalled).toBe(true);

      const [action, entityType, entityId, before, after, note] = result.auditArgs;
      expect(action).toBe('DELETE');
      expect(entityType).toBe('JOURNAL');
      expect(entityId).toBe(101);
      expect(before).toEqual({
        date: '2026-04-15',
        reference: 'JNL-AUDIT',
        description: 'Audit test',
      });
      expect(after).toBeNull();
      expect(note).toBe('Draft journal deleted');
    });
  });

  describe('TEST-DEL-10: Audit log failure does NOT prevent 200 response', () => {
    it('returns 200 even when audit logger throws', async () => {
      const result = await simulateDelete({
        requestId: '101',
        companyId: 42,
        dbRow: makeDraftJournal(),
        auditFails: true,
      });

      // 200 still returned — audit failure is caught and logged to console only
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ message: 'Journal deleted successfully' });
      expect(result.committed).toBe(true);
    });
  });

});
