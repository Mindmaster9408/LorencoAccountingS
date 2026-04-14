-- Coaching App Database Schema
-- PostgreSQL 14+

-- Drop existing tables if they exist (for development)
DROP TABLE IF EXISTS ai_conversations CASCADE;
DROP TABLE IF EXISTS ai_learning_data CASCADE;
DROP TABLE IF EXISTS client_sessions CASCADE;
DROP TABLE IF EXISTS client_gauges CASCADE;
DROP TABLE IF EXISTS client_steps CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP TABLE IF EXISTS coach_program_access CASCADE;
DROP TABLE IF EXISTS program_modules CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS client_status CASCADE;

-- Create custom types
CREATE TYPE user_role AS ENUM ('admin', 'coach', 'client');
CREATE TYPE client_status AS ENUM ('active', 'paused', 'completed', 'archived');

-- Users table (coaches and admins)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role user_role DEFAULT 'coach',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Program modules (features that can be activated/deactivated)
CREATE TABLE program_modules (
    id SERIAL PRIMARY KEY,
    module_key VARCHAR(100) UNIQUE NOT NULL,
    module_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Coach program access (which modules each coach can access)
CREATE TABLE coach_program_access (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    module_id INTEGER REFERENCES program_modules(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT true,
    enabled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    enabled_by INTEGER REFERENCES users(id),
    UNIQUE(coach_id, module_id)
);

-- Clients table
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    preferred_lang VARCHAR(50) DEFAULT 'English',
    status client_status DEFAULT 'active',
    dream TEXT,
    current_step INTEGER DEFAULT 0,
    progress_completed INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 15,
    last_session DATE,
    exercise_data JSONB DEFAULT '{}'::jsonb,
    journey_progress JSONB DEFAULT '{"currentStep": 1, "completedSteps": [], "stepNotes": {}, "stepCompletionDates": {}}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at TIMESTAMP,
    CONSTRAINT unique_client_per_coach UNIQUE(coach_id, email)
);

-- Client journey steps
CREATE TABLE client_steps (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
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

-- Client coaching sessions (moved before gauges)
CREATE TABLE client_sessions (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    coach_id INTEGER REFERENCES users(id),
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

-- Client gauge readings (moved after sessions)
CREATE TABLE client_gauges (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    gauge_key VARCHAR(50) NOT NULL,
    gauge_value INTEGER CHECK (gauge_value >= 0 AND gauge_value <= 100),
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    session_id INTEGER REFERENCES client_sessions(id) ON DELETE SET NULL,
    notes TEXT
);

-- AI Learning Data (stores coaching patterns and preferences)
CREATE TABLE ai_learning_data (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    data_type VARCHAR(100) NOT NULL, -- 'coaching_style', 'client_profile', 'conversation_pattern'
    data_content JSONB NOT NULL,
    importance_score FLOAT DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI Conversations (chat history with AI assistant)
CREATE TABLE ai_conversations (
    id SERIAL PRIMARY KEY,
    coach_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    session_id INTEGER REFERENCES client_sessions(id) ON DELETE SET NULL,
    role VARCHAR(20) NOT NULL, -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    ai_provider VARCHAR(50), -- 'claude', 'grok'
    tokens_used INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_clients_coach_id ON clients(coach_id);
CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_has_exercise_data ON clients USING gin(exercise_data);
CREATE INDEX idx_clients_has_journey_progress ON clients USING gin(journey_progress);
CREATE INDEX idx_client_steps_client_id ON client_steps(client_id);
CREATE INDEX idx_client_gauges_client_id ON client_gauges(client_id);
CREATE INDEX idx_client_sessions_client_id ON client_sessions(client_id);
CREATE INDEX idx_client_sessions_coach_id ON client_sessions(coach_id);
CREATE INDEX idx_ai_learning_coach_id ON ai_learning_data(coach_id);
CREATE INDEX idx_ai_learning_client_id ON ai_learning_data(client_id);
CREATE INDEX idx_ai_conversations_coach_id ON ai_conversations(coach_id);
CREATE INDEX idx_ai_conversations_client_id ON ai_conversations(client_id);
CREATE INDEX idx_coach_program_access_coach_id ON coach_program_access(coach_id);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_client_steps_updated_at BEFORE UPDATE ON client_steps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_client_sessions_updated_at BEFORE UPDATE ON client_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ai_learning_updated_at BEFORE UPDATE ON ai_learning_data
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
