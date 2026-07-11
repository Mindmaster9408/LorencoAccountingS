/**
 * ============================================================================
 * POS Locations Routes — Checkout Charlie (Workstream 85)
 * ============================================================================
 * Locations (stores/branches/sites) are the prerequisite this workstream's
 * inter-store transfer + shrinkage control system is built on — no such
 * entity existed anywhere in this schema before (confirmed live; see the
 * audit note in pos-schema.js). Deliberately minimal: create/list/edit/
 * archive a location, and assign/remove which users may act for it. Product
 * stock editing by location is a separate, larger, out-of-scope feature
 * (the existing dead #multiLocationInfo/stock-by-location scaffold already
 * gestures at it but was never built) — this module only manages the
 * location entities and who's assigned to them.
 *
 * Routes:
 *   GET    /api/pos/locations                — list this company's locations
 *   POST   /api/pos/locations                — create a location
 *   PATCH  /api/pos/locations/:id             — edit / archive-restore
 *   GET    /api/pos/locations/mine            — locations THIS user is assigned to
 *   GET    /api/pos/locations/:id/users       — list users assigned to a location
 *   POST   /api/pos/locations/:id/users       — assign a user to a location
 *   DELETE /api/pos/locations/:id/users/:userId — remove a user from a location
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

const MANAGEMENT_ROLES_CLIENT = ['super_admin', 'business_owner', 'practice_manager', 'administrator', 'accountant', 'corporate_admin', 'store_manager', 'payroll_admin', 'admin'];

/**
 * Locations a user is assigned to. Management roles are treated as
 * assigned to every location in the company (they administer the whole
 * business) — everyone else must have an explicit user_locations row.
 * Used by store-transfers.js to enforce "users may only access locations
 * assigned to them" server-side, not just hide options in the UI.
 */
async function getAssignedLocationIds(companyId, userId, userRole) {
  if (MANAGEMENT_ROLES_CLIENT.includes(userRole)) {
    const { data } = await supabase.from('locations').select('id').eq('company_id', companyId).eq('is_active', true);
    return (data || []).map(l => l.id);
  }
  const { data } = await supabase.from('user_locations').select('location_id').eq('company_id', companyId).eq('user_id', userId);
  return (data || []).map(r => r.location_id);
}

router.get('/', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const { include_inactive } = req.query;
    let query = supabase.from('locations').select('*').eq('company_id', req.companyId);
    if (include_inactive !== 'true') query = query.eq('is_active', true);
    const { data, error } = await query.order('location_name');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ locations: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/mine', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const ids = await getAssignedLocationIds(req.companyId, req.user.userId, req.user.role);
    if (ids.length === 0) return res.json({ locations: [] });
    const { data } = await supabase.from('locations').select('*').eq('company_id', req.companyId).eq('is_active', true).in('id', ids).order('location_name');
    res.json({ locations: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requirePermission('INVENTORY.CONFIGURE'), async (req, res) => {
  try {
    const { location_name, location_code, address } = req.body;
    if (!location_name || !location_name.trim()) return res.status(400).json({ error: 'location_name is required' });

    const { data, error } = await supabase.from('locations')
      .insert({ company_id: req.companyId, location_name: location_name.trim(), location_code: location_code || null, address: address || null, is_active: true })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.LOCATION_CREATED, { entityType: 'location', entityId: data.id, metadata: { location_name: data.location_name } });
    res.json({ location: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id', requirePermission('INVENTORY.CONFIGURE'), async (req, res) => {
  try {
    const locationId = parseInt(req.params.id);
    if (!locationId) return res.status(400).json({ error: 'Invalid location id' });
    const { location_name, location_code, address, is_active } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (location_name !== undefined) updates.location_name = location_name.trim();
    if (location_code !== undefined) updates.location_code = location_code || null;
    if (address !== undefined) updates.address = address || null;
    if (is_active !== undefined) updates.is_active = !!is_active;

    const { data, error } = await supabase.from('locations').update(updates).eq('id', locationId).eq('company_id', req.companyId).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Location not found' });

    posAuditFromReq(req, POS_EVENTS.LOCATION_UPDATED, { entityType: 'location', entityId: locationId, metadata: { location_name: data.location_name } });
    res.json({ location: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/users', requirePermission('INVENTORY.CONFIGURE'), async (req, res) => {
  try {
    const locationId = parseInt(req.params.id);
    const { data, error } = await supabase.from('user_locations').select('id, user_id, users:user_id(username, full_name)').eq('company_id', req.companyId).eq('location_id', locationId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: (data || []).map(r => ({ user_id: r.user_id, username: r.users?.username, full_name: r.users?.full_name })) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/users', requirePermission('INVENTORY.CONFIGURE'), async (req, res) => {
  try {
    const locationId = parseInt(req.params.id);
    const userId = parseInt(req.body.user_id);
    if (!locationId || !userId) return res.status(400).json({ error: 'user_id is required' });

    const { data: location } = await supabase.from('locations').select('id, location_name').eq('id', locationId).eq('company_id', req.companyId).maybeSingle();
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const { data: access } = await supabase.from('user_company_access').select('user_id').eq('company_id', req.companyId).eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (!access) return res.status(400).json({ error: 'User does not belong to this company' });

    const { error } = await supabase.from('user_locations').upsert(
      { company_id: req.companyId, user_id: userId, location_id: locationId },
      { onConflict: 'company_id,user_id,location_id' }
    );
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.USER_LOCATION_ASSIGNED, { entityType: 'location', entityId: locationId, metadata: { user_id: userId, location_name: location.location_name } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/users/:userId', requirePermission('INVENTORY.CONFIGURE'), async (req, res) => {
  try {
    const locationId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);
    const { error } = await supabase.from('user_locations').delete().eq('company_id', req.companyId).eq('location_id', locationId).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.USER_LOCATION_REMOVED, { entityType: 'location', entityId: locationId, metadata: { user_id: userId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.getAssignedLocationIds = getAssignedLocationIds;
module.exports.MANAGEMENT_ROLES_CLIENT = MANAGEMENT_ROLES_CLIENT;
