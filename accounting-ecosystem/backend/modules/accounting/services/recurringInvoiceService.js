/**
 * ============================================================================
 * Recurring Invoice Service — "annual or monthly" billing (migration 178)
 * ============================================================================
 * Ruan, 2026-11-11: clients must be able to see "this is the annual amount,
 * this is the monthly amount" on a quote/invoice, opt-in per document. When
 * the client chooses monthly, Leo creates, POSTS and EMAILS each monthly
 * invoice automatically until the plan is finished.
 *
 * Flow
 *   chooseBilling(..., 'annual')  → invoice.billing_choice='annual'; the user
 *                                   posts it as a normal invoice.
 *   chooseBilling(..., 'monthly') → one transaction:
 *       - customer_invoice_recurring_plans row created from the invoice's
 *         ANNUAL lines (frozen as JSON — the single source for every
 *         instalment, so rounding can never drift month to month)
 *       - the draft itself becomes instalment 1 (its lines rewritten to the
 *         monthly amounts)
 *     then runPlan() immediately, so instalment 1 is posted + emailed right
 *     away when its date has arrived.
 *   runDuePlans() (hourly + on demand) → for every active plan, every
 *     instalment whose date ≤ today (Africa/Johannesburg) is created (once —
 *     DB unique index), posted, and emailed.
 *
 * Money rule: each annual line's unit price is split into N parts rounded to
 * the cent; the LAST instalment takes the rounding remainder, so the N
 * instalments' ex-VAT (EX mode) or gross (INC mode) amounts add up to the
 * annual line amount exactly. VAT is calculated per invoice from that
 * invoice's own lines (each is a valid tax invoice), so total VAT over the
 * plan can differ from the annual quote's VAT by a few cents of rounding.
 *
 * Safety
 *   - Posting/emailing reuse customerInvoiceCore (same guards as the Post /
 *     Send buttons: double-post guard, period locks, audit trail).
 *   - A Postgres advisory lock makes sure only one runner works at a time,
 *     even with several server instances; the unique index is the backstop.
 *   - A failure on one plan never stops the others; the error is stored on
 *     the plan (last_error) and shown in the UI, and the run retries next hour.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../../config/database');
const db = require('../config/database');
const AuditLogger = require('./auditLogger');
const {
  calcLineVAT, postCustomerInvoice, emailCustomerInvoice,
} = require('./customerInvoiceCore');

const ADVISORY_LOCK_KEY = 717801; // arbitrary constant, unique to this runner
const RUN_INTERVAL_MS   = 60 * 60 * 1000; // hourly
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // let the server finish booting

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Today's date (YYYY-MM-DD) in South Africa — invoices are dated in SA time. */
function todaySA(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Date of instalment n (1-based): start date + (n-1) months, keeping the
 * start day-of-month but clamping to the month's last day
 * (31 Jan → 28/29 Feb → 31 Mar).
 */
function instalmentDate(startDate, n) {
  const [y, m, d] = String(startDate).slice(0, 10).split('-').map(Number);
  const monthIndex = (m - 1) + (n - 1);
  const year  = y + Math.floor(monthIndex / 12);
  const month = monthIndex % 12; // 0-based
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateStr, days) {
  const dt = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + (parseInt(days, 10) || 0));
  return dt.toISOString().slice(0, 10);
}

/** Unit price of instalment n out of total for one annual unit price. */
function splitUnitPrice(annualUnitPrice, total, n) {
  const price = Number(annualUnitPrice) || 0;
  const base  = round2(price / total);
  return n < total ? base : round2(price - base * (total - 1));
}

/**
 * Builds instalment n's invoice lines + header totals from the plan's frozen
 * annual lines. Returns { lines: [...], totals: {subtotalExVat, vatAmount, totalIncVat} }.
 */
function buildInstalment(annualLines, total, n, vatInclusive) {
  const lines = (annualLines || []).map((l) => {
    const unitPrice = splitUnitPrice(l.unit_price, total, n);
    const vatRate   = l.vat_rate != null ? Number(l.vat_rate) : 15;
    const quantity  = Number(l.quantity) || 1;
    const { subtotalExVat, vatAmount, totalIncVat } = calcLineVAT(quantity, unitPrice, vatRate, vatInclusive);
    return {
      description: l.description || '',
      account_id:  l.account_id || null,
      line_type:   l.line_type === 'item' ? 'item' : 'account',
      item_id:     l.item_id || null,
      quantity, unit_price: unitPrice, vat_rate: vatRate,
      subtotalExVat, vatAmount, totalIncVat,
    };
  });
  const totals = lines.reduce((a, l) => ({
    subtotalExVat: round2(a.subtotalExVat + l.subtotalExVat),
    vatAmount:     round2(a.vatAmount + l.vatAmount),
    totalIncVat:   round2(a.totalIncVat + l.totalIncVat),
  }), { subtotalExVat: 0, vatAmount: 0, totalIncVat: 0 });
  return { lines, totals };
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function insertInvoiceLines(client, invoiceId, lines) {
  if (!lines.length) return;
  const vals = [];
  const params = [];
  let p = 1;
  for (const l of lines) {
    vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
    params.push(invoiceId, l.description, l.account_id, l.line_type, l.item_id, l.quantity, l.unit_price, l.vat_rate, l.subtotalExVat);
  }
  await client.query(
    `INSERT INTO customer_invoice_lines
       (invoice_id, description, account_id, line_type, item_id, quantity, unit_price, vat_rate, line_total)
     VALUES ${vals.join(',')}`,
    params
  );
}

/**
 * Next free INV-#### number for the company. Same count+1 convention as the
 * invoice/quote routes, but skips numbers that are already taken (the
 * company+number unique index would otherwise reject the insert).
 */
async function nextInvoiceNumber(client, companyId) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS c FROM customer_invoices WHERE company_id = $1', [companyId]);
  let n = (rows[0]?.c || 0) + 1;
  for (let i = 0; i < 500; i++, n++) {
    const candidate = `INV-${String(n).padStart(4, '0')}`;
    const { rows: hit } = await client.query(
      'SELECT 1 FROM customer_invoices WHERE company_id = $1 AND invoice_number = $2 LIMIT 1', [companyId, candidate]
    );
    if (!hit.length) return candidate;
  }
  throw new Error('Could not find a free invoice number');
}

/** Creates instalment n of a plan as a DRAFT invoice. Idempotent. Returns the invoice id. */
async function ensureInstalmentInvoice(plan, n) {
  const client = await db.getClient();
  try {
    const existing = await client.query(
      'SELECT id FROM customer_invoices WHERE recurring_plan_id = $1 AND recurring_instalment_no = $2',
      [plan.id, n]
    );
    if (existing.rows.length) return existing.rows[0].id;

    const date = instalmentDate(plan.start_date, n);
    const { lines, totals } = buildInstalment(plan.annual_lines, plan.instalments_total, n, plan.vat_mode === 'inclusive');

    await client.query('BEGIN');
    const invoiceNumber = await nextInvoiceNumber(client, plan.company_id);
    const ins = await client.query(
      `INSERT INTO customer_invoices
         (company_id, customer_id, invoice_number, date, due_date, status, vat_mode,
          subtotal, vat_amount, total_amount, amount_paid, balance_due, notes, created_by,
          billing_option_enabled, billing_choice, recurring_plan_id, recurring_instalment_no)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,0,$9,$10,$11,true,'monthly',$12,$13)
       ON CONFLICT (recurring_plan_id, recurring_instalment_no) WHERE recurring_plan_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        plan.company_id, plan.customer_id, invoiceNumber, date, addDays(date, plan.due_days),
        plan.vat_mode, totals.subtotalExVat, totals.vatAmount, totals.totalIncVat,
        plan.notes || null, plan.created_by || null, plan.id, n,
      ]
    );
    if (!ins.rows.length) {
      // Another runner created it between our check and insert — use theirs.
      await client.query('ROLLBACK');
      const again = await client.query(
        'SELECT id FROM customer_invoices WHERE recurring_plan_id = $1 AND recurring_instalment_no = $2', [plan.id, n]
      );
      return again.rows[0]?.id || null;
    }
    const invoiceId = ins.rows[0].id;
    await insertInvoiceLines(client, invoiceId, lines);
    await client.query('COMMIT');

    await AuditLogger.log({
      companyId: plan.company_id, actorType: 'SYSTEM', actorId: plan.created_by || null,
      actionType: 'CUSTOMER_INVOICE_CREATED', entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
      beforeJson: null,
      afterJson: { invoiceNumber, invoiceDate: date, recurringPlanId: plan.id, instalmentNo: n, totalIncVat: totals.totalIncVat, status: 'draft' },
      reason: `Monthly billing plan ${plan.id}: instalment ${n} of ${plan.instalments_total} created`,
    });
    return invoiceId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Run one plan ────────────────────────────────────────────────────────────

/**
 * Brings one plan up to date: every instalment whose date has arrived is
 * created, posted (auto_post) and emailed (auto_email). Returns a summary.
 */
async function runPlan(plan, { today = todaySA() } = {}) {
  const summary = { planId: plan.id, created: 0, posted: 0, emailed: 0, errors: [] };
  if (plan.status !== 'active') return summary;
  const sys = { companyId: plan.company_id, actorId: plan.created_by || null, actorType: 'SYSTEM' };

  for (let n = 1; n <= plan.instalments_total; n++) {
    if (instalmentDate(plan.start_date, n) > today) break; // future months wait

    // Re-check the plan is still active right before touching each month —
    // a user may have stopped it while this run was busy. Without this, a
    // run that started before "Stop plan" could still create/post a month.
    const { data: live } = await supabase.from('customer_invoice_recurring_plans')
      .select('status').eq('id', plan.id).eq('company_id', plan.company_id).maybeSingle();
    if (!live || live.status !== 'active') { summary.stopped = true; break; }

    let { data: inv } = await supabase.from('customer_invoices')
      .select('id, status, emailed_at, invoice_number')
      .eq('recurring_plan_id', plan.id).eq('recurring_instalment_no', n).maybeSingle();

    if (!inv) {
      const id = await ensureInstalmentInvoice(plan, n);
      summary.created++;
      ({ data: inv } = await supabase.from('customer_invoices')
        .select('id, status, emailed_at, invoice_number').eq('id', id).maybeSingle());
      if (!inv) { summary.errors.push(`Instalment ${n}: could not be created`); break; }
    }

    if (inv.status === 'void') continue; // voided deliberately by a user — leave it

    if (inv.status === 'draft') {
      if (!plan.auto_post) continue;
      const r = await postCustomerInvoice({ ...sys, invoiceId: inv.id });
      if (r.status !== 200) {
        // Stop here — later months must not be posted ahead of an earlier
        // one that failed (e.g. a locked period). Retried next run.
        summary.errors.push(`Instalment ${n} (${inv.invoice_number}) could not be posted: ${r.body?.error || r.status}`);
        break;
      }
      summary.posted++;
      inv.status = 'sent';
    }

    if (plan.auto_email && !inv.emailed_at) {
      const r = await emailCustomerInvoice({ ...sys, invoiceId: inv.id });
      if (r.status === 200) summary.emailed++;
      // Email failure does not stop posting of later months — the invoice
      // is valid either way; it is retried every run and shown in the UI.
      else summary.errors.push(`Instalment ${n} (${inv.invoice_number}) posted but NOT emailed: ${r.body?.error || r.status}`);
    }
  }

  // Completed once every instalment exists and none is still waiting to be
  // posted or emailed (void counts as done).
  const { data: all } = await supabase.from('customer_invoices')
    .select('status, emailed_at').eq('recurring_plan_id', plan.id);
  const finished = (all || []).length >= plan.instalments_total
    && (all || []).every((i) => i.status === 'void' || (i.status !== 'draft' && (!plan.auto_email || i.emailed_at)));

  // Only an ACTIVE plan is updated/completed here — never resurrect or
  // overwrite a plan that was stopped while this run was busy.
  await supabase.from('customer_invoice_recurring_plans').update({
    last_run_at: new Date().toISOString(),
    last_error:  summary.errors.length ? summary.errors.join(' | ').slice(0, 2000) : null,
    ...(finished ? { status: 'completed' } : {}),
    updated_at:  new Date().toISOString(),
  }).eq('id', plan.id).eq('company_id', plan.company_id).eq('status', 'active');

  if (finished) summary.completed = true;
  return summary;
}

// ─── Run all due plans ───────────────────────────────────────────────────────

let _running = false;

/**
 * Runs every active plan (optionally only one company's). Uses a Postgres
 * advisory lock so only one runner works at a time across instances; if the
 * lock is busy this run is simply skipped (the next run catches up).
 */
async function runDuePlans({ companyId = null } = {}) {
  if (_running) return { skipped: true, reason: 'already running in this process' };
  _running = true;
  let lockClient = null;
  try {
    lockClient = await db.getClient();
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY]);
    if (!rows[0]?.got) return { skipped: true, reason: 'another runner holds the lock' };

    try {
      let q = supabase.from('customer_invoice_recurring_plans').select('*').eq('status', 'active').order('id');
      if (companyId) q = q.eq('company_id', companyId);
      const { data: plans, error } = await q;
      if (error) throw new Error(error.message);

      const results = [];
      for (const plan of plans || []) {
        try {
          results.push(await runPlan(plan));
        } catch (err) {
          console.error(`[RecurringInvoices] plan ${plan.id} failed:`, err.message);
          results.push({ planId: plan.id, errors: [err.message] });
          await supabase.from('customer_invoice_recurring_plans')
            .update({ last_run_at: new Date().toISOString(), last_error: err.message.slice(0, 2000) })
            .eq('id', plan.id);
        }
      }
      return { skipped: false, plans: results.length, results };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    if (lockClient) lockClient.release();
    _running = false;
  }
}

// ─── Record the client's choice ──────────────────────────────────────────────

/**
 * ctx = { companyId, invoiceId, choice ('annual'|'monthly'), actorId, ipAddress, userAgent }
 * Returns { status, body }.
 */
async function chooseBilling(ctx) {
  const { companyId, invoiceId, choice, actorId = null, ipAddress = null, userAgent = null } = ctx;
  if (!['annual', 'monthly'].includes(choice)) {
    return { status: 400, body: { error: "choice must be 'annual' or 'monthly'" } };
  }

  const client = await db.getClient();
  let planId = null;
  let before = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT *, to_char(date, 'YYYY-MM-DD') AS date_s, to_char(due_date, 'YYYY-MM-DD') AS due_s
         FROM customer_invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`, [invoiceId, companyId]
    );
    const inv = rows[0];
    if (!inv) { await client.query('ROLLBACK'); return { status: 404, body: { error: 'Invoice not found' } }; }
    before = { billing_choice: inv.billing_choice, total_amount: inv.total_amount };
    if (inv.status !== 'draft' || inv.journal_id != null) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'The billing choice can only be recorded on a draft invoice.' } };
    }
    if (!inv.billing_option_enabled) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: 'This invoice does not offer an annual / monthly option.' } };
    }
    if (inv.billing_choice) {
      await client.query('ROLLBACK');
      return { status: 409, body: { error: `The client's choice is already recorded as ${inv.billing_choice}.` } };
    }

    if (choice === 'annual') {
      await client.query(
        "UPDATE customer_invoices SET billing_choice = 'annual', updated_at = NOW() WHERE id = $1 AND company_id = $2",
        [invoiceId, companyId]
      );
      await client.query('COMMIT');
    } else {
      const { rows: lineRows } = await client.query(
        'SELECT description, account_id, line_type, item_id, quantity, unit_price, vat_rate FROM customer_invoice_lines WHERE invoice_id = $1 ORDER BY id',
        [invoiceId]
      );
      if (!lineRows.length) {
        await client.query('ROLLBACK');
        return { status: 422, body: { error: 'The invoice has no lines to split into monthly instalments.' } };
      }
      const annualLines = lineRows.map((l) => ({
        description: l.description, account_id: l.account_id, line_type: l.line_type, item_id: l.item_id,
        quantity: Number(l.quantity), unit_price: Number(l.unit_price), vat_rate: l.vat_rate != null ? Number(l.vat_rate) : 15,
      }));
      const startDate = inv.date_s;
      const dueDays = inv.due_s
        ? Math.max(0, Math.round((Date.parse(inv.due_s) - Date.parse(startDate)) / 86400000))
        : 30;
      const total = 12;

      const { rows: planRows } = await client.query(
        `INSERT INTO customer_invoice_recurring_plans
           (company_id, customer_id, source_invoice_id, instalments_total, start_date, due_days, vat_mode,
            annual_lines, annual_subtotal, annual_vat, annual_total, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          companyId, inv.customer_id, invoiceId, total, startDate, dueDays, inv.vat_mode || 'exclusive',
          JSON.stringify(annualLines), inv.subtotal, inv.vat_amount, inv.total_amount, inv.notes || null, actorId,
        ]
      );
      planId = Number(planRows[0].id); // node-pg returns BIGSERIAL as a string

      // The draft becomes instalment 1.
      const { lines, totals } = buildInstalment(annualLines, total, 1, inv.vat_mode === 'inclusive');
      await client.query('DELETE FROM customer_invoice_lines WHERE invoice_id = $1', [invoiceId]);
      await insertInvoiceLines(client, invoiceId, lines);
      await client.query(
        `UPDATE customer_invoices SET
           billing_choice = 'monthly', recurring_plan_id = $1, recurring_instalment_no = 1,
           subtotal = $2, vat_amount = $3, total_amount = $4, balance_due = $4, updated_at = NOW()
         WHERE id = $5 AND company_id = $6`,
        [planId, totals.subtotalExVat, totals.vatAmount, totals.totalIncVat, invoiceId, companyId]
      );
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await AuditLogger.log({
    companyId, actorType: 'USER', actorId, ipAddress, userAgent,
    actionType: 'CUSTOMER_INVOICE_BILLING_CHOICE',
    entityType: 'CUSTOMER_INVOICE', entityId: invoiceId,
    beforeJson: before,
    afterJson: { billingChoice: choice, ...(planId ? { recurringPlanId: planId, instalmentsTotal: 12 } : {}) },
    reason: choice === 'monthly'
      ? `Client chose monthly billing — plan ${planId} created, invoice became instalment 1 of 12`
      : 'Client chose annual billing',
  });

  if (choice === 'annual') {
    return { status: 200, body: { message: 'Annual billing recorded. Post the invoice to the General Ledger as usual.', choice } };
  }

  // Bring the new plan up to date right away (posts + emails instalment 1
  // if its date has arrived). Never fails the choice itself — any problem is
  // stored on the plan and retried on the next run.
  let run = null;
  try {
    const { data: plan } = await supabase.from('customer_invoice_recurring_plans').select('*').eq('id', planId).maybeSingle();
    if (plan) run = await runPlan(plan);
  } catch (err) {
    console.error(`[RecurringInvoices] first run of plan ${planId} failed:`, err.message);
    run = { planId, errors: [err.message] };
  }
  return { status: 200, body: { message: 'Monthly billing plan created (12 monthly invoices).', choice, planId, run } };
}

// ─── Stop a plan ─────────────────────────────────────────────────────────────

async function cancelPlan({ companyId, planId, reason, actorId = null, ipAddress = null, userAgent = null }) {
  if (!reason || !String(reason).trim()) return { status: 400, body: { error: 'A reason is required to stop a monthly plan.' } };
  const { data: plan } = await supabase.from('customer_invoice_recurring_plans')
    .select('id, status').eq('id', planId).eq('company_id', companyId).maybeSingle();
  if (!plan) return { status: 404, body: { error: 'Plan not found' } };
  if (plan.status !== 'active') return { status: 409, body: { error: `Plan is already ${plan.status}` } };

  const { error } = await supabase.from('customer_invoice_recurring_plans').update({
    status: 'cancelled', cancelled_by: actorId, cancelled_at: new Date().toISOString(),
    cancel_reason: String(reason).trim().slice(0, 500), updated_at: new Date().toISOString(),
  }).eq('id', planId).eq('company_id', companyId).eq('status', 'active');
  if (error) throw new Error(error.message);

  await AuditLogger.log({
    companyId, actorType: 'USER', actorId, ipAddress, userAgent,
    actionType: 'CUSTOMER_INVOICE_PLAN_CANCELLED', entityType: 'CUSTOMER_INVOICE_PLAN', entityId: planId,
    beforeJson: { status: 'active' }, afterJson: { status: 'cancelled', reason },
    reason: `Monthly billing plan ${planId} stopped: ${reason}`,
  });
  return { status: 200, body: { message: 'Monthly plan stopped. Invoices already posted are not affected.' } };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let _timer = null;

/** Starts the hourly runner. Set RECURRING_INVOICES_SCHEDULER=off to disable. */
function startRecurringInvoiceScheduler() {
  if (_timer || process.env.RECURRING_INVOICES_SCHEDULER === 'off') return;
  const tick = () => runDuePlans()
    .then((r) => { if (r && !r.skipped && r.plans) console.log(`[RecurringInvoices] ran ${r.plans} active plan(s)`); })
    .catch((err) => console.error('[RecurringInvoices] run failed:', err.message));
  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  if (first.unref) first.unref();
  _timer = setInterval(tick, RUN_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  console.log('🔁 Recurring invoice scheduler started (hourly)');
}

function isSchedulerRunning() { return !!_timer; }

module.exports = {
  // engine
  chooseBilling, runPlan, runDuePlans, cancelPlan, startRecurringInvoiceScheduler, isSchedulerRunning,
  // pure helpers (tests)
  todaySA, instalmentDate, splitUnitPrice, buildInstalment, addDays,
};
