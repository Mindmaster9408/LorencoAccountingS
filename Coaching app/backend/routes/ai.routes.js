// AI Assistant routes
import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticateToken, requireCoach, requireClientAccess, requireModuleAccess } from '../middleware/auth.js';
import aiService from '../services/ai.service.js';

const router = express.Router();

// All routes require authentication and AI module access
router.use(authenticateToken);
router.use(requireCoach);
router.use(requireModuleAccess('ai_assistant'));

// Chat with AI about a client
router.post('/chat',
    [
        body('clientId').optional().isInt(),
        body('message').notEmpty().trim()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { clientId, message } = req.body;
            const coachId = req.user.id;

            // Verify client access if clientId provided
            if (clientId) {
                // This will be checked by middleware if we add requireClientAccess
                // For now, we'll trust the coach owns this client
            }

            const messages = [
                { role: 'user', content: message }
            ];

            const response = await aiService.chat(coachId, clientId || null, messages);

            res.json(response);

        } catch (error) {
            console.error('AI chat error:', error);
            res.status(500).json({ error: 'Failed to get AI response' });
        }
    }
);

// Get insights about a specific client
router.get('/insights/:clientId', requireClientAccess, async (req, res) => {
    try {
        const { clientId } = req.params;
        const coachId = req.user.id;

        const insights = await aiService.getClientInsights(coachId, clientId);

        res.json(insights);

    } catch (error) {
        console.error('Get insights error:', error);
        res.status(500).json({ error: 'Failed to get client insights' });
    }
});

// Get conversation history
router.get('/conversations', async (req, res) => {
    try {
        const { clientId, limit = 50 } = req.query;
        const coachId = req.user.id;

        const result = await query(
            `SELECT * FROM ai_conversations
             WHERE coach_id = $1
             ${clientId ? 'AND client_id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT $${clientId ? '3' : '2'}`,
            clientId ? [coachId, clientId, limit] : [coachId, limit]
        );

        res.json({
            success: true,
            conversations: result.rows
        });

    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ error: 'Failed to retrieve conversations' });
    }
});

// Learn from a coaching session
router.post('/learn/session',
    [
        body('clientId').isInt(),
        body('sessionData').isObject()
    ],
    requireClientAccess,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { clientId, sessionData } = req.body;
            const coachId = req.user.id;

            const result = await aiService.learnFromSession(coachId, clientId, sessionData);

            res.json(result);

        } catch (error) {
            console.error('Learn from session error:', error);
            res.status(500).json({ error: 'Failed to process session learning' });
        }
    }
);

export default router;
