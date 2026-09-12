/**
 * Collector — Documents (staff, authenticated)
 * Phase 1 (no AI yet): every upload lands with status='uploaded' and
 * period_item_id=null. Staff review this list and explicitly match each
 * document to a checklist line (accept) or reject it. Nothing here is
 * "intake truth" until a staff member takes that action — same forensic
 * principle as supplier_invoice_ocr_drafts.
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const { getSignedDownloadUrl } = require('../services/storageService');
const { recomputePeriodStatus } = require('../services/periodService');

const router = express.Router();

router.get('/', async (req, res) => {
  const { status, client_id, period_id } = req.query;
  let q = supabase
    .from('collector_documents').select('*')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  if (client_id) q = q.eq('client_id', client_id);
  if (period_id) q = q.eq('period_id', period_id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ documents: data || [] });
});

router.get('/:id/signed-url', async (req, res) => {
  const { data: doc } = await supabase
    .from('collector_documents').select('storage_path')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  try {
    const url = await getSignedDownloadUrl(doc.storage_path, 600);
    res.json({ url, expires_in_seconds: 600 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/accept', async (req, res) => {
  const { period_item_id } = req.body;
  if (!period_item_id) return res.status(400).json({ error: 'period_item_id is required' });

  const { data: doc } = await supabase
    .from('collector_documents').select('*')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { data: item } = await supabase
    .from('collector_period_items').select('id, period_id')
    .eq('id', period_item_id).eq('company_id', req.companyId).single();
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  if (item.period_id !== doc.period_id) {
    return res.status(400).json({ error: 'That checklist item does not belong to this document\'s period.' });
  }

  const now = new Date().toISOString();
  const { data: updatedDoc, error: docErr } = await supabase
    .from('collector_documents')
    .update({
      period_item_id,
      status: 'accepted',
      reviewed_by_user_id: req.user?.userId || null,
      reviewed_at: now,
      accepted_at: now,
      updated_at: now,
    })
    .eq('id', doc.id).eq('company_id', req.companyId)
    .select().single();
  if (docErr) return res.status(500).json({ error: docErr.message });

  await supabase
    .from('collector_period_items')
    .update({ status: 'accepted', updated_at: now })
    .eq('id', period_item_id);

  const period = await recomputePeriodStatus(doc.period_id);

  await auditFromReq(req, 'ACCEPT', 'collector_document', doc.id, { module: 'collector', metadata: { period_item_id } });
  res.json({ document: updatedDoc, period });
});

router.post('/:id/reject', async (req, res) => {
  const { rejection_reason } = req.body;

  const { data: doc } = await supabase
    .from('collector_documents').select('id, period_id')
    .eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const now = new Date().toISOString();
  const { data: updatedDoc, error } = await supabase
    .from('collector_documents')
    .update({
      status: 'rejected',
      reviewed_by_user_id: req.user?.userId || null,
      reviewed_at: now,
      rejected_at: now,
      rejection_reason: rejection_reason || null,
      updated_at: now,
    })
    .eq('id', doc.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'REJECT', 'collector_document', doc.id, { module: 'collector', metadata: { rejection_reason } });
  res.json({ document: updatedDoc });
});

module.exports = router;
