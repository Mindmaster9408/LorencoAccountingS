'use strict';

/**
 * ============================================================================
 * Firmflow ↔ the client's company record (Leo / Paytime / invoices) — 2026-11-26
 * ============================================================================
 * COMPANY_FIELD_MAP — numbers, address and contact (moved here from
 * practice/index.js COMPLIANCE_FIELD_MAP, which only had the numbers).
 * Non-empty company values win on read; Firmflow saves write them back.
 * Canonical columns: shared/services/companyIdentitySync.js.
 *
 * VAT registration + VAT cycle — rules below.
 * ----------------------------------------------------------------------------
 * Same model as COMPLIANCE_FIELD_MAP in practice/index.js (VAT number etc.):
 * for a practice client LINKED to an operational company
 * (practice_clients.eco_client_id → eco_clients.client_company_id →
 * companies.id) the company row is canonical — read-through on every Firmflow
 * read that uses VAT settings, write-through when Firmflow saves.
 *
 * Canonical rule: the company wins when it is VAT-registered
 * (companies.is_vat_registered = true). A company that isn't (yet) set up in
 * Leo leaves Firmflow's own values in place, so a client Firmflow already
 * tracks as a VAT vendor doesn't silently lose its VAT deadlines.
 *
 * Vocabulary (one-to-one):
 *   Firmflow vat_payment_sequence     Leo companies.vat_period
 *   monthly                           monthly         (Category C)
 *   bi_monthly + parity odd/even      bi-monthly + vat_cycle_type odd/even (A / B)
 *   quarterly ("every 4 months")      four-monthly    (Category F)
 *   6_monthly                         six-monthly     (Category D)
 *   annual                            annually        (Category E)
 *   Leo 'quarterly' (UK, 3-monthly) shows as Firmflow 'quarterly'; Firmflow
 *   'quarterly' always means four-monthly when written back.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

/** practice_clients column → companies column. */
const COMPANY_FIELD_MAP = {
  vat_number: 'vat_number',
  registration_number: 'registration_number',
  income_tax_number: 'income_tax_number',
  paye_reference_number: 'paye_reference_number',
  uif_reference_number: 'uif_reference_number',
  sdl_reference_number: 'sdl_reference_number',
  coida_registration_number: 'coid_reference_number',
  // address (same columns Paytime, invoices, statements and EMP501 use)
  address_line1: 'address_street',
  address_line2: 'address_suburb',
  address_city: 'address_city',
  address_province: 'address_province',
  address_postal_code: 'address_postal_code',
  // contact
  email: 'contact_email',
  phone: 'contact_phone',
};

/** Firmflow fields from a company row: non-empty company values only. Pure. */
function practiceFieldsFromCompany(company) {
  const out = {};
  if (!company) return out;
  for (const [pf, cf] of Object.entries(COMPANY_FIELD_MAP)) {
    const v = company[cf];
    if (v !== null && v !== undefined && v !== '') out[pf] = v;
  }
  return out;
}

const PRACTICE_TO_LEO = {
  monthly: 'monthly', bi_monthly: 'bi-monthly', quarterly: 'four-monthly', '6_monthly': 'six-monthly', annual: 'annually',
};
const LEO_TO_PRACTICE = {
  monthly: 'monthly', 'bi-monthly': 'bi_monthly', 'four-monthly': 'quarterly', 'six-monthly': '6_monthly',
  annually: 'annual', quarterly: 'quarterly',
};

/** Firmflow VAT fields as Leo sees them, or null when Leo isn't canonical. Pure. */
function practiceVatFromCompany(company) {
  if (!company || company.is_vat_registered !== true) return null;
  const seq = LEO_TO_PRACTICE[String(company.vat_period || '').toLowerCase()] || null;
  return {
    vat_registered: true,
    vat_payment_sequence: seq,
    vat_bi_monthly_parity: seq === 'bi_monthly' ? (company.vat_cycle_type || null) : null,
  };
}

/** companies update for the VAT fields present in a Firmflow save body. Pure. */
function companyVatUpdateFromPractice(body) {
  const u = {};
  if (body.vat_registered !== undefined) u.is_vat_registered = body.vat_registered === true || body.vat_registered === 'true';
  // "Not set" in Firmflow never clears Leo's cycle — Leo needs one to place entries.
  if (body.vat_payment_sequence && PRACTICE_TO_LEO[body.vat_payment_sequence]) {
    u.vat_period = PRACTICE_TO_LEO[body.vat_payment_sequence];
    if (body.vat_payment_sequence === 'bi_monthly' && ['odd', 'even'].includes(body.vat_bi_monthly_parity)) {
      u.vat_cycle_type = body.vat_bi_monthly_parity;
    }
  }
  return u;
}

/**
 * What a Firmflow body asks for, in Leo terms, starting from the company's
 * current settings (vatCycleService.settings shape). Pure.
 */
function desiredVatFromPractice(body, before) {
  const seq = body.vat_payment_sequence;
  const frequency = PRACTICE_TO_LEO[seq] || before.frequency;
  return {
    registered: body.vat_registered !== undefined ? (body.vat_registered === true || body.vat_registered === 'true') : before.isVatRegistered,
    frequency,
    cycle: frequency === 'bi-monthly'
      ? (seq === 'bi_monthly' && ['odd', 'even'].includes(body.vat_bi_monthly_parity) ? body.vat_bi_monthly_parity : (before.cycle || 'even'))
      : null,
  };
}

/** Leo frequency for a (possibly overlaid) Firmflow client, for period maths. Pure. */
function leoFrequencyOf(client) {
  return PRACTICE_TO_LEO[client.vat_payment_sequence] || null;
}

/**
 * Overlay the company's numbers, address, contact and VAT settings onto practice client rows (returns new objects).
 * One query for the eco links, one for the companies.
 */
async function overlayCompanyVat(clients) {
  const list = clients || [];
  const ecoIds = [...new Set(list.map(c => c.eco_client_id).filter(Boolean))];
  if (!ecoIds.length) return list;
  const { data: ecos, error: eErr } = await supabase
    .from('eco_clients').select('id, client_company_id').in('id', ecoIds);
  if (eErr) throw new Error(eErr.message);
  const companyByEco = new Map((ecos || []).filter(e => e.client_company_id).map(e => [e.id, e.client_company_id]));
  const companyIds = [...new Set(companyByEco.values())];
  if (!companyIds.length) return list;
  const { data: companies, error: cErr } = await supabase
    .from('companies')
    .select(['id', 'is_vat_registered', 'vat_period', 'vat_cycle_type', ...new Set(Object.values(COMPANY_FIELD_MAP))].join(', '))
    .in('id', companyIds);
  if (cErr) throw new Error(cErr.message);
  const byId = new Map((companies || []).map(c => [c.id, c]));
  return list.map(c => {
    const company = byId.get(companyByEco.get(c.eco_client_id));
    if (!company) return c;
    const vat = practiceVatFromCompany(company);
    return { ...c, ...practiceFieldsFromCompany(company), ...(vat ? { ...vat, vat_settings_source: 'ledger' } : {}),
      // locked = VAT registered with a cycle: changed only via POST /clients/:id/vat-cycle (authorised)
      vat_settings_locked: company.is_vat_registered === true && !!LEO_TO_PRACTICE[String(company.vat_period || '').toLowerCase()] };
  });
}

module.exports = {
  COMPANY_FIELD_MAP, practiceFieldsFromCompany,
  PRACTICE_TO_LEO, LEO_TO_PRACTICE,
  practiceVatFromCompany, companyVatUpdateFromPractice, desiredVatFromPractice, leoFrequencyOf, overlayCompanyVat,
};
