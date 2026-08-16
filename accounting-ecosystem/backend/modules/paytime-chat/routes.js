/**
 * ============================================================================
 * Paytime Sean Chat — API Routes
 * ============================================================================
 * Superuser-only chat-to-payroll-action feature (SEVCO Phase 2). Deliberately
 * lives OUTSIDE backend/modules/payroll/** so this module is not covered by
 * the CRITICAL protected-file glob in paytime.protected.json — instead of
 * writing to payroll tables directly, every write goes through the SAME
 * validated routes the Paytime UI itself uses
 * (transactions.js /overtime, /short-time, /inputs; employees.js
 * /:id/salary), called here as an authenticated internal HTTP request that
 * forwards the acting user's own JWT — so the downstream route's own
 * requirePermission('PAYROLL.CREATE') check runs exactly as it would for a
 * browser tab. This module never touches payroll_overtime, payroll_short_
 * time, payroll_period_inputs, or employees directly for writes.
 *
 * Two safety additions the underlying routes do NOT provide (see plan):
 *   1. An explicit payroll_snapshots.is_locked pre-check — the underlying
 *      routes have none; without this a write to a locked/finalized period
 *      would be silently swallowed later by /calculate's short-circuit
 *      rather than blocked, which is worse UX than an error.
 *   2. Read-before-write for /overtime, /short-time, /inputs — those routes
 *      replace the FULL set for an employee+period (delete-then-insert), so
 *      a naive single-item POST would wipe every other entry. This module
 *      always fetches existing entries via GET /period-inputs first.
 *
 * Endpoints:
 *   GET  /status   — is 'paytime_chat' activated for the target company?
 *   POST /activate — activate it (adds to eco_clients.addons via the real
 *                    PUT /api/eco-clients/:id route, same as admin.html).
 *   POST /parse    — text -> { recipe, slots, employee/candidates } — no writes.
 *   POST /execute  — confirmed recipe+slots -> real payroll write, logged to
 *                    sean_paytime_chat_actions.
 * All routes requireSuperAdmin. /parse and /execute additionally require the
 * target company to have 'paytime_chat' activated (SEVCO Phase 2b) — this is
 * the same eco_clients.addons / companies.modules_enabled mechanism every
 * other opt-in ecosystem capability uses (CLAUDE.md Rule H2), not a bespoke
 * flag. Phase-1-style trust escalation on top: only superusers can ever
 * activate or use it, mirroring the IRP5 precedent.
 * ============================================================================
 */

'use strict';

const express = require('express');
const router = express.Router();

const { requireSuperAdmin } = require('../../middleware/auth');
const { supabase } = require('../../config/database');
const { parseRecipeRequest, RECIPES } = require('./recipe-parser');

router.use(requireSuperAdmin);

const INTERNAL_BASE = process.env.INTERNAL_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

function currentPeriodKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function callInternal(req, method, path, body) {
  const res = await fetch(`${INTERNAL_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': req.headers.authorization || '',
      'X-Company-Id': String(req.companyId || ''),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function isPaytimeChatEnabled(companyId) {
  const { data } = await supabase
    .from('companies')
    .select('modules_enabled')
    .eq('id', companyId)
    .maybeSingle();
  return !!(data && Array.isArray(data.modules_enabled) && data.modules_enabled.includes('paytime_chat'));
}

// ─── GET /status — is paytime_chat activated for the target company? ───────

router.get('/status', async (req, res) => {
  try {
    const enabled = await isPaytimeChatEnabled(req.companyId);
    res.json({ enabled });
  } catch (err) {
    console.error('[paytime-chat] /status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /activate — turn paytime_chat on for the target company ──────────
// Resolves the eco_clients row for this company, then goes through the real
// PUT /api/eco-clients/:id route (same one admin.html uses) so the addon
// sync-to-companies.modules_enabled block there is the single place that
// logic lives — never written to eco_clients/companies directly a second time.

router.post('/activate', async (req, res) => {
  try {
    const { data: ecoClient, error } = await supabase
      .from('eco_clients')
      .select('id, addons')
      .eq('client_company_id', req.companyId)
      .maybeSingle();

    if (error || !ecoClient) {
      return res.status(404).json({ error: 'No eco_client record found for this company — cannot activate.' });
    }

    const addons = ecoClient.addons || [];
    if (addons.includes('paytime_chat')) {
      return res.json({ enabled: true });
    }

    const result = await callInternal(req, 'PUT', `/api/eco-clients/${ecoClient.id}`, {
      addons: [...addons, 'paytime_chat'],
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.data?.error || 'Could not activate Sean Chat' });
    }

    res.json({ enabled: true });
  } catch (err) {
    console.error('[paytime-chat] /activate error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

function scoreNameMatch(candidateWordsLower, employee) {
  const first = (employee.first_name || '').toLowerCase();
  const last = (employee.last_name || '').toLowerCase();
  let best = 0;
  for (const w of candidateWordsLower) {
    if (w === first || w === last) best = Math.max(best, 3);
    else if (first.startsWith(w) || last.startsWith(w)) best = Math.max(best, 2);
    else if (first.includes(w) || last.includes(w)) best = Math.max(best, 1);
  }
  return best;
}

async function resolveEmployee(req, nameCandidates) {
  if (!nameCandidates.length) return { employee: null, candidates: [] };

  const { ok, data } = await callInternal(req, 'GET', '/api/payroll/employees');
  if (!ok) return { employee: null, candidates: [] };

  const lower = nameCandidates.map(w => w.toLowerCase());
  const scored = (data.employees || [])
    .map(e => ({ employee: e, score: scoreNameMatch(lower, e) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { employee: null, candidates: [] };

  const topScore = scored[0].score;
  const top = scored.filter(x => x.score === topScore);

  if (top.length === 1) {
    return { employee: top[0].employee, candidates: [] };
  }
  return { employee: null, candidates: top.map(x => x.employee) };
}

// ─── POST /parse — text -> recipe + slots + employee, writes nothing ────────

router.post('/parse', async (req, res) => {
  try {
    if (!(await isPaytimeChatEnabled(req.companyId))) {
      return res.status(403).json({ error: 'Sean Chat is nie vir hierdie maatskappy geaktiveer nie.' });
    }

    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }

    const { recipe, slots, nameCandidates } = parseRecipeRequest(text);

    if (!recipe) {
      return res.json({
        recipe: null,
        message: "Ek verstaan nie daardie versoek nie — probeer bv. \"gee Jan 5 ure oortyd\" of \"salaris vir Jan na R25000\".",
      });
    }

    const { employee, candidates } = await resolveEmployee(req, nameCandidates);

    const warnings = [];
    if (!employee && candidates.length > 1) {
      warnings.push(`Meer as een werknemer pas — kies een: ${candidates.map(c => `${c.first_name} ${c.last_name}`).join(', ')}`);
    } else if (!employee) {
      warnings.push('Kon nie \'n werknemer met daardie naam vind nie.');
    }
    if (recipe === 'ADJUST_SALARY' && employee) {
      warnings.push(`Let wel: dit verander ${employee.first_name} se lopende salaris (nie net hierdie periode nie) — dieselfde gedrag as die normale Paytime-skerm.`);
    }
    if ((recipe === 'ADD_OVERTIME' || recipe === 'ADD_SHORT_TIME') && slots.hours === undefined) {
      warnings.push('Geen ure-getal in die versoek gevind nie.');
    }
    if ((recipe === 'ADD_PAYSLIP_ITEM' || recipe === 'ADJUST_SALARY') && slots.amount === undefined) {
      warnings.push('Geen bedrag in die versoek gevind nie.');
    }

    res.json({
      recipe,
      slots,
      periodKey: currentPeriodKey(),
      employee: employee ? { id: employee.id, firstName: employee.first_name, lastName: employee.last_name } : null,
      candidates: candidates.map(c => ({ id: c.id, firstName: c.first_name, lastName: c.last_name })),
      warnings,
    });
  } catch (err) {
    console.error('[paytime-chat] /parse error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /execute — confirmed recipe+slots -> real payroll write ──────────

router.post('/execute', async (req, res) => {
  const { text, recipe, employeeId, periodKey, slots } = req.body;

  if (!(await isPaytimeChatEnabled(req.companyId))) {
    return res.status(403).json({ error: 'Sean Chat is nie vir hierdie maatskappy geaktiveer nie.' });
  }
  if (!RECIPES.includes(recipe)) {
    return res.status(400).json({ error: 'Unknown or missing recipe' });
  }
  if (!employeeId || !periodKey) {
    return res.status(400).json({ error: 'employeeId and periodKey are required' });
  }

  const logRow = {
    company_id: req.companyId,
    employee_id: employeeId,
    requested_by: req.user?.userId || null,
    raw_text: text || '',
    matched_recipe: recipe,
    slots: slots || {},
    period_key: periodKey,
    lock_check_result: 'not_checked',
    execution_result: null,
  };

  try {
    // ── Safety check #1: never write into a finalized/locked period ──────
    const { data: snapshot } = await supabase
      .from('payroll_snapshots')
      .select('is_locked')
      .eq('company_id', req.companyId)
      .eq('employee_id', employeeId)
      .eq('period_key', periodKey)
      .maybeSingle();

    if (snapshot && snapshot.is_locked) {
      logRow.lock_check_result = 'locked_refused';
      logRow.execution_result = { success: false, error: 'Period is locked' };
      await supabase.from('sean_paytime_chat_actions').insert(logRow);
      return res.status(409).json({
        error: 'Hierdie periode is reeds gefinaliseer en gesluit — dit mag nie via chat verander word nie.',
      });
    }
    logRow.lock_check_result = 'unlocked';

    let result;

    if (recipe === 'ADD_OVERTIME' || recipe === 'ADD_SHORT_TIME') {
      // ── Safety check #2: these routes replace the FULL set — read existing first ──
      const existingRes = await callInternal(
        req, 'GET',
        `/api/payroll/transactions/period-inputs?employee_id=${employeeId}&period_key=${encodeURIComponent(periodKey)}`
      );
      if (!existingRes.ok) throw new Error('Could not load existing entries before write');

      if (recipe === 'ADD_OVERTIME') {
        const existing = (existingRes.data.overtime || []).map(e => ({
          hours: e.hours, rate_multiplier: e.rate_multiplier, description: e.description,
        }));
        const entries = [...existing, {
          hours: slots.hours, rate_multiplier: slots.rateMultiplier || 1.5, description: slots.description || 'Overtime',
        }];
        result = await callInternal(req, 'POST', '/api/payroll/transactions/overtime', { employee_id: employeeId, period_key: periodKey, entries });
      } else {
        const existing = (existingRes.data.shortTime || []).map(e => ({
          hours_missed: e.hours_missed, description: e.description,
        }));
        const entries = [...existing, { hours_missed: slots.hours, description: slots.description || 'Short time' }];
        result = await callInternal(req, 'POST', '/api/payroll/transactions/short-time', { employee_id: employeeId, period_key: periodKey, entries });
      }
    } else if (recipe === 'ADD_PAYSLIP_ITEM') {
      const existingRes = await callInternal(
        req, 'GET',
        `/api/payroll/transactions/period-inputs?employee_id=${employeeId}&period_key=${encodeURIComponent(periodKey)}`
      );
      if (!existingRes.ok) throw new Error('Could not load existing entries before write');

      const existing = (existingRes.data.currentInputs || []).map(i => ({
        type: i.item_type, description: i.description, amount: i.amount,
      }));
      const inputs = [...existing, {
        type: slots.itemType || 'earning', description: slots.description || 'Item', amount: slots.amount,
      }];
      result = await callInternal(req, 'POST', '/api/payroll/transactions/inputs', { employee_id: employeeId, period_key: periodKey, inputs });
    } else if (recipe === 'ADJUST_SALARY') {
      result = await callInternal(req, 'PUT', `/api/payroll/employees/${employeeId}/salary`, { basic_salary: slots.amount });
    }

    logRow.execution_result = { success: result.ok, status: result.status, response: result.data };
    await supabase.from('sean_paytime_chat_actions').insert(logRow);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.data?.error || 'Payroll write failed' });
    }
    res.json({ success: true, result: result.data });
  } catch (err) {
    console.error('[paytime-chat] /execute error:', err.message);
    logRow.execution_result = { success: false, error: err.message };
    await supabase.from('sean_paytime_chat_actions').insert(logRow).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
