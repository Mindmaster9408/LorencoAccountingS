// Supabase configuration - uses Zeabur environment variables at runtime

// Zeabur injects env vars as window.<VAR_NAME> for static sites in some cases,
// but to be safe, we'll check multiple common patterns
const supabaseUrl = window.SUPABASE_URL ||
                    (window.ENV && window.ENV.SUPABASE_URL) ||
                    'https://glkndlzjkhwfsolueyhk.supabase.co';

const supabaseKey = window.SUPABASE_ANON_KEY ||
                    (window.ENV && window.ENV.SUPABASE_ANON_KEY) ||
                    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsa25kbHpqa2h3ZnNvbHVleWhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MTY1ODUsImV4cCI6MjA4NjM5MjU4NX0.bEQZBXGCjqacuK_qjjfB-KCDNcKvw6ceD9xQdHynbVg';

// Initialize Supabase client
const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

console.log('Supabase connected with URL:', supabaseUrl);
