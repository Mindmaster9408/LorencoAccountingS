'use strict';

/**
 * ============================================================================
 * Company identity sync — one record for name, numbers, address, contact
 * (2026-11-26)
 * ============================================================================
 * The `companies` row is canonical for a client's identity data. Every app
 * reads or writes these canonical columns (other columns with similar names on
 * companies, e.g. physical_address / city / postal_code / paye_reference /
 * coid_number, are legacy and empty — nothing may use them):
 *
 *   company_name, trading_name, registration_number, vat_number,
 *   income_tax_number, paye_reference_number, uif_reference_number,
 *   sdl_reference_number, coid_reference_number,
 *   address_street, address_suburb, address_city, address_province,
 *   address_postal_code, postal_address, contact_email, contact_phone
 *   (email / phone on companies are legacy — almost all empty; contact_* is
 *   what Paytime, Checkout Charlie, invoices and Eco billing use)
 *
 * Mirrors kept in step from here:
 *   eco_clients (ECO Hub)  name, email, phone, address (one line)
 *   practice_clients (Firmflow) reads through + writes through via
 *   modules/practice/lib/company-sync.js (COMPLIANCE_FIELD_MAP).
 *
 * Edit paths that call this module:
 *   Leo company page (accounting/routes/company.js PUT)      → mirrorCompanyToEcoClients
 *   Paytime / ECO company edit (shared/routes/companies.js)  → mirrorCompanyToEcoClients
 *   ECO Hub client edit (shared/routes/eco-clients.js)       → mirrorEcoClientToCompany
 *   Firmflow client edit (practice/index.js PUT)             → writes companies directly
 * ============================================================================
 */

const { supabase } = require('../../config/database');

const ADDRESS_PARTS = ['address_street', 'address_suburb', 'address_city', 'address_province', 'address_postal_code'];

/** One-line address from the structured company columns. Pure. */
function composeAddress(company) {
  return ADDRESS_PARTS.map(k => (company && company[k] ? String(company[k]).trim() : '')).filter(Boolean).join(', ') || null;
}

/**
 * eco_clients patch for a companies change. `changed` = the companies columns
 * that were written. Only fields that actually changed are mirrored. Pure.
 */
function ecoPatchFromCompany(company, changed) {
  const has = k => changed.includes(k);
  const patch = {};
  if (has('company_name') && company.company_name) patch.name = company.company_name;
  if (has('contact_email')) patch.email = company.contact_email || null;
  if (has('contact_phone')) patch.phone = company.contact_phone || null;
  if (ADDRESS_PARTS.some(has)) patch.address = composeAddress(company);
  return patch;
}

/** companies patch for an ECO Hub client change. Pure. */
function companyPatchFromEco(ecoClient, changedFields) {
  const has = k => changedFields.includes(k);
  const patch = {};
  if (has('name') && ecoClient.name) patch.company_name = ecoClient.name;
  if (has('email')) patch.contact_email = ecoClient.email || null;
  if (has('phone')) patch.contact_phone = ecoClient.phone || null;
  // eco_clients.address is one free-text line; the structured company address
  // is edited in Leo / Paytime / Firmflow, so it is not overwritten from here.
  return patch;
}

/** Columns in `updates` whose value differs from `old` (forms send every field). Pure. */
function changedColumns(old, updates) {
  const norm = v => (v === undefined || v === '' ? null : v);
  return Object.keys(updates || {}).filter(k => k !== 'updated_at'
    && JSON.stringify(norm(old ? old[k] : null)) !== JSON.stringify(norm(updates[k])));
}

/** Non-fatal: a mirror failure is logged, the main save already succeeded. */
async function mirrorCompanyToEcoClients(companyId, changedCols) {
  try {
    const changed = (changedCols || []).filter(Boolean);
    if (!companyId || !changed.length) return { updated: 0 };
    const { data: company, error } = await supabase
      .from('companies')
      .select(['company_name', 'contact_email', 'contact_phone', ...ADDRESS_PARTS].join(', '))
      .eq('id', companyId).single();
    if (error || !company) return { updated: 0 };
    const patch = ecoPatchFromCompany(company, changed);
    if (!Object.keys(patch).length) return { updated: 0 };
    patch.updated_at = new Date().toISOString();
    const { data, error: upErr } = await supabase
      .from('eco_clients').update(patch).eq('client_company_id', companyId).select('id');
    if (upErr) throw upErr;
    return { updated: (data || []).length };
  } catch (err) {
    console.warn('[companyIdentitySync] company → eco_clients failed:', err.message);
    return { updated: 0, error: err.message };
  }
}

async function mirrorEcoClientToCompany(ecoClient, changedFields) {
  try {
    if (!ecoClient || !ecoClient.client_company_id || ecoClient.access_link) return { updated: 0 };
    const patch = companyPatchFromEco(ecoClient, changedFields || []);
    if (!Object.keys(patch).length) return { updated: 0 };
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from('companies').update(patch).eq('id', ecoClient.client_company_id);
    if (error) throw error;
    return { updated: 1 };
  } catch (err) {
    console.warn('[companyIdentitySync] eco_client → company failed:', err.message);
    return { updated: 0, error: err.message };
  }
}

module.exports = {
  ADDRESS_PARTS, composeAddress, ecoPatchFromCompany, companyPatchFromEco, changedColumns,
  mirrorCompanyToEcoClients, mirrorEcoClientToCompany,
};
