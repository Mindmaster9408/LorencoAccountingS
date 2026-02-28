/**
 * Coaching Module — AI Assistant Routes (CJS)
 * Requires ANTHROPIC_API_KEY in .env to enable AI features.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticateToken, requireCoach, requireClientAccess, requireModuleAccess } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCoach);
router.use(requireModuleAccess('ai_assistant'));

// Chat with AI
router.post('/chat',
  [body('clientId').optional().isInt(), body('message').notEmpty().trim()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { clientId, message } = req.body;
      const coachId = req.user.id;

      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'AI service not configured. Set ANTHROPIC_API_KEY in environment.' });
      }

      // Lazy-load Anthropic to avoid crashing on startup if not installed
      let Anthropic;
      try {
        Anthropic = require('@anthropic-ai/sdk');
      } catch {
        return res.status(503).json({ error: 'AI SDK not installed. Run: npm install @anthropic-ai/sdk' });
      }

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        system: 'You are an AI coaching assistant helping professional coaches better understand and support their clients.',
        messages: [{ role: 'user', content: message }]
      });

      const aiResponse = response.content[0].text;
      const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

      // Log conversation
      try {
        await query(
          `INSERT INTO coaching_ai_conversations (coach_id, client_id, role, content, ai_provider)
           VALUES ($1, $2, 'user', $3, null)`,
          [coachId, clientId || null, message]
        );
        await query(
          `INSERT INTO coaching_ai_conversations (coach_id, client_id, role, content, ai_provider, tokens_used)
           VALUES ($1, $2, 'assistant', $3, 'claude', $4)`,
          [coachId, clientId || null, aiResponse, tokensUsed]
        );
      } catch (logErr) {
        console.warn('[Coaching] AI log error:', logErr.message);
      }

      res.json({ success: true, provider: 'claude', response: aiResponse, tokensUsed });
    } catch (error) {
      console.error('[Coaching] AI chat error:', error.message);
      res.status(500).json({ error: 'Failed to get AI response' });
    }
  }
);

// Get insights about a specific client
router.get('/insights/:clientId', requireClientAccess, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI service not configured. Set ANTHROPIC_API_KEY in environment.' });
    }

    const { clientId } = req.params;
    const coachId = req.user.id;

    const clientResult = await query('SELECT * FROM coaching_clients WHERE id = $1', [clientId]);
    if (clientResult.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    const client = clientResult.rows[0];
    const gaugesResult = await query(
      `SELECT DISTINCT ON (gauge_key) gauge_key, gauge_value FROM coaching_client_gauges
       WHERE client_id = $1 ORDER BY gauge_key, recorded_at DESC`,
      [clientId]
    );
    const sessionsResult = await query(
      `SELECT * FROM coaching_client_sessions WHERE client_id = $1 ORDER BY session_date DESC LIMIT 5`,
      [clientId]
    );

    const gaugesSummary = gaugesResult.rows.map(g => `${g.gauge_key}: ${g.gauge_value}/100`).join(', ');
    const sessionsSummary = sessionsResult.rows.length > 0
      ? sessionsResult.rows.map(s => `- ${s.session_date}: ${s.summary || 'No summary'}`).join('\n')
      : 'No recent sessions';

    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); } catch {
      return res.status(503).json({ error: 'AI SDK not installed. Run: npm install @anthropic-ai/sdk' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      system: 'You are an AI coaching assistant providing insights about clients to help coaches.',
      messages: [{
        role: 'user',
        content: `Provide coaching insights for: ${client.name}\nDream: ${client.dream || 'Not specified'}\nProgress: ${client.progress_completed}/${client.progress_total}\nGauges: ${gaugesSummary}\nRecent Sessions:\n${sessionsSummary}`
      }]
    });

    res.json({ success: true, insights: response.content[0].text });
  } catch (error) {
    console.error('[Coaching] Get insights error:', error.message);
    res.status(500).json({ error: 'Failed to get client insights' });
  }
});

module.exports = router;
