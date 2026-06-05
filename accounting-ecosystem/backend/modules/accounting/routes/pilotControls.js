'use strict';

/**
 * Pilot Controls Routes — /api/accounting/pilot/*
 *
 * Governance layer for real-client pilot operation.
 * Provides sign-off checklists, a risk register, and dashboard summary.
 *
 * All sign-offs are APPEND-ONLY (never overwrite prior history).
 * All mutations are audit-logged.
 *
 * ACC-CORE-032
 */

const express      = require('express');
const { authenticate, hasPermission } = require('../middleware/auth');
const db           = require('../config/database');
const AuditLogger  = require('../services/auditLogger');

const router = express.Router();

// ─── Checklist Templates ─────────────────────────────────────────────────────
// Hardcoded governance requirements — not user-configurable.
// Item ids become keys in the checklist_answers JSONB.

const CHECKLIST_TEMPLATES = {

  daily: {
    label: 'Daily Control Checklist',
    periodFormat: 'date',
    items: [
      { id: 'bank_imports_reviewed',        label: 'Bank imports reviewed for today' },
      { id: 'unreconciled_checked',         label: 'Unreconciled bank items checked' },
      { id: 'critical_diagnostics_clear',   label: 'No critical diagnostic findings outstanding' },
      { id: 'failed_transactions_reviewed', label: 'Failed or errored transactions reviewed' },
      { id: 'system_health_checked',        label: 'System health indicator checked' },
      { id: 'outstanding_approvals_done',   label: 'Outstanding approvals and draft journals actioned' },
    ],
  },

  weekly: {
    label: 'Weekly Control Checklist',
    periodFormat: 'week',
    items: [
      { id: 'ar_ageing_reviewed',           label: 'AR ageing vs AR control account reviewed' },
      { id: 'ap_ageing_reviewed',           label: 'AP ageing vs AP control account reviewed' },
      { id: 'bank_recon_status_reviewed',   label: 'Bank reconciliation status reviewed' },
      { id: 'duplicates_checked',           label: 'Duplicate bank imports checked' },
      { id: 'audit_log_reviewed',           label: 'Audit log exceptions reviewed' },
      { id: 'aged_items_investigated',      label: 'Items aged >60 days investigated and explained' },
      { id: 'diagnostics_reviewed',         label: 'Open diagnostic findings reviewed and documented' },
    ],
  },

  month_end: {
    label: 'Month-End Checklist',
    periodFormat: 'month',
    items: [
      { id: 'tb_balanced',                  label: 'Trial Balance is balanced (total DR = total CR)' },
      { id: 'pl_agrees_tb',                 label: 'P&L agrees to Trial Balance income/expense totals' },
      { id: 'bs_agrees_tb',                 label: 'Balance Sheet agrees to Trial Balance' },
      { id: 'ar_control_agrees',            label: 'AR control account agrees to aged debtors total' },
      { id: 'ap_control_agrees',            label: 'AP control account agrees to aged creditors total' },
      { id: 'vat_reviewed',                 label: 'VAT reviewed and period ready for submission' },
      { id: 'bank_reconciled',              label: 'All bank accounts reconciled for the period' },
      { id: 'diagnostics_passed',           label: 'All diagnostic checks passed (or exceptions documented)' },
      { id: 'unposted_journals_nil',        label: 'No unposted journals remain in the period' },
      { id: 'period_locked',                label: 'Accounting period locked after sign-off' },
    ],
  },

  vat: {
    label: 'VAT Checklist',
    periodFormat: 'month',
    items: [
      { id: 'vat_period_opened',            label: 'VAT period opened for correct date range' },
      { id: 'output_vat_reviewed',          label: 'Output VAT reviewed against sales invoices' },
      { id: 'input_vat_reviewed',           label: 'Input VAT reviewed against supplier invoices' },
      { id: 'vat_control_agrees',           label: 'VAT control account agrees to VAT return total' },
      { id: 'prior_adjustments_captured',   label: 'Prior period VAT adjustments captured' },
      { id: 'vat_period_locked',            label: 'VAT period locked after review' },
      { id: 'sars_payment_prepared',        label: 'SARS VAT payment / EFT prepared' },
    ],
  },

  bank_recon: {
    label: 'Bank Reconciliation Checklist',
    periodFormat: 'month',
    items: [
      { id: 'opening_balance_agrees',          label: 'Opening balance agrees to prior period closing statement' },
      { id: 'all_imports_done',                label: 'All bank statement lines imported for the period' },
      { id: 'outstanding_deposits_explained',  label: 'All outstanding deposits accounted for' },
      { id: 'outstanding_payments_explained',  label: 'All outstanding payments accounted for' },
      { id: 'closing_balance_agrees',          label: 'Closing balance agrees to bank statement' },
      { id: 'unmatched_items_explained',       label: 'All unmatched items explained or allocated' },
      { id: 'no_aged_unreconciled',            label: 'No unreconciled items aged >30 days remain' },
    ],
  },

  diagnostics: {
    label: 'Diagnostics Review',
    periodFormat: 'month',
    items: [
      { id: 'critical_findings_resolved',   label: 'All CRITICAL findings resolved or formally documented' },
      { id: 'ar_variance_investigated',     label: 'AR control variance investigated and explained' },
      { id: 'ap_variance_investigated',     label: 'AP control variance investigated and explained' },
      { id: 'vat_integrity_reviewed',       label: 'VAT integrity checks reviewed' },
      { id: 'journal_integrity_passed',     label: 'Journal integrity checks passed' },
      { id: 'audit_trail_healthy',          label: 'Audit trail health verified' },
    ],
  },

};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_TYPES = Object.keys(CHECKLIST_TEMPLATES);
const VALID_RISK_SEV  = ['critical', 'high', 'medium', 'low'];
const VALID_RISK_AREA = ['ar', 'ap', 'vat', 'bank', 'reporting', 'general'];
const VALID_RISK_STATUS = ['open', 'mitigated', 'resolved', 'accepted'];

function displayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
    || user.email
    || `User #${user.id}`;
}

// ─── GET /templates ─────────────────────────────────────────────────────────
// Returns all checklist templates so the frontend can render them dynamically.
router.get(
  '/templates',
  authenticate,
  hasPermission('pilot_controls.view'),
  (req, res) => {
    res.json({ templates: CHECKLIST_TEMPLATES });
  }
);

// ─── GET /dashboard ──────────────────────────────────────────────────────────
// Summary: latest sign-off per checklist type, open risk counts, recent history.
router.get(
  '/dashboard',
  authenticate,
  hasPermission('pilot_controls.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    try {
      // Latest sign-off per checklist type (DISTINCT ON = most recent per type)
      const latestRes = await db.query(`
        SELECT DISTINCT ON (checklist_type)
          id, checklist_type, period, signed_at, signed_by_name,
          has_exceptions, items_total, items_done, items_exception
        FROM pilot_signoffs
        WHERE company_id = $1
        ORDER BY checklist_type, signed_at DESC
      `, [companyId]);

      // Open risk summary
      const riskRes = await db.query(`
        SELECT
          COUNT(*)                                            AS total_open,
          COUNT(*) FILTER (WHERE severity = 'critical')      AS critical,
          COUNT(*) FILTER (WHERE severity = 'high')          AS high,
          COUNT(*) FILTER (WHERE severity = 'medium')        AS medium
        FROM pilot_risks
        WHERE company_id = $1
          AND status IN ('open', 'mitigated')
      `, [companyId]);

      // 15 most recent sign-offs across all types (for dashboard feed)
      const recentRes = await db.query(`
        SELECT id, checklist_type, period, signed_at, signed_by_name,
               has_exceptions, items_done, items_total
        FROM pilot_signoffs
        WHERE company_id = $1
        ORDER BY signed_at DESC
        LIMIT 15
      `, [companyId]);

      const latestMap = {};
      for (const row of latestRes.rows) {
        latestMap[row.checklist_type] = row;
      }

      res.json({
        latestSignoffs: latestMap,
        openRisks: {
          total:    parseInt(riskRes.rows[0]?.total_open || 0),
          critical: parseInt(riskRes.rows[0]?.critical   || 0),
          high:     parseInt(riskRes.rows[0]?.high       || 0),
          medium:   parseInt(riskRes.rows[0]?.medium     || 0),
        },
        recentSignoffs: recentRes.rows,
      });
    } catch (err) {
      console.error('[pilot/dashboard]', err);
      res.status(500).json({ error: 'Failed to load pilot dashboard' });
    }
  }
);

// ─── GET /signoffs ───────────────────────────────────────────────────────────
// List sign-offs for this company. Query params: type, period, limit (max 200).
router.get(
  '/signoffs',
  authenticate,
  hasPermission('pilot_controls.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const { type, period, limit = 50 } = req.query;

    const params   = [companyId];
    const clauses  = ['company_id = $1'];
    let   idx      = 2;

    if (type) {
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
      }
      clauses.push(`checklist_type = $${idx++}`);
      params.push(type);
    }
    if (period) {
      clauses.push(`period = $${idx++}`);
      params.push(period);
    }

    const limitN = Math.min(parseInt(limit) || 50, 200);
    params.push(limitN);

    try {
      const result = await db.query(
        `SELECT id, company_id, user_id, signed_by_name, period, checklist_type,
                has_exceptions, exceptions, notes,
                items_total, items_done, items_exception, items_na,
                signed_at, created_at
         FROM pilot_signoffs
         WHERE ${clauses.join(' AND ')}
         ORDER BY signed_at DESC
         LIMIT $${idx}`,
        params
      );
      res.json({ signoffs: result.rows });
    } catch (err) {
      console.error('[pilot/signoffs GET]', err);
      res.status(500).json({ error: 'Failed to load sign-offs' });
    }
  }
);

// ─── GET /signoffs/:id ───────────────────────────────────────────────────────
// Get a single sign-off including full checklist_answers.
router.get(
  '/signoffs/:id',
  authenticate,
  hasPermission('pilot_controls.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const id        = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    try {
      const result = await db.query(
        'SELECT * FROM pilot_signoffs WHERE id = $1 AND company_id = $2',
        [id, companyId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Sign-off not found' });
      res.json({ signoff: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load sign-off' });
    }
  }
);

// ─── POST /signoffs ──────────────────────────────────────────────────────────
// Create a new sign-off (append-only — previous sign-offs are never touched).
// Body: { checklist_type, period, checklist_answers, exceptions, notes }
router.post(
  '/signoffs',
  authenticate,
  hasPermission('pilot_controls.sign'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const userId    = req.user.id;
    const userName  = displayName(req.user);

    const { checklist_type, period, checklist_answers = {}, exceptions, notes } = req.body;

    if (!checklist_type || !period) {
      return res.status(400).json({ error: 'checklist_type and period are required' });
    }
    if (!VALID_TYPES.includes(checklist_type)) {
      return res.status(400).json({ error: `Invalid checklist_type. Must be: ${VALID_TYPES.join(', ')}` });
    }

    // Compute summary counts from the answers map
    const answers       = checklist_answers || {};
    const vals          = Object.values(answers);
    const total         = vals.length;
    const doneCount     = vals.filter(v => v === 'done').length;
    const excCount      = vals.filter(v => v === 'exception').length;
    const naCount       = vals.filter(v => v === 'na').length;
    const hasExceptions = excCount > 0;

    if (hasExceptions && (!exceptions || !exceptions.trim())) {
      return res.status(400).json({
        error: 'exceptions text is required when one or more items are marked Exception',
      });
    }

    try {
      const result = await db.query(`
        INSERT INTO pilot_signoffs
          (company_id, user_id, signed_by_name, period, checklist_type,
           checklist_answers, has_exceptions, exceptions, notes,
           items_total, items_done, items_exception, items_na,
           signed_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NOW())
        RETURNING *
      `, [
        companyId, userId, userName, period, checklist_type,
        JSON.stringify(answers),
        hasExceptions,
        exceptions ? exceptions.trim() : null,
        notes      ? notes.trim()      : null,
        total, doneCount, excCount, naCount,
      ]);

      await AuditLogger.logUserAction(
        req,
        'PILOT_SIGNOFF_CREATED',
        'PILOT_SIGNOFF',
        String(result.rows[0].id),
        null,
        { checklist_type, period, has_exceptions: hasExceptions, items_done: doneCount, items_total: total },
        null
      );

      res.status(201).json({ signoff: result.rows[0] });
    } catch (err) {
      console.error('[pilot/signoffs POST]', err);
      res.status(500).json({ error: 'Failed to create sign-off' });
    }
  }
);

// ─── GET /risks ──────────────────────────────────────────────────────────────
// List risks. Optional query: ?status=open
router.get(
  '/risks',
  authenticate,
  hasPermission('pilot_controls.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const { status } = req.query;

    const params  = [companyId];
    const clauses = ['company_id = $1'];

    if (status) {
      if (!VALID_RISK_STATUS.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be: ${VALID_RISK_STATUS.join(', ')}` });
      }
      clauses.push('status = $2');
      params.push(status);
    }

    try {
      const result = await db.query(`
        SELECT *
        FROM pilot_risks
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4
          END,
          CASE status WHEN 'open' THEN 1 WHEN 'mitigated' THEN 2 ELSE 3 END,
          created_at DESC
      `, params);
      res.json({ risks: result.rows });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load risks' });
    }
  }
);

// ─── POST /risks ─────────────────────────────────────────────────────────────
// Create a new risk.
// Body: { risk_title, severity, affected_area, mitigation, owner }
router.post(
  '/risks',
  authenticate,
  hasPermission('pilot_controls.risks'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const userId    = req.user.id;
    const userName  = displayName(req.user);

    const { risk_title, severity = 'medium', affected_area, mitigation, owner } = req.body;

    if (!risk_title || !risk_title.trim()) {
      return res.status(400).json({ error: 'risk_title is required' });
    }
    if (!VALID_RISK_SEV.includes(severity)) {
      return res.status(400).json({ error: `Invalid severity. Must be: ${VALID_RISK_SEV.join(', ')}` });
    }
    if (affected_area && !VALID_RISK_AREA.includes(affected_area)) {
      return res.status(400).json({ error: `Invalid affected_area. Must be: ${VALID_RISK_AREA.join(', ')}` });
    }

    try {
      const result = await db.query(`
        INSERT INTO pilot_risks
          (company_id, risk_title, severity, affected_area, mitigation, owner,
           status, created_by_user_id, created_by_name, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,NOW(),NOW())
        RETURNING *
      `, [
        companyId, risk_title.trim(), severity,
        affected_area || null, mitigation || null, owner || null,
        userId, userName,
      ]);

      await AuditLogger.logUserAction(
        req, 'PILOT_RISK_CREATED', 'PILOT_RISK', String(result.rows[0].id),
        null, { risk_title: risk_title.trim(), severity, affected_area }, null
      );

      res.status(201).json({ risk: result.rows[0] });
    } catch (err) {
      console.error('[pilot/risks POST]', err);
      res.status(500).json({ error: 'Failed to create risk' });
    }
  }
);

// ─── PUT /risks/:id ──────────────────────────────────────────────────────────
// Update a risk (status, mitigation, owner, severity, affected_area).
// Resolving a risk (status → 'resolved') stamps resolved_at and resolved_by.
router.put(
  '/risks/:id',
  authenticate,
  hasPermission('pilot_controls.risks'),
  async (req, res) => {
    const companyId = req.user.companyId;
    const userId    = req.user.id;
    const userName  = displayName(req.user);
    const id        = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    // Verify ownership and fetch existing state (needed for audit log before/after)
    const existRes = await db.query(
      'SELECT * FROM pilot_risks WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );
    if (!existRes.rows.length) return res.status(404).json({ error: 'Risk not found' });
    const existing = existRes.rows[0];

    // Build update payload from allowed fields only
    const ALLOWED = ['risk_title', 'severity', 'affected_area', 'mitigation', 'owner', 'status'];
    const updates = {};
    for (const f of ALLOWED) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Validation
    if (updates.severity     && !VALID_RISK_SEV.includes(updates.severity)) {
      return res.status(400).json({ error: `Invalid severity. Must be: ${VALID_RISK_SEV.join(', ')}` });
    }
    if (updates.affected_area && !VALID_RISK_AREA.includes(updates.affected_area)) {
      return res.status(400).json({ error: `Invalid affected_area. Must be: ${VALID_RISK_AREA.join(', ')}` });
    }
    if (updates.status && !VALID_RISK_STATUS.includes(updates.status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${VALID_RISK_STATUS.join(', ')}` });
    }

    // Stamp resolution fields when transitioning to 'resolved'
    const beingResolved = updates.status === 'resolved' && existing.status !== 'resolved';
    if (beingResolved) {
      updates.resolved_by_user_id = userId;
      updates.resolved_by_name    = userName;
      updates.resolved_at         = new Date().toISOString();
    }

    // Clear resolution fields when re-opening a resolved risk
    const beingReopened = updates.status === 'open' && existing.status === 'resolved';
    if (beingReopened) {
      updates.resolved_by_user_id = null;
      updates.resolved_by_name    = null;
      updates.resolved_at         = null;
    }

    updates.updated_at = new Date().toISOString();

    // Build parameterised SET clause
    const keys   = Object.keys(updates);
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
    const values     = [id, ...keys.map(k => updates[k]), companyId];

    try {
      const result = await db.query(
        `UPDATE pilot_risks
            SET ${setClauses.join(', ')}
          WHERE id = $1 AND company_id = $${keys.length + 2}
          RETURNING *`,
        values
      );

      await AuditLogger.logUserAction(
        req, 'PILOT_RISK_UPDATED', 'PILOT_RISK', String(id),
        existing, updates, null
      );

      res.json({ risk: result.rows[0] });
    } catch (err) {
      console.error('[pilot/risks PUT]', err);
      res.status(500).json({ error: 'Failed to update risk' });
    }
  }
);

module.exports = router;
