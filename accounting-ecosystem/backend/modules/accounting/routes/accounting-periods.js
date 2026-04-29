/**
 * ============================================================================
 * Accounting Periods — Period Locking API
 * ============================================================================
 * Manages accounting_periods rows for a company.
 * Locking a period activates the isPeriodLocked() guards already enforced
 * inside JournalService (createDraftJournal, updateDraftJournal, postJournal,
 * reverseJournal). No additional enforcement is needed in this route — locking
 * here is the mechanism, the service is the enforcement.
 *
 * All routes are prefixed /api/accounting/periods (via index.js mount).
 * All routes require authentication and company scoping.
 *
 * Period states (is_locked field):
 *   false → OPEN   — journals may be created, edited, posted, reversed
 *   true  → LOCKED — all write operations dated within the period are blocked
 *
 * Permission model:
 *   View periods:   any authenticated user
 *   Create/Lock:    role in [admin, accountant, business_owner] or isSuperAdmin
 *   Unlock/Delete:  role === 'admin' or isSuperAdmin  (higher bar — destructive)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticate } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

// ─── Permission helpers ───────────────────────────────────────────────────────

function requirePeriodManager(req, res, next) {
  const allowed = ['admin', 'accountant', 'business_owner', 'super_admin'];
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.isSuperAdmin || allowed.includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Period management requires accountant or admin access' });
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.isSuperAdmin || req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Unlocking or deleting a period requires admin access' });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/accounting/periods
 * List all accounting periods for the authenticated company, newest first.
 * Returns each period with a derived `status` field for UI clarity.
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('accounting_periods')
      .select('*')
      .eq('company_id', req.user.companyId)
      .order('from_date', { ascending: false });

    if (error) throw new Error(error.message);

    const periods = (data || []).map(p => ({
      ...p,
      status: p.is_locked ? 'locked' : 'open',
    }));

    res.json({ periods });
  } catch (err) {
    console.error('[accounting-periods] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to list accounting periods' });
  }
});

/**
 * GET /api/accounting/periods/check?date=YYYY-MM-DD
 * Quick check whether a specific date falls in a locked period.
 * Used by the frontend before showing a write form to give early warning.
 */
router.get('/check', authenticate, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date query parameter is required' });

    const { data } = await supabase
      .from('accounting_periods')
      .select('id, from_date, to_date')
      .eq('company_id', req.user.companyId)
      .lte('from_date', date)
      .gte('to_date', date)
      .eq('is_locked', true)
      .limit(1);

    const locked = !!(data && data.length > 0);
    res.json({
      date,
      locked,
      period: locked ? data[0] : null,
      message: locked
        ? `Date ${date} falls in a locked accounting period (${data[0].from_date}–${data[0].to_date})`
        : `Date ${date} is in an open period`,
    });
  } catch (err) {
    console.error('[accounting-periods] GET /check error:', err.message);
    res.status(500).json({ error: 'Failed to check period lock status' });
  }
});

/**
 * POST /api/accounting/periods
 * Create a new accounting period.
 * Body: { from_date: "YYYY-MM-DD", to_date: "YYYY-MM-DD" }
 *
 * Overlap check: new period must not overlap any existing period for this company.
 * Periods are locked independently — overlapping periods are ambiguous.
 */
router.post('/', authenticate, requirePeriodManager, async (req, res) => {
  try {
    const { from_date, to_date } = req.body;

    if (!from_date || !to_date) {
      return res.status(400).json({ error: 'from_date and to_date are required (YYYY-MM-DD)' });
    }
    if (from_date > to_date) {
      return res.status(400).json({ error: 'from_date must be before or equal to to_date' });
    }

    // Overlap check — a period may not share any day with another period
    const { data: overlapping, error: ovErr } = await supabase
      .from('accounting_periods')
      .select('id, from_date, to_date, is_locked')
      .eq('company_id', req.user.companyId)
      .lte('from_date', to_date)
      .gte('to_date', from_date);

    if (ovErr) throw new Error(ovErr.message);
    if (overlapping && overlapping.length > 0) {
      return res.status(409).json({
        error: 'The new period overlaps an existing accounting period',
        overlapping,
      });
    }

    const { data: period, error: insErr } = await supabase
      .from('accounting_periods')
      .insert({
        company_id: req.user.companyId,
        from_date,
        to_date,
        is_locked: false,
      })
      .select()
      .single();

    if (insErr) throw new Error(insErr.message);

    await AuditLogger.logUserAction(
      req, 'CREATE', 'ACCOUNTING_PERIOD', period.id,
      null,
      { from_date, to_date, is_locked: false },
      'Accounting period created'
    );

    res.status(201).json({ period: { ...period, status: 'open' } });
  } catch (err) {
    console.error('[accounting-periods] POST / error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create accounting period' });
  }
});

/**
 * POST /api/accounting/periods/:id/lock
 * Lock an open accounting period.
 *
 * Effect: all subsequent write operations (journal create/post/edit/reverse,
 * bank allocation, supplier/customer invoice create/edit) whose transaction
 * date falls within [from_date, to_date] will be rejected by JournalService
 * with a clear 400/403 error.
 *
 * This is non-destructive — no journal data changes.
 * Existing posted journals are unchanged; reports remain identical.
 */
router.post('/:id/lock', authenticate, requirePeriodManager, async (req, res) => {
  try {
    const periodId = parseInt(req.params.id);
    if (isNaN(periodId)) return res.status(400).json({ error: 'Invalid period ID' });

    const { data: period, error: fetchErr } = await supabase
      .from('accounting_periods')
      .select('*')
      .eq('id', periodId)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !period) return res.status(404).json({ error: 'Accounting period not found' });
    if (period.is_locked) return res.status(409).json({ error: 'Period is already locked' });

    const { data: locked, error: lockErr } = await supabase
      .from('accounting_periods')
      .update({
        is_locked:          true,
        locked_by_user_id:  req.user.id,
      })
      .eq('id', periodId)
      .eq('company_id', req.user.companyId)  // tenant safety on write
      .select()
      .single();

    if (lockErr) throw new Error(lockErr.message);

    await AuditLogger.logUserAction(
      req, 'LOCK', 'ACCOUNTING_PERIOD', periodId,
      { is_locked: false },
      { is_locked: true, locked_by_user_id: req.user.id },
      `Accounting period locked: ${period.from_date} – ${period.to_date}`
    );

    res.json({
      period:  { ...locked, status: 'locked' },
      message: `Period ${period.from_date}–${period.to_date} is now locked. All write operations dated within this period are blocked.`,
    });
  } catch (err) {
    console.error('[accounting-periods] POST /:id/lock error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to lock accounting period' });
  }
});

/**
 * POST /api/accounting/periods/:id/unlock
 * Unlock a locked period — ADMIN ONLY.
 *
 * Use with extreme care. Unlocking allows historical journals, invoices, and
 * bank allocations dated within this period to be created, edited, or reversed
 * again. This can change previously finalized financial statements.
 *
 * Intended only for error correction under controlled circumstances.
 * Every unlock is audit-logged.
 */
router.post('/:id/unlock', authenticate, requireAdmin, async (req, res) => {
  try {
    const periodId = parseInt(req.params.id);
    if (isNaN(periodId)) return res.status(400).json({ error: 'Invalid period ID' });

    const { data: period, error: fetchErr } = await supabase
      .from('accounting_periods')
      .select('*')
      .eq('id', periodId)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !period) return res.status(404).json({ error: 'Accounting period not found' });
    if (!period.is_locked) return res.status(409).json({ error: 'Period is not locked' });

    const { data: unlocked, error: unlockErr } = await supabase
      .from('accounting_periods')
      .update({
        is_locked:          false,
        locked_by_user_id:  null,
      })
      .eq('id', periodId)
      .eq('company_id', req.user.companyId)  // tenant safety on write
      .select()
      .single();

    if (unlockErr) throw new Error(unlockErr.message);

    await AuditLogger.logUserAction(
      req, 'UNLOCK', 'ACCOUNTING_PERIOD', periodId,
      { is_locked: true, locked_by_user_id: period.locked_by_user_id },
      { is_locked: false },
      `Accounting period UNLOCKED: ${period.from_date} – ${period.to_date}. Historical entries may now be modified.`
    );

    res.json({
      period:  { ...unlocked, status: 'open' },
      message: `Period ${period.from_date}–${period.to_date} has been unlocked. Historical entries within this period may now be modified.`,
    });
  } catch (err) {
    console.error('[accounting-periods] POST /:id/unlock error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to unlock accounting period' });
  }
});

/**
 * DELETE /api/accounting/periods/:id
 * Delete an OPEN (unlocked) period — ADMIN ONLY.
 * Locked periods cannot be deleted; they must be unlocked first.
 * Deleting a period has no effect on journals — it only removes the lock-guard.
 */
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const periodId = parseInt(req.params.id);
    if (isNaN(periodId)) return res.status(400).json({ error: 'Invalid period ID' });

    const { data: period, error: fetchErr } = await supabase
      .from('accounting_periods')
      .select('id, from_date, to_date, is_locked')
      .eq('id', periodId)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !period) return res.status(404).json({ error: 'Accounting period not found' });
    if (period.is_locked) {
      return res.status(409).json({
        error: 'Cannot delete a locked period. Unlock it first (admin access required).',
      });
    }

    const { error: delErr } = await supabase
      .from('accounting_periods')
      .delete()
      .eq('id', periodId)
      .eq('company_id', req.user.companyId);  // tenant safety on write

    if (delErr) throw new Error(delErr.message);

    await AuditLogger.logUserAction(
      req, 'DELETE', 'ACCOUNTING_PERIOD', periodId,
      { from_date: period.from_date, to_date: period.to_date },
      null,
      'Accounting period deleted'
    );

    res.json({ message: 'Accounting period deleted' });
  } catch (err) {
    console.error('[accounting-periods] DELETE /:id error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete accounting period' });
  }
});

module.exports = router;
