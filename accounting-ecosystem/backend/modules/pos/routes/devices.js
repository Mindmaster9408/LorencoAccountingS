/**
 * ============================================================================
 * POS Device Identity Routes — Checkout Charlie (Workstream 82)
 * ============================================================================
 * Manager-side device management: register a new trusted device, list/rename
 * devices, revoke a lost/stolen device, replace one device with another, and
 * clear a device's PIN lockout.
 *
 * These routes all require a manager to already be authenticated with a
 * normal, company-scoped JWT (from POST /api/auth/login +
 * POST /api/auth/select-company) — registration is Flow 1's *second* step,
 * after manager login, matching the ticket exactly. The company a device is
 * registered to is always derived from the manager's JWT (req.companyId),
 * never from client input — a manager cannot register a device into a
 * company they don't have access to.
 *
 * The device *validation* endpoint used by the app on every boot (no JWT
 * exists yet at that point) lives separately in shared/routes/auth.js,
 * alongside the equally pre-auth pin-login endpoint it now gates.
 *
 * Routes:
 *   POST   /api/pos/devices/register        — activate + lock a new device
 *   GET    /api/pos/devices                 — list this company's devices
 *   PATCH  /api/pos/devices/:id/rename       — rename a device
 *   POST   /api/pos/devices/:id/revoke       — revoke (lost/stolen/retired)
 *   POST   /api/pos/devices/:id/replace      — revoke old + register new, same till
 *   POST   /api/pos/devices/:id/unlock       — clear a PIN lockout
 * ============================================================================
 */

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

function generateDeviceToken() {
  return 'DEV-' + crypto.randomBytes(32).toString('hex'); // 256 bits of entropy
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function shapeDevice(d) {
  // Never expose the token hash.
  const { device_token_hash, ...rest } = d;
  return rest;
}

/**
 * POST /api/pos/devices/register
 * Body: { till_id?, device_name, platform?, app_version? }
 * Returns the raw device_token exactly once — the client must store it
 * (it cannot be recovered later; only re-registration can replace it).
 */
router.post('/register', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const { till_id, device_name, platform, app_version } = req.body;
    if (!device_name || !device_name.trim()) {
      return res.status(400).json({ error: 'device_name is required' });
    }

    if (till_id) {
      const { data: till } = await supabase.from('tills').select('id').eq('id', till_id).eq('company_id', req.companyId).maybeSingle();
      if (!till) return res.status(400).json({ error: 'till_id does not belong to this company' });
    }

    const rawToken = generateDeviceToken();
    const tokenHash = hashToken(rawToken);

    const { data: device, error } = await supabase
      .from('pos_devices')
      .insert({
        company_id: req.companyId,
        till_id: till_id || null,
        device_token_hash: tokenHash,
        device_name: device_name.trim(),
        status: 'active',
        platform: platform || null,
        user_agent: req.headers['user-agent'] || null,
        app_version: app_version || null,
        registered_by: req.user.userId,
      })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    posAuditFromReq(req, POS_EVENTS.DEVICE_REGISTERED, {
      entityType: 'device', entityId: device.id,
      metadata: { device_name: device.device_name, till_id: till_id || null },
    });

    res.json({ device: shapeDevice(device), device_token: rawToken });
  } catch (err) {
    console.error('[devices] register:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/devices
 * List this company's devices (Device Management screen).
 */
router.get('/', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pos_devices')
      .select('*, tills(till_name, till_number), last_user:last_user_id(username, full_name), registered_by_user:registered_by(username, full_name)')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ devices: (data || []).map(shapeDevice) });
  } catch (err) {
    console.error('[devices] list:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/pos/devices/:id/rename
 */
router.patch('/:id/rename', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    const { device_name } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Invalid device id' });
    if (!device_name || !device_name.trim()) return res.status(400).json({ error: 'device_name is required' });

    const { data: device, error } = await supabase
      .from('pos_devices')
      .update({ device_name: device_name.trim(), updated_at: new Date().toISOString() })
      .eq('id', deviceId).eq('company_id', req.companyId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!device) return res.status(404).json({ error: 'Device not found' });

    posAuditFromReq(req, POS_EVENTS.DEVICE_RENAMED, { entityType: 'device', entityId: deviceId, metadata: { device_name: device.device_name } });

    res.json({ device: shapeDevice(device) });
  } catch (err) {
    console.error('[devices] rename:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/devices/:id/revoke
 * Immediately blocks PIN login and device validation for this device
 * (Flow 6 — lost/stolen). The device cannot be un-revoked; a replacement
 * or fresh registration is required to bring the physical device back in.
 */
router.post('/:id/revoke', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    if (!deviceId) return res.status(400).json({ error: 'Invalid device id' });
    const reason = (req.body.reason || '').trim();

    const { data: device, error } = await supabase
      .from('pos_devices')
      .update({ status: 'revoked', revoked_by: req.user.userId, revoked_at: new Date().toISOString(), revoke_reason: reason || null, updated_at: new Date().toISOString() })
      .eq('id', deviceId).eq('company_id', req.companyId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!device) return res.status(404).json({ error: 'Device not found' });

    posAuditFromReq(req, POS_EVENTS.DEVICE_REVOKED, { entityType: 'device', entityId: deviceId, metadata: { device_name: device.device_name, reason: reason || null } });

    res.json({ device: shapeDevice(device) });
  } catch (err) {
    console.error('[devices] revoke:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/devices/:id/replace
 * Flow 5 — Replace Device. Revokes the old device and registers a new one
 * with the same till assignment. Returns the new device's raw token, which
 * the NEW physical device must store (the manager performs this action on
 * the new device itself, after logging in on it).
 * Body: { device_name, platform?, app_version? }
 */
router.post('/:id/replace', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const oldDeviceId = parseInt(req.params.id);
    if (!oldDeviceId) return res.status(400).json({ error: 'Invalid device id' });
    const { device_name, platform, app_version } = req.body;
    if (!device_name || !device_name.trim()) return res.status(400).json({ error: 'device_name is required for the replacement device' });

    const { data: oldDevice } = await supabase.from('pos_devices').select('*').eq('id', oldDeviceId).eq('company_id', req.companyId).single();
    if (!oldDevice) return res.status(404).json({ error: 'Device not found' });

    const rawToken = generateDeviceToken();
    const { data: newDevice, error: insErr } = await supabase
      .from('pos_devices')
      .insert({
        company_id: req.companyId, till_id: oldDevice.till_id,
        device_token_hash: hashToken(rawToken), device_name: device_name.trim(),
        status: 'active', platform: platform || null, user_agent: req.headers['user-agent'] || null, app_version: app_version || null,
        registered_by: req.user.userId,
      })
      .select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    await supabase.from('pos_devices')
      .update({ status: 'revoked', revoked_by: req.user.userId, revoked_at: new Date().toISOString(), revoke_reason: 'Replaced by device #' + newDevice.id, replaced_by_device_id: newDevice.id, updated_at: new Date().toISOString() })
      .eq('id', oldDeviceId);

    posAuditFromReq(req, POS_EVENTS.DEVICE_REPLACED, {
      entityType: 'device', entityId: newDevice.id,
      metadata: { old_device_id: oldDeviceId, old_device_name: oldDevice.device_name, new_device_name: newDevice.device_name, till_id: oldDevice.till_id },
    });

    res.json({ device: shapeDevice(newDevice), device_token: rawToken });
  } catch (err) {
    console.error('[devices] replace:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/devices/:id/unlock
 * Clears a device-level PIN lockout (5 failed attempts). Manager-only,
 * per the ticket's explicit "Manager unlock required. Not only user lock.
 * Device lock." rule.
 */
router.post('/:id/unlock', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    if (!deviceId) return res.status(400).json({ error: 'Invalid device id' });

    const { data: device, error } = await supabase
      .from('pos_devices')
      .update({ pin_fail_count: 0, pin_locked_until: null, pin_unlocked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', deviceId).eq('company_id', req.companyId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!device) return res.status(404).json({ error: 'Device not found' });

    posAuditFromReq(req, POS_EVENTS.DEVICE_UNLOCKED, { entityType: 'device', entityId: deviceId, metadata: { device_name: device.device_name } });

    res.json({ device: shapeDevice(device) });
  } catch (err) {
    console.error('[devices] unlock:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
