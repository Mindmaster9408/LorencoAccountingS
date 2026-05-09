// Main Express server — Supabase cloud backend
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { testConnection, ensureClientPhotoNotesColumns } from './config/database.js';

// Import routes
import authRoutes from './routes/auth.routes.js';
import clientRoutes from './routes/clients.routes.js';
import adminRoutes from './routes/admin.routes.js';
import aiRoutes from './routes/ai.routes.js';
import leadsRoutes from './routes/leads.routes.js';
import kvRoutes from './routes/kv.routes.js';
import basisRoutes from './routes/basis.routes.js';
import spilRoutes from './routes/spil.routes.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — allow same-origin + any deployed origin
app.use(cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // Limit each IP
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware (development only)
if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
        console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
        next();
    });
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/kv', kvRoutes);
app.use('/api/basis', basisRoutes);
app.use('/api/spil', spilRoutes);

// COMPATIBILITY ALIASES — temporary aliases in case any caller uses the /api/coaching/* prefix.
// These are aliases only. Canonical paths remain /api/clients etc.
app.use('/api/coaching/clients', clientRoutes);
app.use('/api/coaching/auth', authRoutes);

// Settings alias — no dedicated settings table exists; return defaults so app startup
// never blocks on a settings 500. Settings are managed client-side via KV store.
app.all('/api/coaching/settings', (req, res) => {
    res.json({ success: true, settings: {} });
});
app.all('/api/settings', (req, res) => {
    res.json({ success: true, settings: {} });
});

// --- SAFE DEBUG ROUTE (remove after diagnosis) ---
app.get('/api/debug/db-config', (req, res) => {
    const debugSecret = process.env.DEBUG_SECRET;
    const requestSecret = req.query.secret || req.headers['x-debug-secret'];
    const isAllowed = (process.env.NODE_ENV !== 'production') ||
        (debugSecret && requestSecret === debugSecret);
    if (!isAllowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const rawUrl = process.env.DATABASE_URL || process.env.COACHING_DATABASE_URL;
    const envUsed = process.env.DATABASE_URL ? 'DATABASE_URL'
        : process.env.COACHING_DATABASE_URL ? 'COACHING_DATABASE_URL'
        : 'individual DB_* vars';
    let host = process.env.DB_HOST || '(not set)';
    let port = process.env.DB_PORT || 5432;
    let database = process.env.DB_NAME || 'postgres';
    let user = process.env.DB_USER || 'postgres';
    let ssl = 'enabled (rejectUnauthorized: false)';
    if (rawUrl) {
        try {
            const u = new URL(rawUrl);
            host = u.hostname;
            port = u.port || 5432;
            database = u.pathname.replace(/^\//, '') || 'postgres';
            user = u.username;
        } catch (e) {
            host = '(URL parse failed: ' + e.message + ')';
        }
    }
    res.json({ envUsed, host, port, database, user, ssl });
});
// --- END SAFE DEBUG ROUTE ---

// Serve frontend static files (parent directory = Coaching app root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, '..');
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

// Fallback: serve index.html for unmatched routes
app.get('*', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);

    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// Start server
const startServer = async () => {
    try {
        // Test database connection
        console.log('Testing database connection...');
        const dbConnected = await testConnection();

        if (!dbConnected) {
            console.error('❌ Failed to connect to Supabase database');
            console.error('Please ensure DATABASE_URL is set correctly in .env');
            process.exit(1);
        }

        // Ensure photo and notes columns exist on clients table (idempotent)
        await ensureClientPhotoNotesColumns();

        // Start listening
        app.listen(PORT, '0.0.0.0', () => {
            console.log('=================================');
            console.log('  Coaching App — Cloud Server    ');
            console.log('=================================');
            console.log(`Storage:  Supabase (cloud PostgreSQL)`);
            console.log(`Server:   http://localhost:${PORT}`);
            console.log(`Health:   http://localhost:${PORT}/health`);
            console.log('No local storage — deploy on Zeabur.');
            console.log('=================================');
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
    // Close server & exit process
    process.exit(1);
});

// Start the server
startServer();
