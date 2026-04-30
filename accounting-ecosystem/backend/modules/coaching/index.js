/**
 * Coaching Module — Main Router (CJS)
 * Mounts all coaching sub-routes under /api/coaching/
 */
const express = require('express');

const router = express.Router();

router.use('/auth',               require('./routes/auth'));
router.use('/clients',            require('./routes/clients'));
router.use('/admin',              require('./routes/admin'));
router.use('/leads',              require('./routes/leads'));
router.use('/settings',           require('./routes/settings'));
router.use('/assessment-tokens',  require('./routes/assessment-tokens'));
router.use('/spil',               require('./routes/spil'));

// AI routes — only mount if ANTHROPIC_API_KEY is configured
if (process.env.ANTHROPIC_API_KEY) {
  router.use('/ai', require('./routes/ai'));
  console.log('  🤖 Coaching AI assistant — ACTIVE');
} else {
  // Mount but return a clear error so the frontend knows AI is unavailable
  router.use('/ai', (req, res) => {
    res.status(503).json({ error: 'AI features not configured. Set ANTHROPIC_API_KEY in environment.' });
  });
  console.log('  ⬜ Coaching AI assistant — disabled (no ANTHROPIC_API_KEY)');
}

module.exports = router;
