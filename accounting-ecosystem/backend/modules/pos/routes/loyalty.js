/**
 * ============================================================================
 * POS Loyalty Routes - Checkout Charlie Module
 * ============================================================================
 * Manages the company's loyalty program configuration and per-customer
 * loyalty point transactions (earn, redeem, adjust).
 *
 * Tables used:
 *   loyalty_programs            — one row per company (program config)
 *   loyalty_transactions        — per-customer earn/redeem/adjust events
 *   customers.loyalty_points    — running balance (denormalised for speed)
 *   customers.loyalty_tier      — 'bronze' | 'silver' | 'gold' | 'platinum'
 *
 * Tier thresholds (hardcoded defaults, could be made configurable later):
 *   bronze:   0–499 points
 *   silver:   500–1999 points
 *   gold:     2000–4999 points
 *   platinum: 5000+ points
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ── Tier helpers ─────────────────────────────────────────────────────────────

function getTier(points) {
  if (points >= 5000) return 'platinum';
  if (points >= 2000) return 'gold';
  if (points >= 500)  return 'silver';
  return 'bronze';
}

// ── Program Config ────────────────────────────────────────────────────────────

/**
 * GET /api/pos/loyalty/program
 * Get this company's loyalty program config (or defaults if not configured).
 */
router.get('/program', requirePermission('PRODUCTS.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('loyalty_programs')
      .select('*')
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    // Return defaults if no program configured yet
    res.json({
      program: data || {
        company_id:             req.companyId,
        name:                   'Loyalty Program',
        points_per_rand:        1,
        redemption_rate:        0.01,
        min_redemption_points:  100,
        is_active:              false,
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/loyalty/program
 * Create or update the loyalty program config for this company.
 */
router.put('/program', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { name, points_per_rand, redemption_rate, min_redemption_points, is_active } = req.body;

    if (points_per_rand !== undefined && points_per_rand <= 0) {
      return res.status(400).json({ error: 'points_per_rand must be positive' });
    }
    if (redemption_rate !== undefined && redemption_rate <= 0) {
      return res.status(400).json({ error: 'redemption_rate must be positive' });
    }
    if (min_redemption_points !== undefined && min_redemption_points < 0) {
      return res.status(400).json({ error: 'min_redemption_points must be non-negative' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (name                  !== undefined) updates.name                  = name;
    if (points_per_rand       !== undefined) updates.points_per_rand       = points_per_rand;
    if (redemption_rate       !== undefined) updates.redemption_rate       = redemption_rate;
    if (min_redemption_points !== undefined) updates.min_redemption_points = min_redemption_points;
    if (is_active             !== undefined) updates.is_active             = is_active;

    // Upsert — insert if not exists, update if exists
    const { data: existing } = await supabase
      .from('loyalty_programs')
      .select('id')
      .eq('company_id', req.companyId)
      .maybeSingle();

    let data, error;
    if (existing) {
      ({ data, error } = await supabase
        .from('loyalty_programs')
        .update(updates)
        .eq('company_id', req.companyId)
        .select()
        .single());
    } else {
      ({ data, error } = await supabase
        .from('loyalty_programs')
        .insert({
          company_id: req.companyId,
          name:                  name                  || 'Loyalty Program',
          points_per_rand:       points_per_rand       ?? 1,
          redemption_rate:       redemption_rate       ?? 0.01,
          min_redemption_points: min_redemption_points ?? 100,
          is_active:             is_active             ?? true,
        })
        .select()
        .single());
    }

    if (error) return res.status(500).json({ error: error.message });

    await auditFromReq(req, 'UPDATE', 'loyalty_program', data.id, {
      module:   'pos',
      newValue: updates,
    });

    res.json({ program: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Customer Loyalty ──────────────────────────────────────────────────────────

/**
 * GET /api/pos/loyalty/customers/:customerId
 * Get a customer's current loyalty balance and transaction history.
 */
router.get('/customers/:customerId', requirePermission('CUSTOMERS.VIEW'), async (req, res) => {
  try {
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, name, loyalty_points, loyalty_tier')
      .eq('id', req.params.customerId)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    const { data: transactions, error: txErr } = await supabase
      .from('loyalty_transactions')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('customer_id', req.params.customerId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (txErr) return res.status(500).json({ error: txErr.message });

    res.json({
      customer,
      transactions: transactions || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/loyalty/earn
 * Award points to a customer after a sale.
 * Typically called automatically by the sales flow, but can also be called
 * manually (e.g. for a correction).
 *
 * Body: { customer_id, sale_id, amount_spent }
 * Points = floor(amount_spent * points_per_rand)
 */
router.post('/earn', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { customer_id, sale_id, amount_spent, notes } = req.body;

    if (!customer_id || amount_spent === undefined) {
      return res.status(400).json({ error: 'customer_id and amount_spent are required' });
    }
    if (amount_spent < 0) {
      return res.status(400).json({ error: 'amount_spent must be non-negative' });
    }

    // Get program config
    const { data: program } = await supabase
      .from('loyalty_programs')
      .select('points_per_rand, is_active')
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!program || !program.is_active) {
      return res.status(400).json({ error: 'Loyalty program is not active for this company' });
    }

    // Verify customer belongs to company
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, loyalty_points')
      .eq('id', customer_id)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    const pointsEarned  = Math.floor(amount_spent * program.points_per_rand);
    const newBalance    = (customer.loyalty_points || 0) + pointsEarned;
    const newTier       = getTier(newBalance);

    // Update customer balance + tier
    await supabase
      .from('customers')
      .update({ loyalty_points: newBalance, loyalty_tier: newTier })
      .eq('id', customer_id)
      .eq('company_id', req.companyId);

    // Record transaction
    const { data: tx, error: txErr } = await supabase
      .from('loyalty_transactions')
      .insert({
        company_id:    req.companyId,
        customer_id,
        sale_id:       sale_id || null,
        type:          'earn',
        points:        pointsEarned,
        balance_after: newBalance,
        notes:         notes || null,
        created_by:    req.user.userId,
      })
      .select()
      .single();

    if (txErr) return res.status(500).json({ error: txErr.message });

    res.status(201).json({
      transaction:    tx,
      points_earned:  pointsEarned,
      new_balance:    newBalance,
      new_tier:       newTier,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/loyalty/redeem
 * Redeem points against a sale.
 *
 * Body: { customer_id, sale_id, points_to_redeem }
 * Rand value = points_to_redeem * redemption_rate
 */
router.post('/redeem', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { customer_id, sale_id, points_to_redeem, notes } = req.body;

    if (!customer_id || points_to_redeem === undefined) {
      return res.status(400).json({ error: 'customer_id and points_to_redeem are required' });
    }
    if (points_to_redeem <= 0) {
      return res.status(400).json({ error: 'points_to_redeem must be positive' });
    }

    // Get program config
    const { data: program } = await supabase
      .from('loyalty_programs')
      .select('redemption_rate, min_redemption_points, is_active')
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (!program || !program.is_active) {
      return res.status(400).json({ error: 'Loyalty program is not active for this company' });
    }

    if (points_to_redeem < program.min_redemption_points) {
      return res.status(400).json({
        error: `Minimum redemption is ${program.min_redemption_points} points`
      });
    }

    // Verify customer and check balance
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, loyalty_points')
      .eq('id', customer_id)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    if ((customer.loyalty_points || 0) < points_to_redeem) {
      return res.status(422).json({
        error:     'Insufficient loyalty points',
        available: customer.loyalty_points || 0,
        requested: points_to_redeem,
      });
    }

    const newBalance    = customer.loyalty_points - points_to_redeem;
    const newTier       = getTier(newBalance);
    const randValue     = parseFloat((points_to_redeem * program.redemption_rate).toFixed(2));

    // Update customer balance + tier
    await supabase
      .from('customers')
      .update({ loyalty_points: newBalance, loyalty_tier: newTier })
      .eq('id', customer_id)
      .eq('company_id', req.companyId);

    // Record transaction
    const { data: tx, error: txErr } = await supabase
      .from('loyalty_transactions')
      .insert({
        company_id:    req.companyId,
        customer_id,
        sale_id:       sale_id || null,
        type:          'redeem',
        points:        -points_to_redeem,
        balance_after: newBalance,
        notes:         notes || null,
        created_by:    req.user.userId,
      })
      .select()
      .single();

    if (txErr) return res.status(500).json({ error: txErr.message });

    res.status(201).json({
      transaction:      tx,
      points_redeemed:  points_to_redeem,
      rand_value:       randValue,
      new_balance:      newBalance,
      new_tier:         newTier,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/loyalty/adjust
 * Manual point adjustment (positive or negative). Requires manager permission.
 *
 * Body: { customer_id, points, notes }
 */
router.post('/adjust', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const { customer_id, points, notes } = req.body;

    if (!customer_id || points === undefined) {
      return res.status(400).json({ error: 'customer_id and points are required' });
    }

    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .select('id, loyalty_points')
      .eq('id', customer_id)
      .eq('company_id', req.companyId)
      .single();

    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

    const newBalance = Math.max(0, (customer.loyalty_points || 0) + points);
    const newTier    = getTier(newBalance);

    await supabase
      .from('customers')
      .update({ loyalty_points: newBalance, loyalty_tier: newTier })
      .eq('id', customer_id)
      .eq('company_id', req.companyId);

    const { data: tx, error: txErr } = await supabase
      .from('loyalty_transactions')
      .insert({
        company_id:    req.companyId,
        customer_id,
        sale_id:       null,
        type:          'adjust',
        points,
        balance_after: newBalance,
        notes:         notes || null,
        created_by:    req.user.userId,
      })
      .select()
      .single();

    if (txErr) return res.status(500).json({ error: txErr.message });

    await auditFromReq(req, 'UPDATE', 'loyalty_points', customer_id, {
      module:   'pos',
      oldValue: customer.loyalty_points,
      newValue: newBalance,
      metadata: { adjustment: points, notes },
    });

    res.status(201).json({
      transaction:  tx,
      new_balance:  newBalance,
      new_tier:     newTier,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
