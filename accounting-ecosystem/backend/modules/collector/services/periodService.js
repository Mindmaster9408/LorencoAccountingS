/**
 * ============================================================================
 * Collector — Period Service
 * ============================================================================
 * Opening a period snapshots the client's active requirement templates into
 * collector_period_items. This snapshot is deliberate: later edits to a
 * template must never rewrite the history of an already-open or closed
 * period — each period_item independently stores its own label/doc_type at
 * the moment the period opened.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

/**
 * Opens a new period for a client, snapshotting all active templates into
 * collector_period_items. Throws if a period with this label already exists
 * for the client (DB UNIQUE(client_id, period_label) is the ultimate guard;
 * this pre-check just gives a clearer error message).
 */
async function openPeriod({ companyId, clientId, periodLabel, periodStart, periodEnd, userId }) {
  const { data: existing } = await supabase
    .from('collector_periods')
    .select('id')
    .eq('client_id', clientId)
    .eq('period_label', periodLabel)
    .maybeSingle();
  if (existing) {
    const err = new Error(`A period "${periodLabel}" already exists for this client.`);
    err.statusCode = 409;
    throw err;
  }

  const { data: period, error: periodErr } = await supabase
    .from('collector_periods')
    .insert({
      company_id: companyId,
      client_id: clientId,
      period_label: periodLabel,
      period_start: periodStart || null,
      period_end: periodEnd || null,
      status: 'open',
      created_by_user_id: userId || null,
    })
    .select()
    .single();
  if (periodErr) throw new Error(periodErr.message);

  const { data: templates, error: tplErr } = await supabase
    .from('collector_requirement_templates')
    .select('*')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('sort_order');
  if (tplErr) throw new Error(tplErr.message);

  if (templates && templates.length > 0) {
    const rows = templates.map(t => ({
      company_id: companyId,
      period_id: period.id,
      template_id: t.id,
      label: t.label,
      doc_type: t.doc_type,
      is_required: t.is_required,
      status: 'outstanding',
    }));
    const { error: itemsErr } = await supabase.from('collector_period_items').insert(rows);
    if (itemsErr) throw new Error(itemsErr.message);
  }

  return period;
}

/**
 * Recomputes and persists a period's status from its items:
 * 'complete' when every required item is accepted or waived, else 'open'
 * (unless already manually 'closed', which this never overrides).
 */
async function recomputePeriodStatus(periodId) {
  const { data: period } = await supabase
    .from('collector_periods')
    .select('id, status')
    .eq('id', periodId)
    .maybeSingle();
  if (!period || period.status === 'closed') return period;

  const { data: items } = await supabase
    .from('collector_period_items')
    .select('is_required, status')
    .eq('period_id', periodId);

  const requiredItems = (items || []).filter(i => i.is_required);
  const allSatisfied = requiredItems.length > 0 &&
    requiredItems.every(i => i.status === 'accepted' || i.status === 'waived');

  const newStatus = allSatisfied ? 'complete' : 'open';
  if (newStatus === period.status) return period;

  const updates = { status: newStatus, updated_at: new Date().toISOString() };
  if (newStatus === 'complete') updates.completed_at = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from('collector_periods')
    .update(updates)
    .eq('id', periodId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return updated;
}

module.exports = { openPeriod, recomputePeriodStatus };
