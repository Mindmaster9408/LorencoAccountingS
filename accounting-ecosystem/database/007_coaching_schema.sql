-- =============================================================================
-- Migration 007: Coaching Module Tables
-- =============================================================================
-- Run this in your Supabase SQL Editor to create the coaching module tables.
-- All tables are prefixed with "coaching_" to avoid naming conflicts.
-- =============================================================================

-- Custom types (only create if they don't exist)
DO $$ BEGIN
    CREATE TYPE coaching_user_role AS ENUM ('admin', 'coach', 'client');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE coaching_client_status AS ENUM ('active', 'paused', 'completed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Users table (coaches and admins)
CREATE TABLE IF NOT EXISTS coaching_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role coaching_user_role DEFAULT 'coach',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Program modules (features that can be activated/deactivated per coach)
CREATE TABLE IF NOT EXISTS coaching_program_modules (
    id SERIAL PRIMARY KEY,
    module_key VARCHAR(100) UNIQUE NOT NULL,
    module_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Coach program access
CREATE TABLE IF NOT EXISTS coaching_coach_program_access (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES coaching_users(id) ON DELETE CASCADE,
    module_id INTEGER REFERENCES coaching_program_modules(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT true,
    enabled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    enabled_by INTEGER REFERENCES coaching_users(id),
    UNIQUE(coach_id, module_id)
);

-- Clients table
CREATE TABLE IF NOT EXISTS coaching_clients (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES coaching_users(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    preferred_lang VARCHAR(50) DEFAULT 'English',
    status coaching_client_status DEFAULT 'active',
    dream TEXT,
    current_step INTEGER DEFAULT 0,
    progress_completed INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 15,
    last_session DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at TIMESTAMP
);

-- Client journey steps
CREATE TABLE IF NOT EXISTS coaching_client_steps (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES coaching_clients(id) ON DELETE CASCADE,
    step_id VARCHAR(100) NOT NULL,
    step_name VARCHAR(200) NOT NULL,
    step_order INTEGER NOT NULL,
    completed BOOLEAN DEFAULT false,
    completed_at TIMESTAMP,
    notes TEXT,
    why TEXT,
    fields JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, step_id)
);

-- Coaching sessions
CREATE TABLE IF NOT EXISTS coaching_client_sessions (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES coaching_clients(id) ON DELETE CASCADE,
    coach_id INTEGER REFERENCES coaching_users(id),
    session_date DATE NOT NULL,
    duration_minutes INTEGER,
    summary TEXT,
    key_insights TEXT[],
    action_items TEXT[],
    mood_before INTEGER CHECK (mood_before >= 1 AND mood_before <= 10),
    mood_after INTEGER CHECK (mood_after >= 1 AND mood_after <= 10),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Client gauge readings
CREATE TABLE IF NOT EXISTS coaching_client_gauges (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES coaching_clients(id) ON DELETE CASCADE,
    gauge_key VARCHAR(50) NOT NULL,
    gauge_value INTEGER CHECK (gauge_value >= 0 AND gauge_value <= 100),
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    session_id INTEGER REFERENCES coaching_client_sessions(id) ON DELETE SET NULL,
    notes TEXT
);

-- AI learning data
CREATE TABLE IF NOT EXISTS coaching_ai_learning_data (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES coaching_users(id) ON DELETE CASCADE,
    client_id INTEGER REFERENCES coaching_clients(id) ON DELETE CASCADE,
    data_type VARCHAR(100) NOT NULL,
    data_content JSONB NOT NULL,
    importance_score FLOAT DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI conversation history
CREATE TABLE IF NOT EXISTS coaching_ai_conversations (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES coaching_users(id) ON DELETE CASCADE,
    client_id INTEGER REFERENCES coaching_clients(id) ON DELETE SET NULL,
    session_id INTEGER REFERENCES coaching_client_sessions(id) ON DELETE SET NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    ai_provider VARCHAR(50),
    tokens_used INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_coaching_clients_coach_id ON coaching_clients(coach_id);
CREATE INDEX IF NOT EXISTS idx_coaching_clients_status ON coaching_clients(status);
CREATE INDEX IF NOT EXISTS idx_coaching_client_steps_client_id ON coaching_client_steps(client_id);
CREATE INDEX IF NOT EXISTS idx_coaching_client_gauges_client_id ON coaching_client_gauges(client_id);
CREATE INDEX IF NOT EXISTS idx_coaching_client_sessions_client_id ON coaching_client_sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_coaching_ai_conversations_coach_id ON coaching_ai_conversations(coach_id);

-- updated_at trigger (reuse or create)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_coaching_users_updated_at ON coaching_users;
CREATE TRIGGER update_coaching_users_updated_at BEFORE UPDATE ON coaching_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_coaching_clients_updated_at ON coaching_clients;
CREATE TRIGGER update_coaching_clients_updated_at BEFORE UPDATE ON coaching_clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_coaching_client_steps_updated_at ON coaching_client_steps;
CREATE TRIGGER update_coaching_client_steps_updated_at BEFORE UPDATE ON coaching_client_steps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_coaching_client_sessions_updated_at ON coaching_client_sessions;
CREATE TRIGGER update_coaching_client_sessions_updated_at BEFORE UPDATE ON coaching_client_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed default program modules
INSERT INTO coaching_program_modules (module_key, module_name, description, is_default)
VALUES
    ('journey', 'Client Journey', '15-step coaching journey', true),
    ('gauges', 'Flight Gauges', 'Client wellbeing gauge dashboard', true),
    ('assessments', 'Assessments', 'BASIS and other assessments', true),
    ('ai_assistant', 'AI Assistant', 'AI-powered coaching insights (requires ANTHROPIC_API_KEY)', false),
    ('reports', 'Reports', 'Client progress reports', true)
ON CONFLICT (module_key) DO NOTHING;

-- =============================================================================
-- NEXT STEPS after running this migration:
-- 1. Get your Supabase direct connection string:
--    Supabase Dashboard → Settings → Database → Connection string (URI, port 5432)
-- 2. Add to your .env:  COACHING_DATABASE_URL=postgresql://...
-- 3. Create the first admin user by calling POST /api/coaching/auth/register
--    with role: "admin"
-- =============================================================================
