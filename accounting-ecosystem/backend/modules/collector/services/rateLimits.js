/**
 * Collector — Rate limiters for the PUBLIC (unauthenticated) portal only.
 * First real consumer of express-rate-limit in this backend — every other
 * route in this repo relies on JWT auth as its rate-limiting boundary, but
 * these routes are deliberately reachable with no login at all.
 */

const rateLimit = require('express-rate-limit');

const collectorPublicViewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const collectorPublicUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload attempts. Please try again later.' },
});

module.exports = { collectorPublicViewLimiter, collectorPublicUploadLimiter };
