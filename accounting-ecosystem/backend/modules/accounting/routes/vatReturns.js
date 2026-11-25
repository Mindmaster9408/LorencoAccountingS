'use strict';

/**
 * /api/accounting/vat-returns — filed SARS VAT returns, payments, differences.
 * Service: services/vatReturnsService.js (migration 189).
 *
 *   GET    /overview                 all periods with filed figures + payments
 *   GET    /periods/:periodId        one period: versions, payments, Leo now, differences
 *   POST   /returns                  capture a filed return / revision     (admin, accountant)
 *   POST   /payments                 add a payment / refund                (admin, accountant)
 *   DELETE /payments/:id             remove a mistaken payment (soft)      (admin, accountant)
 *   POST   /corrections              carry a difference to a later return  (admin, accountant)
 *   POST   /corrections/:id/cancel   cancel it (target not filed yet)      (admin, accountant)
 */

const express = require('express');
const router = express.Router();
const vatReturnsService = require('../services/vatReturnsService');
const auditLogger = require('../services/auditLogger');
const { authenticate, authorize, PERMISSIONS } = require('../middleware/auth');
const { enforceCompanyStatus } = require('../middleware/companyStatus');

router.use(authenticate);
router.use(enforceCompanyStatus);

function canViewVat(req, res, next) {
  if (req.user.isGlobalAdmin) return next();
  const roles = [...(PERMISSIONS['vat.view'] || []), ...(PERMISSIONS['report.view'] || [])];
  if (roles.includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
}

const userIdOf = req => req.user.id || req.user.userId || null;

function fail(res, err, what) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[vat-returns] ${what}:`, err.message);
  return res.status(status).json({
    error: status >= 500 ? `Failed to ${what}` : err.message,
    code: status < 500 && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : undefined,
    detail: status >= 500 ? err.message : undefined,
  });
}

router.get('/overview', canViewVat, async (req, res) => {
  try {
    res.json({ periods: await vatReturnsService.overview(req.user.companyId), fields: vatReturnsService.FIELDS });
  } catch (err) { fail(res, err, 'load VAT returns'); }
});

router.get('/periods/:periodId', canViewVat, async (req, res) => {
  try {
    const periodId = parseInt(req.params.periodId, 10);
    if (!periodId) return res.status(400).json({ error: 'Invalid period' });
    res.json(await vatReturnsService.getPeriod(req.user.companyId, periodId));
  } catch (err) { fail(res, err, 'load the VAT period'); }
});

router.post('/returns', authorize('admin', 'accountant'), async (req, res) => {
  try {
    const result = await vatReturnsService.captureReturn(req.user.companyId, userIdOf(req), req.body || {});
    await auditLogger.log({
      companyId: req.user.companyId, actorType: 'USER', actorId: userIdOf(req),
      actionType: result.supersededReturnId ? 'VAT_RETURN_REVISED' : 'VAT_RETURN_CAPTURED',
      entityType: 'vat_return', entityId: result.saved.id,
      afterJson: result.saved,
      metadata: { periodId: result.saved.vat_period_id, version: result.saved.version, supersededReturnId: result.supersededReturnId },
    }).catch(e => console.warn('[vat-returns] audit log failed:', e.message));
    res.status(201).json(result);
  } catch (err) { fail(res, err, 'save the VAT return'); }
});

router.post('/payments', authorize('admin', 'accountant'), async (req, res) => {
  try {
    const payment = await vatReturnsService.addPayment(req.user.companyId, userIdOf(req), req.body || {});
    await auditLogger.log({
      companyId: req.user.companyId, actorType: 'USER', actorId: userIdOf(req),
      actionType: 'VAT_PAYMENT_CAPTURED', entityType: 'vat_payment', entityId: payment.id, afterJson: payment,
    }).catch(e => console.warn('[vat-returns] audit log failed:', e.message));
    res.status(201).json({ payment });
  } catch (err) { fail(res, err, 'save the payment'); }
});

router.delete('/payments/:id', authorize('admin', 'accountant'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid payment' });
    const payment = await vatReturnsService.deletePayment(req.user.companyId, userIdOf(req), id);
    await auditLogger.log({
      companyId: req.user.companyId, actorType: 'USER', actorId: userIdOf(req),
      actionType: 'VAT_PAYMENT_DELETED', entityType: 'vat_payment', entityId: id, beforeJson: payment,
    }).catch(e => console.warn('[vat-returns] audit log failed:', e.message));
    res.json({ deleted: payment });
  } catch (err) { fail(res, err, 'remove the payment'); }
});

router.post('/corrections', authorize('admin', 'accountant'), async (req, res) => {
  try {
    const { correction } = await vatReturnsService.carryCorrection(req.user.companyId, userIdOf(req), req.body || {});
    await auditLogger.log({
      companyId: req.user.companyId, actorType: 'USER', actorId: userIdOf(req),
      actionType: 'VAT_CORRECTION_CARRIED', entityType: 'vat_correction', entityId: correction.id, afterJson: correction,
      metadata: { sourcePeriodId: correction.source_period_id, targetPeriodId: correction.target_period_id },
    }).catch(e => console.warn('[vat-returns] audit log failed:', e.message));
    res.status(201).json({ correction });
  } catch (err) { fail(res, err, 'carry the correction'); }
});

router.post('/corrections/:id/cancel', authorize('admin', 'accountant'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid correction' });
    const correction = await vatReturnsService.cancelCorrection(req.user.companyId, userIdOf(req), id, (req.body || {}).reason);
    await auditLogger.log({
      companyId: req.user.companyId, actorType: 'USER', actorId: userIdOf(req),
      actionType: 'VAT_CORRECTION_CANCELLED', entityType: 'vat_correction', entityId: id, afterJson: correction,
    }).catch(e => console.warn('[vat-returns] audit log failed:', e.message));
    res.json({ correction });
  } catch (err) { fail(res, err, 'cancel the correction'); }
});

module.exports = router;
