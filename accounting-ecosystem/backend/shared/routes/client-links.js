/**
 * ============================================================================
 * Client Links — Customer↔Supplier linking by Lorenco Ecosystem client code
 * ============================================================================
 * Lets a company link one of its own `customers` records to another real
 * platform company by that company's `client_code` (the `CLT-XXXXXXXX` code
 * from `eco_clients` — the one meant to identify a client everywhere: ECO
 * Dashboard, invoices, whichever accountant is handling them). On the OTHER
 * company's side, this creates a matching `suppliers` record with
 * link_status='pending', which their bookkeeper must explicitly approve
 * before the link goes active on both sides.
 *
 * Deliberately NOT built on the existing backend/inter-company/ engine
 * (InterCompanyNetwork) — that engine matches companies by invitation code /
 * tax number / VAT / email domain, a different identity model than the
 * Ecosystem's own client_code, and its invoice-trading half (never wired to
 * any frontend) creates synthetic bank-transaction rows rather than real
 * supplier_invoices — not a fit for what this needs to do next (see
 * docs/leo-customer-supplier-linking-and-invoice-pullthrough.md). This is a
 * fresh, direct mechanism keyed on eco_client_id instead.
 *
 * Mounted at /api/client-links — shared (not POS- or Accounting-specific)
 * because `customers`/`suppliers` are the same tables both apps read, same
 * reasoning as shared/routes/customers.js.
 *
 * Routes:
 *   GET   /api/client-links/my-code                    — this company's own client_code (if any)
 *   POST  /api/client-links/lookup                      — find a company by client_code (safe preview)
 *   POST  /api/client-links/customers/:customerId/link  — initiate a link from one of my customer records
 *   GET   /api/client-links/pending                     — incoming pending requests on my supplier list
 *   POST  /api/client-links/suppliers/:supplierId/approve
 *   POST  /api/client-links/suppliers/:supplierId/reject
 *   POST  /api/client-links/:recordType/:id/revoke      — recordType: 'customers' | 'suppliers'
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { hasPermission, MANAGEMENT_ROLES } = require('../../config/permissions');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * This company's own eco_clients row (the one that carries ITS client_code).
 * client_code is deliberately global, not scoped to any one practice
 * (migration 092: "so it can be used as an external reference") — so a
 * lookup/link works correctly even between two companies managed by two
 * different practices; neither side needs to be "in the same section" as
 * the other.
 *
 * A single real company CAN have more than one eco_clients row if it's
 * genuinely serviced by multiple practices (migration 092: "the same client
 * CAN exist under different practices") — .maybeSingle() would throw on
 * that instead of resolving anything, which would break linking entirely
 * for such a company. Ordered by id so the choice is at least deterministic
 * (oldest/first-onboarded practice relationship wins) rather than whichever
 * happened to sort first.
 */
async function getOwnEcoClient(companyId) {
  const { data, error } = await supabase
    .from('eco_clients')
    .select('id, client_code, name')
    .eq('client_company_id', companyId)
    .order('id', { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data && data[0]) || null;
}

async function getEcoClientByCode(clientCode) {
  const { data, error } = await supabase
    .from('eco_clients')
    .select('id, client_code, name, client_company_id, is_active')
    .eq('client_code', clientCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// ── GET /api/client-links/my-code ───────────────────────────────────────────
router.get('/my-code', async (req, res) => {
  try {
    const own = await getOwnEcoClient(req.companyId);
    if (!own) {
      return res.json({
        clientCode: null,
        message: 'Your company does not have a Lorenco Ecosystem client code yet — ask your practice to set one up before linking to another company.',
      });
    }
    res.json({ clientCode: own.client_code, name: own.name });
  } catch (err) {
    console.error('[client-links] my-code:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/client-links/lookup ───────────────────────────────────────────
// Body: { client_code }. Safe preview only — name, never financial/contact
// details — same principle as company-links.js's invitation-code lookup.
router.post('/lookup', async (req, res) => {
  try {
    if (!hasPermission(req.user.role, 'CUSTOMERS', 'EDIT')) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const clientCode = (req.body.client_code || '').trim().toUpperCase();
    if (!clientCode) return res.status(400).json({ error: 'client_code is required' });

    const target = await getEcoClientByCode(clientCode);
    if (!target || !target.is_active) {
      return res.status(404).json({ error: 'No client found for that code' });
    }
    if (target.client_company_id === req.companyId) {
      return res.status(400).json({ error: 'That code belongs to your own company' });
    }
    if (!target.client_company_id) {
      return res.status(400).json({ error: 'That client has no linked company data yet — cannot link to it' });
    }

    res.json({ client: { name: target.name, clientCode: target.client_code } });
  } catch (err) {
    console.error('[client-links] lookup:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/client-links/customers/:customerId/link ──────────────────────
// Body: { client_code }. Links MY customer record to the target company, and
// creates (or reuses) a pending supplier record on THEIR side pointing back
// at my own eco_client identity.
router.post('/customers/:customerId/link', async (req, res) => {
  try {
    if (!hasPermission(req.user.role, 'CUSTOMERS', 'EDIT')) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const customerId = parseInt(req.params.customerId);
    const clientCode = (req.body.client_code || '').trim().toUpperCase();
    if (!customerId) return res.status(400).json({ error: 'Invalid customer id' });
    if (!clientCode) return res.status(400).json({ error: 'client_code is required' });

    const { data: customer, error: custErr } = await supabase
      .from('customers').select('id, name, eco_client_id, link_status')
      .eq('id', customerId).eq('company_id', req.companyId).maybeSingle();
    if (custErr) return res.status(500).json({ error: custErr.message });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (customer.eco_client_id) {
      return res.status(409).json({ error: 'This customer is already linked to a company' });
    }

    const target = await getEcoClientByCode(clientCode);
    if (!target || !target.is_active || !target.client_company_id) {
      return res.status(404).json({ error: 'No client found for that code' });
    }
    if (target.client_company_id === req.companyId) {
      return res.status(400).json({ error: 'That code belongs to your own company' });
    }

    const own = await getOwnEcoClient(req.companyId);
    if (!own) {
      return res.status(400).json({
        error: 'Your company does not have a Lorenco Ecosystem client code yet — ask your practice to set one up before linking to another company.',
      });
    }

    // My side: mark this customer as pending, pointed at the target's eco_client.
    const { error: updCustErr } = await supabase
      .from('customers')
      .update({ eco_client_id: target.id, link_status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', customerId).eq('company_id', req.companyId);
    if (updCustErr) return res.status(500).json({ error: updCustErr.message });

    // Their side: find or create a supplier record (representing ME) pointed
    // at MY eco_client identity — never duplicate if one already exists.
    const { data: existingSupplier } = await supabase
      .from('suppliers').select('id, link_status')
      .eq('company_id', target.client_company_id).eq('eco_client_id', own.id).maybeSingle();

    let supplierRow = existingSupplier;
    if (!supplierRow) {
      const { data: created, error: createErr } = await supabase
        .from('suppliers')
        .insert({
          company_id: target.client_company_id,
          supplier_name: own.name,
          name: own.name,
          eco_client_id: own.id,
          link_status: 'pending',
          is_active: true,
        })
        .select('id, link_status').single();
      if (createErr) return res.status(500).json({ error: createErr.message });
      supplierRow = created;
    } else if (supplierRow.link_status !== 'active') {
      // A previously revoked/rejected link is being retried — reopen it.
      await supabase.from('suppliers').update({ link_status: 'pending', updated_at: new Date().toISOString() }).eq('id', supplierRow.id);
    } else {
      return res.status(409).json({ error: 'A link already exists (and is active) between these two companies' });
    }

    await auditFromReq(req, 'UPDATE', 'customer', customerId, {
      module: 'shared',
      metadata: { action: 'client_link_requested', target_client_code: clientCode, target_company_id: target.client_company_id },
    });

    res.json({
      success: true,
      message: `Link request sent to ${target.name}. It will appear on their Supplier list for approval.`,
    });
  } catch (err) {
    console.error('[client-links] link:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/client-links/pending ───────────────────────────────────────────
// Incoming requests on MY supplier list, awaiting my approval.
router.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('suppliers')
      .select('id, name, supplier_name, eco_client_id, created_at, eco_clients:eco_client_id(client_code, name)')
      .eq('company_id', req.companyId)
      .eq('link_status', 'pending')
      .not('eco_client_id', 'is', null);
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      pending: (data || []).map(s => ({
        supplierId: s.id,
        name: s.supplier_name || s.name,
        clientCode: s.eco_clients?.client_code || null,
        requestedAt: s.created_at,
      })),
    });
  } catch (err) {
    console.error('[client-links] pending:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/client-links/suppliers/:supplierId/approve ───────────────────
// Management-tier only — approving a cross-company link is a real trust
// decision (their invoices will start pulling into my books), same
// trust-tier as other cross-company actions in this codebase (e.g.
// company-links.js's INVENTORY.ADJUST gate).
router.post('/suppliers/:supplierId/approve', async (req, res) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only management can approve a company link' });
    }
    const supplierId = parseInt(req.params.supplierId);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const { data: supplier, error: suppErr } = await supabase
      .from('suppliers').select('id, eco_client_id, link_status')
      .eq('id', supplierId).eq('company_id', req.companyId).maybeSingle();
    if (suppErr) return res.status(500).json({ error: suppErr.message });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (!supplier.eco_client_id) return res.status(400).json({ error: 'This supplier is not a pending client link' });
    if (supplier.link_status !== 'pending') return res.status(400).json({ error: `Link is not pending (currently ${supplier.link_status})` });

    await supabase.from('suppliers').update({ link_status: 'active', updated_at: new Date().toISOString() }).eq('id', supplierId);

    // Flip the initiator's customer record to active too. supplier.eco_client_id
    // is the INITIATOR's own eco_client id (set by POST /customers/:id/link
    // when it created this supplier row) — resolve that to their
    // client_company_id first, so the lookup below is scoped to the actual
    // initiating company specifically. Without that company_id scope, two
    // unrelated companies each linking to me as their customer at the same
    // time (both eco_client_id = my own id, both still 'pending') would make
    // this an ambiguous multi-row match instead of the one specific request
    // being approved here.
    const { data: initiatorEcoClient } = await supabase
      .from('eco_clients').select('client_company_id')
      .eq('id', supplier.eco_client_id).maybeSingle();
    const own = await getOwnEcoClient(req.companyId);
    if (initiatorEcoClient?.client_company_id && own) {
      const { data: initiatorCustomer } = await supabase
        .from('customers').select('id')
        .eq('company_id', initiatorEcoClient.client_company_id)
        .eq('eco_client_id', own.id)
        .eq('link_status', 'pending')
        .maybeSingle();
      if (initiatorCustomer) {
        await supabase.from('customers').update({ link_status: 'active', updated_at: new Date().toISOString() }).eq('id', initiatorCustomer.id);
      }
    }

    await auditFromReq(req, 'UPDATE', 'supplier', supplierId, {
      module: 'shared',
      metadata: { action: 'client_link_approved' },
    });

    res.json({ success: true, message: 'Link approved — active on both sides.' });
  } catch (err) {
    console.error('[client-links] approve:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/client-links/suppliers/:supplierId/reject ────────────────────
router.post('/suppliers/:supplierId/reject', async (req, res) => {
  try {
    if (!MANAGEMENT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only management can reject a company link' });
    }
    const supplierId = parseInt(req.params.supplierId);
    if (!supplierId) return res.status(400).json({ error: 'Invalid supplier id' });

    const { data: supplier } = await supabase
      .from('suppliers').select('id, link_status')
      .eq('id', supplierId).eq('company_id', req.companyId).maybeSingle();
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (supplier.link_status !== 'pending') return res.status(400).json({ error: `Link is not pending (currently ${supplier.link_status})` });

    await supabase.from('suppliers').update({ link_status: 'rejected', updated_at: new Date().toISOString() }).eq('id', supplierId);

    await auditFromReq(req, 'UPDATE', 'supplier', supplierId, {
      module: 'shared',
      metadata: { action: 'client_link_rejected' },
    });

    res.json({ success: true, message: 'Link request rejected.' });
  } catch (err) {
    console.error('[client-links] reject:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/client-links/:recordType/:id/revoke ───────────────────────────
router.post('/:recordType/:id/revoke', async (req, res) => {
  try {
    const { recordType } = req.params;
    if (recordType !== 'customers' && recordType !== 'suppliers') {
      return res.status(400).json({ error: "recordType must be 'customers' or 'suppliers'" });
    }
    if (!MANAGEMENT_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Only management can revoke a company link' });
    }
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const { data: row } = await supabase
      .from(recordType).select('id, eco_client_id, link_status')
      .eq('id', id).eq('company_id', req.companyId).maybeSingle();
    if (!row) return res.status(404).json({ error: `${recordType.slice(0, -1)} not found` });
    if (!row.eco_client_id) return res.status(400).json({ error: 'This record is not a client link' });

    await supabase.from(recordType).update({ link_status: 'revoked', updated_at: new Date().toISOString() }).eq('id', id);

    await auditFromReq(req, 'UPDATE', recordType.slice(0, -1), id, {
      module: 'shared',
      metadata: { action: 'client_link_revoked' },
    });

    res.json({ success: true, message: 'Link revoked.' });
  } catch (err) {
    console.error('[client-links] revoke:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
