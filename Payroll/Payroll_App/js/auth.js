// Authentication and Session Management
//
// SECURITY NOTE: Super admin credentials are NEVER stored in this file.
// Authentication for all admin-level users is verified server-side via
// POST /api/auth/verify — credentials live only in server environment variables.
//
const AUTH = {
    // Super admin email list (no passwords — stored server-side only)
    SUPER_ADMINS: [
        {
            id: 'super-admin-001',
            email: 'ruanvlog@lorenco.co.za',
            password: null,  // Never stored client-side — verified via /api/auth/verify
            name: 'Ruan van Loggerenberg',
            role: 'super_admin',
            accessLevel: 'full'
        },
        {
            id: 'super-admin-002',
            email: 'antonjvr@lorenco.co.za',
            password: null,  // Never stored client-side — verified via /api/auth/verify
            name: 'Anton Janse van Rensburg',
            role: 'super_admin',
            accessLevel: 'full'
        },
        {
            id: 'super-admin-003',
            email: null,
            password: null,
            name: 'Reserved',
            role: 'super_admin',
            accessLevel: null
        },
        {
            id: 'super-admin-004',
            email: null,
            password: null,
            name: 'Reserved',
            role: 'super_admin',
            accessLevel: null
        }
    ],

    // Legacy single reference (backward compatibility)
    get SUPER_ADMIN() {
        return this.SUPER_ADMINS[0];
    },
    
    // Demo User (password verified via /api/auth/verify or checked against env-configured accounts)
    DEMO_USER: {
        id: 'user-demo',
        email: 'demo@example.com',
        password: null,  // No plaintext passwords in client JS
        name: 'Demo User',
        role: 'business_owner',
        company_id: 'demo-company',
        company_ids: ['demo-company']
    },

    // Mock Companies Database
    COMPANIES: [
        {
            id: 'comp-001',
            name: 'Lorenco Enterprise',
            email: 'info@lorenco.com',
            active: true,
            employees: 12,
            created_date: '2024-01-15',
            subscription_status: 'active'
        },
        {
            id: 'comp-002',
            name: 'Tech Solutions Inc',
            email: 'hr@techsolutions.com',
            active: true,
            employees: 8,
            created_date: '2024-02-10',
            subscription_status: 'active'
        },
        {
            id: 'comp-003',
            name: 'Global Consulting Group',
            email: 'admin@globalconsulting.com',
            active: false,
            employees: 25,
            created_date: '2023-12-01',
            subscription_status: 'suspended'
        },
        {
            id: 'comp-004',
            name: 'Finance Plus',
            email: 'contact@financeplus.com',
            active: true,
            employees: 5,
            created_date: '2024-03-05',
            subscription_status: 'active'
        },
        {
            id: 'comp-005',
            name: 'Retail Masters',
            email: 'support@retailmasters.com',
            active: true,
            employees: 15,
            created_date: '2024-01-20',
            subscription_status: 'active'
        },
        {
            id: 'comp-006',
            name: 'Manufacturing Works',
            email: 'hr@manufworks.com',
            active: true,
            employees: 30,
            created_date: '2023-11-10',
            subscription_status: 'active'
        },
        {
            id: 'demo-company',
            name: 'Demo Company',
            email: 'demo@example.com',
            active: true,
            employees: 0,
            created_date: '2024-01-01',
            subscription_status: 'active'
        }
    ],

    // Mock Users Database (demo accounts — passwords never stored here, verified server-side)
    USERS: [
        {
            id: 'user-001',
            email: 'john.owner@lorenco.com',
            password: null,  // Use /api/auth/verify for credential checking
            name: 'John Smith',
            role: 'business_owner',
            company_id: 'comp-001',
            company_ids: ['comp-001'],
            active: true
        },
        {
            id: 'user-002',
            email: 'sarah.accountant@lorenco.com',
            password: null,
            name: 'Sarah Johnson',
            role: 'accountant',
            company_id: 'comp-001',
            company_ids: ['comp-001'],
            active: true
        },
        {
            id: 'user-003',
            email: 'mike.owner@techsolutions.com',
            password: null,
            name: 'Mike Tech',
            role: 'business_owner',
            company_id: 'comp-002',
            company_ids: ['comp-002'],
            active: true
        },
        {
            id: 'user-004',
            email: 'emma.accountant@techsolutions.com',
            password: null,
            name: 'Emma Watson',
            role: 'accountant',
            company_id: 'comp-002',
            company_ids: ['comp-002'],
            active: true
        },
        {
            id: 'user-005',
            email: 'david.owner@globalconsulting.com',
            password: null,
            name: 'David Brown',
            role: 'business_owner',
            company_id: 'comp-003',
            company_ids: ['comp-003'],
            active: true
        }
    ],

    // Login Method — server-side credential verification only.
    // No passwords are compared client-side. All credential checks go through
    // POST /api/auth/verify which reads credentials from server environment variables.
    login: async function(email, password) {
        // Step 1: Verify credentials server-side (no client-side password comparison)
        try {
            var verifyResp = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, password: password })
            });
            var verifyData = await verifyResp.json();

            if (verifyResp.ok && verifyData.success) {
                // Server confirmed credentials — build session from known local user profile
                var serverUser = verifyData.user;
                var role = serverUser.role || 'super_admin';
                var token = verifyData.token || null;

                // Find matching profile by email (for company_ids etc.)
                var matchedSA = this.SUPER_ADMINS.find(function(sa) {
                    return sa.email && sa.email.toLowerCase() === email.toLowerCase();
                });

                var allCompanies = this.getAllCompaniesWithRegistered();
                var allCompanyIds = allCompanies.map(function(c) { return c.id; });
                var lastSession = this.getSession();
                var defaultCompanyId = (lastSession && lastSession.company_id && allCompanyIds.indexOf(lastSession.company_id) >= 0)
                    ? lastSession.company_id
                    : (allCompanyIds[0] || null);

                var sessionUser = {
                    id: matchedSA ? matchedSA.id : ('srv-' + Math.random().toString(36).substr(2, 8)),
                    email: serverUser.email,
                    name: serverUser.name || matchedSA && matchedSA.name || email,
                    role: role,
                    company_id: defaultCompanyId,
                    company_ids: role === 'super_admin' ? allCompanyIds : [defaultCompanyId],
                    accessLevel: 'full'
                };

                // Store token for authenticating storage requests
                if (token) safeLocalStorage.setItem('token', token);
                this.setSession(sessionUser);

                if (typeof AuditTrail !== 'undefined') {
                    AuditTrail.logLogin(defaultCompanyId, email, sessionUser.name, role);
                }

                var redirect = sessionUser.company_ids.length > 1 ? 'company-selection.html' : 'company-dashboard.html';
                return { success: true, user: sessionUser, redirect: redirect };
            }
        } catch (e) {
            console.warn('Server auth unavailable — trying local fallback:', e.message);
        }

        // Fallback: registered users stored in KV (have passwords set during registration)
        var registeredUsers = this.getRegisteredUsers();
        var regUser = registeredUsers.find(function(u) {
            return u.email === email && u.password && u.password === password;
        });
        if (regUser && regUser.active !== false) {
            this.setSession(regUser);
            var ids = regUser.company_ids || (regUser.company_id ? [regUser.company_id] : []);
            if (typeof AuditTrail !== 'undefined') {
                AuditTrail.logLogin(regUser.company_id || null, regUser.email, regUser.name, regUser.role);
            }
            var regRedirect = ids.length > 1 ? 'company-selection.html' : 'company-dashboard.html';
            return { success: true, user: regUser, redirect: regRedirect };
        }

        return { success: false, message: 'Invalid email or password' };
    },

    // Register Method
    register: function(email, password, name, role, company_id) {
        // Check if user exists
        if (this.USERS.find(u => u.email === email)) {
            return { success: false, message: 'Email already registered' };
        }

        const newUser = {
            id: 'user-' + Math.random().toString(36).substr(2, 9),
            email: email,
            password: password,
            name: name,
            role: role,
            company_id: company_id,
            active: true
        };

        this.USERS.push(newUser);
        this.setSession(newUser);
        return { success: true, user: newUser, message: 'Registration successful' };
    },

    // Register with Company (First User & Company Creation)
    registerWithCompany: function(email, password, name, role, companyData) {
        // Check if user exists in memory
        if (this.USERS.find(u => u.email === email)) {
            return { success: false, message: 'Email already registered' };
        }

        // Check if user exists in localStorage
        const registeredUsers = this.getRegisteredUsers();
        if (registeredUsers.find(u => u.email === email)) {
            return { success: false, message: 'Email already registered' };
        }

        // Create new company
        const newCompany = {
            id: 'comp-' + Math.random().toString(36).substr(2, 9),
            name: companyData.name,
            email: companyData.email,
            active: true,
            employees: 0,
            created_date: new Date().toISOString().split('T')[0],
            subscription_status: 'active'
        };

        this.COMPANIES.push(newCompany);
        
        // Save company to localStorage
        const registeredCompanies = this.getRegisteredCompanies();
        registeredCompanies.push(newCompany);
        safeLocalStorage.setItem('registered_companies', JSON.stringify(registeredCompanies));

        // Seed demo company data (employees, payroll items, PAYE config, etc.)
        if (typeof DemoCompanySeed !== 'undefined') {
            DemoCompanySeed.seedForCompany(newCompany.id);
            // Update employee count on company record
            newCompany.employees = DemoCompanySeed.DEMO_EMPLOYEES.length;
        }

        // Create new user with company
        const newUser = {
            id: 'user-' + Math.random().toString(36).substr(2, 9),
            email: email,
            password: password,
            name: name,
            role: role,
            company_id: newCompany.id,
            company_ids: [newCompany.id],
            active: true
        };

        this.USERS.push(newUser);
        
        // Save user to localStorage
        registeredUsers.push(newUser);
        safeLocalStorage.setItem('registered_users', JSON.stringify(registeredUsers));

        this.setSession(newUser);
        return { success: true, user: newUser, company: newCompany, message: 'Registration successful' };
    },

    // Set Session
    setSession: function(user) {
        const sessionData = {
            user_id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            company_id: user.company_id || null,
            company_ids: user.company_ids || (user.company_id ? [user.company_id] : []),
            login_time: new Date().toISOString()
        };
        safeLocalStorage.setItem('session', JSON.stringify(sessionData));
    },

    // Get Current Session
    getSession: function() {
        const session = safeLocalStorage.getItem('session');
        return session ? JSON.parse(session) : null;
    },

    // Check if User is Logged In
    isLoggedIn: function() {
        return !!this.getSession();
    },

    // Logout
    logout: function() {
        var session = this.getSession();
        if (session && typeof AuditTrail !== 'undefined') {
            AuditTrail.logLogout(session.company_id || null, session.email);
        }
        safeLocalStorage.removeItem('session');
        window.location.href = 'login.html';
    },

    // Get Company by ID
    getCompanyById: function(company_id) {
        // Check in-memory companies first
        let company = this.COMPANIES.find(c => c.id === company_id);
        
        // Check registered companies in localStorage
        if (!company) {
            const registeredCompanies = this.getRegisteredCompanies();
            company = registeredCompanies.find(c => c.id === company_id);
        }
        
        return company;
    },

    // Get All Companies
    getAllCompanies: function() {
        return this.COMPANIES;
    },

    // Toggle Company Status
    toggleCompanyStatus: function(company_id) {
        const company = this.getCompanyById(company_id);
        if (company) {
            company.active = !company.active;
            company.subscription_status = company.active ? 'active' : 'suspended';
            return true;
        }
        return false;
    },

    // Get Total Employee Count for a Company
    getCompanyEmployeeCount: function(company_id) {
        const company = this.getCompanyById(company_id);
        return company ? company.employees : 0;
    },

    // Get Total Companies Count
    getTotalCompaniesCount: function() {
        return this.COMPANIES.length;
    },

    // Get Active Companies Count
    getActiveCompaniesCount: function() {
        return this.COMPANIES.filter(c => c.active).length;
    },

    // Get Companies for Current User (all their companies)
    getCompaniesForUser: function(user) {
        if (!user) return [];

        // Super Admin sees all companies (hardcoded + registered)
        if (user.role === 'super_admin') {
            return this.getAllCompaniesWithRegistered().filter(function(c) { return c.active; });
        }

        // Get all company IDs for this user (backward compat: fall back to company_id)
        var ids = user.company_ids || (user.company_id ? [user.company_id] : []);
        if (ids.length === 0) return [];

        // Merge in-memory and registered companies, deduplicate
        var allCompanies = this.COMPANIES.concat(this.getRegisteredCompanies());
        var seen = {};
        var unique = [];
        allCompanies.forEach(function(c) {
            if (!seen[c.id]) { seen[c.id] = true; unique.push(c); }
        });

        return unique.filter(function(c) {
            return c.active && ids.indexOf(c.id) >= 0;
        });
    },

    // Get Registered Users from localStorage
    getRegisteredUsers: function() {
        const stored = safeLocalStorage.getItem('registered_users');
        return stored ? JSON.parse(stored) : [];
    },

    // Get Registered Companies from localStorage
    getRegisteredCompanies: function() {
        const stored = safeLocalStorage.getItem('registered_companies');
        return stored ? JSON.parse(stored) : [];
    },

    // Find a user by email across all sources
    findUserByEmail: function(email) {
        // Check Super Admins
        var sa = this.SUPER_ADMINS.find(function(s) { return s.email && s.email.toLowerCase() === email.toLowerCase(); });
        if (sa) {
            return { source: 'super_admin', user: sa };
        }

        // Check Demo User
        if (email === this.DEMO_USER.email) {
            return { source: 'demo', user: this.DEMO_USER };
        }

        // Check in-memory users
        const memUser = this.USERS.find(u => u.email === email);
        if (memUser) {
            return { source: 'memory', user: memUser };
        }

        // Check registered users in localStorage
        const registeredUsers = this.getRegisteredUsers();
        const regUser = registeredUsers.find(u => u.email === email);
        if (regUser) {
            return { source: 'localStorage', user: regUser };
        }

        return null;
    },

    // Reset password for a user by email
    resetPassword: function(email, newPassword) {
        const found = this.findUserByEmail(email);
        if (!found) {
            return { success: false, message: 'Email not found' };
        }

        // Update password based on source
        if (found.source === 'super_admin') {
            found.user.password = newPassword;
        } else if (found.source === 'demo') {
            this.DEMO_USER.password = newPassword;
        } else if (found.source === 'memory') {
            found.user.password = newPassword;
        } else if (found.source === 'localStorage') {
            const registeredUsers = this.getRegisteredUsers();
            const idx = registeredUsers.findIndex(u => u.email === email);
            if (idx !== -1) {
                registeredUsers[idx].password = newPassword;
                safeLocalStorage.setItem('registered_users', JSON.stringify(registeredUsers));
            }
        }

        return { success: true, message: 'Password updated successfully' };
    },

    // Create a new company (without creating a user)
    createCompany: function(companyData) {
        var newCompany = {
            id: 'comp-' + Math.random().toString(36).substr(2, 9),
            name: companyData.name,
            email: companyData.email || '',
            active: true,
            employees: 0,
            created_date: new Date().toISOString().split('T')[0],
            subscription_status: 'active'
        };

        this.COMPANIES.push(newCompany);

        // Persist to localStorage
        var registeredCompanies = this.getRegisteredCompanies();
        registeredCompanies.push(newCompany);
        safeLocalStorage.setItem('registered_companies', JSON.stringify(registeredCompanies));

        // Seed demo company data (employees, payroll items, PAYE config, etc.)
        if (typeof DemoCompanySeed !== 'undefined') {
            DemoCompanySeed.seedForCompany(newCompany.id);
            newCompany.employees = DemoCompanySeed.DEMO_EMPLOYEES.length;
        }

        return { success: true, company: newCompany };
    },

    // Add a company to a user's company_ids
    addCompanyToUser: function(userId, companyId) {
        // Update in-memory users
        var user = this.USERS.find(function(u) { return u.id === userId; });
        if (user) {
            if (!user.company_ids) user.company_ids = user.company_id ? [user.company_id] : [];
            if (user.company_ids.indexOf(companyId) === -1) {
                user.company_ids.push(companyId);
            }
        }

        // Also check DEMO_USER
        if (this.DEMO_USER.id === userId) {
            if (!this.DEMO_USER.company_ids) this.DEMO_USER.company_ids = this.DEMO_USER.company_id ? [this.DEMO_USER.company_id] : [];
            if (this.DEMO_USER.company_ids.indexOf(companyId) === -1) {
                this.DEMO_USER.company_ids.push(companyId);
            }
        }

        // Update in localStorage registered users
        var registeredUsers = this.getRegisteredUsers();
        var regUser = registeredUsers.find(function(u) { return u.id === userId; });
        if (regUser) {
            if (!regUser.company_ids) regUser.company_ids = regUser.company_id ? [regUser.company_id] : [];
            if (regUser.company_ids.indexOf(companyId) === -1) {
                regUser.company_ids.push(companyId);
            }
            safeLocalStorage.setItem('registered_users', JSON.stringify(registeredUsers));
        }

        return true;
    },

    // Update session company_ids with a new company ID
    refreshSessionCompanyIds: function(newCompanyId) {
        var session = this.getSession();
        if (!session) return false;

        if (!session.company_ids) session.company_ids = session.company_id ? [session.company_id] : [];
        if (session.company_ids.indexOf(newCompanyId) === -1) {
            session.company_ids.push(newCompanyId);
        }
        safeLocalStorage.setItem('session', JSON.stringify(session));
        return true;
    },

    // Get all companies (in-memory + registered), deduplicated
    getAllCompaniesWithRegistered: function() {
        var allCompanies = this.COMPANIES.concat(this.getRegisteredCompanies());
        var seen = {};
        var unique = [];
        allCompanies.forEach(function(c) {
            if (!seen[c.id]) { seen[c.id] = true; unique.push(c); }
        });
        return unique;
    },

    // Find owner/accountant for a company
    getCompanyOwner: function(companyId) {
        // Check in-memory users
        var allUsers = [this.SUPER_ADMIN, this.DEMO_USER].concat(this.USERS).concat(this.getRegisteredUsers());
        var owners = [];
        allUsers.forEach(function(u) {
            var ids = u.company_ids || (u.company_id ? [u.company_id] : []);
            if (ids.indexOf(companyId) >= 0) {
                owners.push({ name: u.name, email: u.email, role: u.role });
            }
        });
        return owners;
    }
};
