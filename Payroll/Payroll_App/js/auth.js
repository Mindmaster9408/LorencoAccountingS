// Authentication and Session Management
const AUTH = {
    // Super Admin Credentials (4 slots — each can have different access levels)
    SUPER_ADMINS: [
        {
            id: 'super-admin-001',
            email: 'ruanvlog@lorenco.co.za',
            password: 'Mindmaster@277477',
            name: 'Ruan van Loggerenberg',
            role: 'super_admin',
            accessLevel: 'full' // Access to ALL parts of the system
        },
        {
            id: 'super-admin-002',
            email: 'antonjvr@lorenco.co.za',
            password: 'Lorenco@190409',
            name: 'Anton Janse van Rensburg',
            role: 'super_admin',
            accessLevel: 'full'
        },
        {
            id: 'super-admin-003',
            email: null, // Reserved for future super admin
            password: null,
            name: 'Reserved',
            role: 'super_admin',
            accessLevel: null
        },
        {
            id: 'super-admin-004',
            email: null, // Reserved for future super admin
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
    
    // Demo User
    DEMO_USER: {
        id: 'user-demo',
        email: 'demo@example.com',
        password: 'demo123',
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

    // Mock Users Database
    USERS: [
        {
            id: 'user-001',
            email: 'john.owner@lorenco.com',
            password: 'Password@123',
            name: 'John Smith',
            role: 'business_owner',
            company_id: 'comp-001',
            company_ids: ['comp-001'],
            active: true
        },
        {
            id: 'user-002',
            email: 'sarah.accountant@lorenco.com',
            password: 'Password@123',
            name: 'Sarah Johnson',
            role: 'accountant',
            company_id: 'comp-001',
            company_ids: ['comp-001'],
            active: true
        },
        {
            id: 'user-003',
            email: 'mike.owner@techsolutions.com',
            password: 'Password@123',
            name: 'Mike Tech',
            role: 'business_owner',
            company_id: 'comp-002',
            company_ids: ['comp-002'],
            active: true
        },
        {
            id: 'user-004',
            email: 'emma.accountant@techsolutions.com',
            password: 'Password@123',
            name: 'Emma Watson',
            role: 'accountant',
            company_id: 'comp-002',
            company_ids: ['comp-002'],
            active: true
        },
        {
            id: 'user-005',
            email: 'david.owner@globalconsulting.com',
            password: 'Password@123',
            name: 'David Brown',
            role: 'business_owner',
            company_id: 'comp-003',
            company_ids: ['comp-003'],
            active: true
        }
    ],

    // Login Method
    login: function(email, password) {
        // Check Super Admins (all 4 slots)
        var matchedSuperAdmin = this.SUPER_ADMINS.find(function(sa) {
            return sa.email && sa.email.toLowerCase() === email.toLowerCase() && sa.password === password;
        });
        if (matchedSuperAdmin) {
            // Super admins get access to ALL companies
            var allCompanyIds = this.COMPANIES.map(function(c) { return c.id; });
            var saSession = Object.assign({}, matchedSuperAdmin, {
                company_ids: allCompanyIds,
                company_id: allCompanyIds[0] || null
            });
            this.setSession(saSession);
            // BYPASSED: Super admins now go to normal app flow with elevated access
            // Admin dashboard code preserved for future use
            // Previously: redirect: 'super-admin-dashboard.html'
            var saRedirect = allCompanyIds.length > 1 ? 'company-selection.html' : 'company-dashboard.html';
            return { success: true, user: saSession, redirect: saRedirect };
        }

        // Check Demo User
        if (email === this.DEMO_USER.email && password === this.DEMO_USER.password) {
            this.setSession(this.DEMO_USER);
            return { success: true, user: this.DEMO_USER, redirect: 'company-selection.html' };
        }

        // Check Regular Users (in-memory)
        let user = this.USERS.find(u => u.email === email && u.password === password);
        
        // Check Registered Users (localStorage)
        if (!user) {
            const registeredUsers = this.getRegisteredUsers();
            user = registeredUsers.find(u => u.email === email && u.password === password);
        }

        if (user && user.active) {
            this.setSession(user);
            var ids = user.company_ids || (user.company_id ? [user.company_id] : []);
            var redirect = ids.length > 1 ? 'company-selection.html' : 'company-dashboard.html';
            return { success: true, user: user, redirect: redirect };
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
        localStorage.setItem('registered_companies', JSON.stringify(registeredCompanies));

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
        localStorage.setItem('registered_users', JSON.stringify(registeredUsers));

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
        localStorage.setItem('session', JSON.stringify(sessionData));
    },

    // Get Current Session
    getSession: function() {
        const session = localStorage.getItem('session');
        return session ? JSON.parse(session) : null;
    },

    // Check if User is Logged In
    isLoggedIn: function() {
        return !!this.getSession();
    },

    // Logout
    logout: function() {
        localStorage.removeItem('session');
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

        // Super Admin sees all companies
        if (user.role === 'super_admin') {
            return this.COMPANIES.filter(c => c.active);
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
        const stored = localStorage.getItem('registered_users');
        return stored ? JSON.parse(stored) : [];
    },

    // Get Registered Companies from localStorage
    getRegisteredCompanies: function() {
        const stored = localStorage.getItem('registered_companies');
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
                localStorage.setItem('registered_users', JSON.stringify(registeredUsers));
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
        localStorage.setItem('registered_companies', JSON.stringify(registeredCompanies));

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
            localStorage.setItem('registered_users', JSON.stringify(registeredUsers));
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
        localStorage.setItem('session', JSON.stringify(session));
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
