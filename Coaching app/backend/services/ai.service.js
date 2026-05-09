// AI Service - Integrates Claude and Grok with fallback system
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { query } from '../config/database.js';

// Initialize Anthropic (Claude)
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

class AIService {
    constructor() {
        this.primaryProvider = process.env.PRIMARY_AI_PROVIDER || 'claude';
        this.fallbackProvider = process.env.FALLBACK_AI_PROVIDER || 'grok';
    }

    /**
     * Send a message to AI and get response with automatic fallback
     */
    async chat(coachId, clientId, messages, options = {}) {
        try {
            // Try primary provider first
            const response = await this._sendToProvider(
                this.primaryProvider,
                coachId,
                clientId,
                messages,
                options
            );

            // Log conversation
            await this._logConversation(coachId, clientId, messages, response, this.primaryProvider);

            return {
                success: true,
                provider: this.primaryProvider,
                response: response.content,
                tokensUsed: response.tokensUsed
            };

        } catch (primaryError) {
            console.error(`Primary AI provider (${this.primaryProvider}) failed:`, primaryError.message);

            // Try fallback provider
            try {
                const response = await this._sendToProvider(
                    this.fallbackProvider,
                    coachId,
                    clientId,
                    messages,
                    options
                );

                await this._logConversation(coachId, clientId, messages, response, this.fallbackProvider);

                return {
                    success: true,
                    provider: this.fallbackProvider,
                    response: response.content,
                    tokensUsed: response.tokensUsed,
                    fallbackUsed: true
                };

            } catch (fallbackError) {
                console.error(`Fallback AI provider (${this.fallbackProvider}) failed:`, fallbackError.message);

                return {
                    success: false,
                    error: 'Both AI providers failed',
                    details: {
                        primary: primaryError.message,
                        fallback: fallbackError.message
                    }
                };
            }
        }
    }

    /**
     * Get coaching insights about a specific client
     */
    async getClientInsights(coachId, clientId) {
        try {
            // Get client data
            const clientData = await this._getClientContext(coachId, clientId);

            // Get coach's coaching style
            const coachingStyle = await this._getCoachingStyle(coachId);

            // Build prompt
            const systemPrompt = this._buildSystemPrompt(coachingStyle);
            const userPrompt = this._buildClientInsightsPrompt(clientData);

            const messages = [
                { role: 'user', content: userPrompt }
            ];

            const response = await this.chat(coachId, clientId, messages, {
                systemPrompt,
                maxTokens: 2000
            });

            return response;

        } catch (error) {
            console.error('Get client insights error:', error);
            throw error;
        }
    }

    /**
     * Learn from a coaching session
     */
    async learnFromSession(coachId, clientId, sessionData) {
        try {
            // Extract patterns and insights
            const learningData = {
                coach_id: coachId,
                client_id: clientId,
                data_type: 'session_pattern',
                data_content: {
                    summary: sessionData.summary,
                    key_insights: sessionData.key_insights,
                    action_items: sessionData.action_items,
                    mood_change: sessionData.mood_after - sessionData.mood_before,
                    duration: sessionData.duration_minutes,
                    techniques_used: sessionData.techniques_used || []
                },
                importance_score: this._calculateImportanceScore(sessionData)
            };

            // Store learning data
            await query(
                `INSERT INTO coaching_ai_learning_data (coach_id, client_id, data_type, data_content, importance_score)
                 VALUES ($1, $2, $3, $4, $5)`,
                [learningData.coach_id, learningData.client_id, learningData.data_type,
                 JSON.stringify(learningData.data_content), learningData.importance_score]
            );

            return { success: true, message: 'Session learning stored' };

        } catch (error) {
            console.error('Learn from session error:', error);
            throw error;
        }
    }

    /**
     * Send message to specific AI provider
     */
    async _sendToProvider(provider, coachId, clientId, messages, options = {}) {
        if (provider === 'claude') {
            return await this._sendToClaude(messages, options);
        } else if (provider === 'grok') {
            return await this._sendToGrok(messages, options);
        } else {
            throw new Error(`Unknown AI provider: ${provider}`);
        }
    }

    /**
     * Send to Claude (Anthropic)
     */
    async _sendToClaude(messages, options = {}) {
        const systemPrompt = options.systemPrompt || 'You are an AI coaching assistant helping professional coaches better understand and support their clients.';

        const response = await anthropic.messages.create({
            model: options.model || 'claude-3-5-sonnet-20241022',
            max_tokens: options.maxTokens || 1024,
            system: systemPrompt,
            messages: messages
        });

        return {
            content: response.content[0].text,
            tokensUsed: response.usage.input_tokens + response.usage.output_tokens
        };
    }

    /**
     * Send to Grok (xAI)
     */
    async _sendToGrok(messages, options = {}) {
        // Note: Grok API endpoint - adjust based on actual xAI API documentation
        const grokEndpoint = 'https://api.x.ai/v1/chat/completions';

        const response = await axios.post(
            grokEndpoint,
            {
                model: options.model || 'grok-beta',
                messages: [
                    {
                        role: 'system',
                        content: options.systemPrompt || 'You are an AI coaching assistant.'
                    },
                    ...messages
                ],
                max_tokens: options.maxTokens || 1024
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return {
            content: response.data.choices[0].message.content,
            tokensUsed: response.data.usage.total_tokens
        };
    }

    /**
     * Get client context from database
     */
    async _getClientContext(coachId, clientId) {
        const clientResult = await query(
            'SELECT * FROM coaching_clients WHERE id = $1 AND coach_id = $2',
            [clientId, coachId]
        );

        if (clientResult.rows.length === 0) {
            throw new Error('Client not found');
        }

        const client = clientResult.rows[0];

        // Get latest gauges
        const gaugesResult = await query(
            `SELECT DISTINCT ON (gauge_key) gauge_key, gauge_value
             FROM coaching_client_gauges
             WHERE client_id = $1
             ORDER BY gauge_key, recorded_at DESC`,
            [clientId]
        );

        // Get recent sessions
        const sessionsResult = await query(
            `SELECT * FROM coaching_client_sessions
             WHERE client_id = $1
             ORDER BY session_date DESC
             LIMIT 5`,
            [clientId]
        );

        // Get learning data
        const learningResult = await query(
            `SELECT * FROM coaching_ai_learning_data
             WHERE client_id = $1
             ORDER BY importance_score DESC, created_at DESC
             LIMIT 10`,
            [clientId]
        );

        return {
            client,
            gauges: gaugesResult.rows,
            recentSessions: sessionsResult.rows,
            learningData: learningResult.rows
        };
    }

    /**
     * Get coach's coaching style
     */
    async _getCoachingStyle(coachId) {
        const result = await query(
            `SELECT * FROM coaching_ai_learning_data
             WHERE coach_id = $1 AND data_type = 'coaching_style'
             ORDER BY created_at DESC
             LIMIT 1`,
            [coachId]
        );

        if (result.rows.length > 0) {
            return result.rows[0].data_content;
        }

        // Default coaching style
        return {
            approach: 'solution-focused',
            communication_style: 'empathetic and supportive',
            typical_questions: ['What would success look like?', 'What is one step you can take?']
        };
    }

    /**
     * Build system prompt based on coaching style
     */
    _buildSystemPrompt(coachingStyle) {
        return `You are an AI Assistant Coach (AAC) helping a professional coach better understand and support their clients.

Coaching Style Context:
- Approach: ${coachingStyle.approach}
- Communication Style: ${coachingStyle.communication_style}
- Typical Questions: ${(coachingStyle.typical_questions || []).join(', ')}

Your role is to:
1. Provide insights about clients based on their data and coaching history
2. Suggest coaching strategies aligned with the coach's style
3. Identify patterns and trends in client progress
4. Recommend next steps and areas to explore

Be concise, actionable, and empathetic. Focus on practical coaching insights.`;
    }

    /**
     * Build prompt for client insights
     */
    _buildClientInsightsPrompt(clientData) {
        const { client, gauges, recentSessions } = clientData;

        const gaugesSummary = gauges.map(g => `${g.gauge_key}: ${g.gauge_value}/100`).join(', ');
        const sessionsSummary = recentSessions.length > 0
            ? recentSessions.map(s => `- ${s.session_date}: ${s.summary}`).join('\n')
            : 'No recent sessions';

        return `Please provide coaching insights for this client:

Client: ${client.name}
Dream/Vision: ${client.dream || 'Not specified'}
Current Step: ${client.current_step + 1} of ${client.progress_total}
Progress: ${client.progress_completed}/${client.progress_total} steps completed

Current Gauges (1-100):
${gaugesSummary}

Recent Sessions:
${sessionsSummary}

Please provide:
1. Key observations about the client's current state
2. Patterns or trends you notice
3. Specific suggestions for the next coaching session
4. Areas that may need more attention`;
    }

    /**
     * Calculate importance score for learning data
     */
    _calculateImportanceScore(sessionData) {
        let score = 0.5; // Base score

        // Higher mood improvement = higher importance
        if (sessionData.mood_after && sessionData.mood_before) {
            const moodChange = sessionData.mood_after - sessionData.mood_before;
            score += Math.min(moodChange * 0.05, 0.3);
        }

        // More key insights = higher importance
        if (sessionData.key_insights && sessionData.key_insights.length > 0) {
            score += Math.min(sessionData.key_insights.length * 0.05, 0.2);
        }

        return Math.min(Math.max(score, 0), 1); // Clamp between 0 and 1
    }

    /**
     * Log conversation to database
     */
    async _logConversation(coachId, clientId, messages, response, provider) {
        try {
            // Log user messages
            for (const msg of messages) {
                await query(
                    `INSERT INTO coaching_ai_conversations (coach_id, client_id, role, content, ai_provider)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [coachId, clientId, msg.role, msg.content, null]
                );
            }

            // Log AI response
            await query(
                `INSERT INTO coaching_ai_conversations (coach_id, client_id, role, content, ai_provider, tokens_used)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [coachId, clientId, 'assistant', response.content, provider, response.tokensUsed]
            );
        } catch (error) {
            console.error('Failed to log conversation:', error);
            // Don't throw - logging failure shouldn't break the chat
        }
    }
}

export default new AIService();
