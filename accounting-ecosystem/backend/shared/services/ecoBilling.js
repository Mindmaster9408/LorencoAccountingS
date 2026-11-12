/**
 * Eco billing — Lorenco invoices everyone who uses the Eco, from its own
 * Ledger Leo company (Lorenco Ecosystum, company 40).
 *
 * Ruan, 2026-11-12:
 *  - Every company that uses the Eco is a customer in company 40, filled from
 *    the data the Eco already holds (name, VAT no, address, …) and kept in
 *    sync automatically when that data changes.
 *  - Who pays: clients of Lorenco's own practice (The Infinite Legacy,
 *    company 1) are invoiced themselves; any other practice is invoiced for
 *    all its clients on one invoice (a line per client per app); a
 *    self-registered company pays for itself. Lorenco's own companies are
 *    invoiced too ("dit is nogsteeds gebruik van die program").
 *  - Test / demo / presentation / merged rows are never invoiced
 *    (eco_clients.billing_excluded, companies.is_demo, and anything created
 *    under an excluded company).
 *  - Platform Control → Invoice creates a DRAFT in Leo; Lorenco checks it and
 *    posts/emails it from Leo. Nothing is sent automatically.
 *
 * Customer rows are matched on customers.eco_billing_company_id (migration
 * 180). eco_client_id is deliberately NOT set: that column drives the
 * inter-company invoice push (client-links), which this must not trigger.
 */
'use strict';

const { supabase } = require('../../config/database');
const { amountsFor } = require('../../config/app-pricing');
const { APP_LABELS, todaySA, addDays } = require('./appSubscriptions');

const BILLING_COMPANY_ID = () => Number(process.env.ECO_BILLING_COMPANY_ID || 40);
const LORENCO_PRACTICE_ID = () => Number(process.env.LORENCO_PRACTICE_COMPANY_ID || 1);
const EXTRA_LABELS = { slips: 'Slips', insights: 'Insights', collector: 'Collector', commander: 'Commander' };
const appLabel = k => APP_LABELS[k] || EXTRA_LABELS[k] || k;

const blank = v => v == null || String(v).trim() === '';
const first = (...vals) => { for (const v of vals) if (!blank(v)) return String(v).trim(); return null; };

// ─── Who pays for what ──────────────────────────────────────────────────────

/**
 * Pure: works out every paying company and what it is billed for.
 * @returns {Map<number, { companyId, clients: [{ecoClientId, name, companyId, apps}], ownApps: string[] }>}
 */
function computePayers(ecoClients, companies) {
  const co = new Map((companies || []).map(c => [Number(c.id), c]));
  const practiceId = LORENCO_PRACTICE_ID();

  // Companies whose eco_client is excluded (TEST etc.) — rows created under them are excluded too.
  const excludedCompanyIds = new Set();
  for (const e of ecoClients) {
    if (e.billing_excluded && e.client_company_id) excludedCompanyIds.add(Number(e.client_company_id));
  }
  for (const c of companies || []) if (c.is_demo) excludedCompanyIds.add(Number(c.id));

  const payers = new Map();
  const payer = id => {
    if (!payers.has(id)) payers.set(id, { companyId: id, clients: [], ownApps: [] });
    return payers.get(id);
  };

  for (const e of ecoClients) {
    // access_link rows (migration 181) are access grants — the company pays itself.
    if (!e.is_active || e.billing_excluded || e.access_link || !e.client_company_id) continue;
    const cc = Number(e.client_company_id);
    const mgr = Number(e.company_id);
    if (excludedCompanyIds.has(cc) || excludedCompanyIds.has(mgr)) continue;
    const payerId = (mgr === practiceId || mgr === cc) ? cc : mgr;
    if (!co.has(payerId)) continue;
    payer(payerId).clients.push({
      ecoClientId: e.id, name: e.name, companyId: cc,
      apps: Array.isArray(e.apps) ? e.apps : [],
    });
  }

  // Practices' own use: a company that manages clients (or is Lorenco's
  // practice) but has no client row of its own is billed for the modules
  // switched on for its own company.
  // (A practice whose only client is a demo — still on trial — is a user too.)
  const managers = new Set(ecoClients
    .filter(e => e.company_id && Number(e.company_id) !== Number(e.client_company_id))
    .map(e => Number(e.company_id)));
  managers.add(practiceId);
  for (const id of managers) {
    if (excludedCompanyIds.has(id) || !co.has(id)) continue;
    const p = payer(id);
    if (p.clients.some(c => c.companyId === id)) continue;
    const mods = co.get(id).modules_enabled;
    p.ownApps = Array.isArray(mods) ? mods : [];
  }

  return payers;
}

/** Pure: the customers-row fields for a company (only non-empty values). */
function customerFieldsFor(company, ownEcoClient) {
  const c = company || {};
  const e = ownEcoClient || {};
  const phone = first(c.phone, c.contact_phone, e.phone);
  const f = {
    name: first(c.company_name, c.trading_name, e.name),
    contact_person: first(c.contact_person),
    email: first(c.email, c.contact_email, e.email),
    phone,
    contact_number: phone,
    vat_number: first(c.vat_number),
    registration_number: first(c.registration_number),
    tax_reference: first(c.income_tax_number, c.tax_number),
    address_line_1: first(c.address_street, c.physical_address, c.address, e.address),
    address_line_2: first(c.address_suburb),
    city: first(c.address_city, c.city),
    province: first(c.address_province),
    postal_code: first(c.address_postal_code, c.postal_code),
  };
  for (const k of Object.keys(f)) if (f[k] == null) delete f[k];
  return f;
}

// ─── Data loading ───────────────────────────────────────────────────────────

const COMPANY_COLS = 'id, company_name, trading_name, registration_number, vat_number, income_tax_number, tax_number, ' +
  'contact_person, email, contact_email, phone, contact_phone, address, physical_address, address_street, address_suburb, ' +
  'address_city, city, address_province, address_postal_code, postal_code, modules_enabled, is_demo';

async function loadAll() {
  const ECO_COLS = 'id, name, email, phone, address, company_id, client_company_id, apps, is_active, billing_excluded';
  const ecoQuery = async () => {
    const r = await supabase.from('eco_clients').select(ECO_COLS + ', access_link');
    return r.error ? supabase.from('eco_clients').select(ECO_COLS) : r; // before migration 181
  };
  const [{ data: eco, error: e1 }, { data: cos, error: e2 }] = await Promise.all([
    ecoQuery(),
    supabase.from('companies').select(COMPANY_COLS),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  return { ecoClients: eco || [], companies: cos || [] };
}

// ─── Customer sync ──────────────────────────────────────────────────────────

/**
 * Creates/updates the customer row in the billing company for every paying
 * company (or just `onlyCompanyIds`). Eco data wins for every field it has;
 * a field the Eco has no value for is left as it is in Leo.
 * @returns {{ created: number, updated: number, unchanged: number, failed: Array, customerIds: Object }}
 */
async function syncBillingCustomers({ onlyCompanyIds = null } = {}) {
  const billingId = BILLING_COMPANY_ID();
  const { ecoClients, companies } = await loadAll();
  const coMap = new Map(companies.map(c => [Number(c.id), c]));
  const payers = computePayers(ecoClients, companies);
  const ids = [...payers.keys()].filter(id => !onlyCompanyIds || onlyCompanyIds.map(Number).includes(id));
  const out = { created: 0, updated: 0, unchanged: 0, failed: [], customerIds: {} };
  if (!ids.length) return out;

  const { data: existing, error } = await supabase.from('customers')
    .select('*').eq('company_id', billingId).in('eco_billing_company_id', ids);
  if (error) throw new Error(error.message);
  const byCo = new Map((existing || []).map(r => [Number(r.eco_billing_company_id), r]));

  for (const id of ids) {
    try {
      const own = ecoClients.find(e => Number(e.client_company_id) === id && !e.billing_excluded) || null;
      const fields = customerFieldsFor(coMap.get(id), own);
      if (!fields.name) { out.failed.push({ companyId: id, error: 'Company has no name' }); continue; }
      const row = byCo.get(id);
      if (!row) {
        const { data: ins, error: insErr } = await supabase.from('customers')
          .insert({ company_id: billingId, eco_billing_company_id: id, customer_type: 'Account Customer', is_active: true, ...fields })
          .select('id').single();
        if (insErr) throw new Error(insErr.message);
        out.created++; out.customerIds[id] = ins.id;
        continue;
      }
      out.customerIds[id] = row.id;
      const diff = {};
      for (const [k, v] of Object.entries(fields)) if ((row[k] ?? null) !== v) diff[k] = v;
      if (!Object.keys(diff).length) { out.unchanged++; continue; }
      const { error: upErr } = await supabase.from('customers')
        .update({ ...diff, updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('company_id', billingId);
      if (upErr) throw new Error(upErr.message);
      out.updated++;
    } catch (err) {
      out.failed.push({ companyId: id, error: err.message });
    }
  }
  return out;
}

// ─── Invoice ────────────────────────────────────────────────────────────────

async function activeEmployeeCounts(companyIds) {
  const counts = {};
  if (!companyIds.length) return counts;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('employees')
      .select('id, company_id').eq('is_active', true).in('company_id', companyIds)
      .order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data || []) counts[r.company_id] = (counts[r.company_id] || 0) + 1;
    if (!data || data.length < PAGE) break;
  }
  return counts;
}

/** Pure: invoice lines for one payer. */
function buildLines(p, payerName, employeeCounts) {
  const lines = [];
  const add = (appKey, who, companyId) => {
    const { amount, perEmployee } = amountsFor(appKey);
    const label = appLabel(appKey);
    if (appKey === 'payroll') {
      const n = employeeCounts[companyId] || 0;
      lines.push({ description: `${label} — ${who} (${n} active employee${n === 1 ? '' : 's'})`, quantity: 1, unitPrice: amount });
      if (perEmployee) lines.push({ description: `${label} employees — ${who}`, quantity: n || 0, unitPrice: perEmployee });
    } else {
      lines.push({ description: `${label} — ${who}`, quantity: 1, unitPrice: amount });
    }
  };
  for (const k of p.ownApps) add(k, payerName, p.companyId);
  for (const c of p.clients) for (const k of c.apps) add(k, c.name, c.companyId);
  return lines;
}

/** What would be invoiced, per paying company (for the Platform Control panel). */
async function preview() {
  const { ecoClients, companies } = await loadAll();
  const coMap = new Map(companies.map(c => [Number(c.id), c]));
  const payers = computePayers(ecoClients, companies);
  const billingId = BILLING_COMPANY_ID();
  const { data: custs } = await supabase.from('customers')
    .select('id, eco_billing_company_id').eq('company_id', billingId).not('eco_billing_company_id', 'is', null);
  const custBy = new Map((custs || []).map(r => [Number(r.eco_billing_company_id), r.id]));
  const ecoToPayer = {};
  const list = [];
  for (const p of payers.values()) {
    const co = coMap.get(p.companyId) || {};
    const missing = [];
    const f = customerFieldsFor(co, ecoClients.find(e => Number(e.client_company_id) === p.companyId));
    if (!f.vat_number) missing.push('VAT no');
    if (!f.address_line_1) missing.push('address');
    if (!f.email) missing.push('email');
    for (const c of p.clients) ecoToPayer[c.ecoClientId] = p.companyId;
    list.push({
      company_id: p.companyId,
      name: co.company_name || co.trading_name || `Company ${p.companyId}`,
      customer_id: custBy.get(p.companyId) || null,
      client_count: p.clients.length,
      line_count: p.ownApps.length + p.clients.reduce((n, c) => n + c.apps.length, 0),
      missing,
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { billing_company_id: billingId, payers: list, eco_client_to_payer: ecoToPayer };
}

/**
 * Creates a DRAFT invoice in the billing company's Leo for one paying company.
 * @returns {{ status, body }}
 */
async function createDraftInvoice({ payerCompanyId, actorId = null, invoiceDate = null }) {
  const id = Number(payerCompanyId);
  const billingId = BILLING_COMPANY_ID();
  const { ecoClients, companies } = await loadAll();
  const p = computePayers(ecoClients, companies).get(id);
  if (!p) return { status: 404, body: { error: 'This company is not billable (inactive, test/demo, or invoiced through its practice).' } };

  const sync = await syncBillingCustomers({ onlyCompanyIds: [id] });
  const customerId = sync.customerIds[id];
  if (!customerId) return { status: 500, body: { error: 'Could not create the customer in Leo: ' + (sync.failed[0]?.error || 'unknown') } };

  const co = companies.find(c => Number(c.id) === id) || {};
  const payerName = co.company_name || co.trading_name || `Company ${id}`;
  const empCompanyIds = [id, ...p.clients.map(c => c.companyId)];
  const lines = buildLines(p, payerName, await activeEmployeeCounts(empCompanyIds));
  if (!lines.length) return { status: 409, body: { error: `${payerName} has no apps switched on, so there is nothing to invoice.` } };

  const date = invoiceDate || todaySA();
  const { createDraftCustomerInvoice } = require('../../modules/accounting/services/customerInvoiceCore');
  const { invoice, totals } = await createDraftCustomerInvoice({
    companyId: billingId,
    customerId,
    invoiceDate: date,
    dueDate: addDays(date, 7),
    vatInclusive: false,
    lines,
    notes: 'Lorenco Ecosystem subscription',
    actorId,
    actorType: 'USER',
    reason: `Eco billing: draft invoice for ${payerName} (company ${id}) from Platform Control`,
  });
  return {
    status: 201,
    body: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      total: totals.totalIncVat,
      line_count: lines.length,
      billing_company_id: billingId,
      unpriced: lines.some(l => !l.unitPrice),
    },
  };
}

// ─── Scheduler (keeps customers in sync with Eco data) ──────────────────────

let _timer = null;
function startEcoBillingScheduler() {
  if (process.env.ECO_BILLING_SYNC === 'off' || _timer) return;
  const run = () => syncBillingCustomers()
    .then(s => { if (s.created || s.updated || s.failed.length) console.log(`[ecoBilling] customers synced: +${s.created} ~${s.updated}` + (s.failed.length ? `, ${s.failed.length} failed` : '')); })
    .catch(err => console.error('[ecoBilling] sync failed:', err.message));
  setTimeout(run, 60 * 1000).unref();
  _timer = setInterval(run, 15 * 60 * 1000);
  _timer.unref();
}

/** Fire-and-forget sync for one or more companies (after a client is created/edited). */
function syncSoon(companyIds) {
  if (process.env.ECO_BILLING_SYNC === 'off' || process.env.NODE_ENV === 'test') return;
  const ids = (companyIds || []).filter(Boolean).map(Number);
  setImmediate(() => {
    syncBillingCustomers(ids.length ? { onlyCompanyIds: ids } : {})
      .catch(err => console.error('[ecoBilling] sync failed:', err.message));
  });
}

module.exports = {
  syncBillingCustomers, preview, createDraftInvoice, startEcoBillingScheduler, syncSoon,
  // pure (tests)
  computePayers, customerFieldsFor, buildLines,
};
