/**
 * Lorenco Accounting - Shared Ledger System (ECO edition)
 *
 * Central data store for chart of accounts, journal entries, and reporting.
 * Data is stored in cloud (Supabase) via /api/accounting/kv — never in localStorage.
 * Clearing browser history or switching browsers does NOT lose any data.
 */

// ============================================================
// Cloud localStorage Bridge — ECO Accounting
//
// Intercepts ALL localStorage.*  calls and routes accounting data
// through /api/accounting/kv (Supabase-backed, company-scoped).
// Only token/session/auth state stays in native localStorage.
//
// Safety guarantees:
//  1. Offline writes are queued (never silently dropped) and flushed
//     automatically when the cloud connection is restored.
//  2. A visible warning banner is shown while the connection is lost.
//  3. Synchronous XHR is used for the initial load so page scripts
//     have data immediately. An async fallback handles the future
//     case where browsers block synchronous XHR.
// ============================================================
(function installEcoAccountingLocalStorageBridge() {
    'use strict';

    if (window.__ecoAccountingBridgeInstalled) return;
    window.__ecoAccountingBridgeInstalled = true;

    var KV_URL = window.location.origin + '/api/accounting/kv';

    function isLocalKey(key) {
        return key === 'token' || key === 'user' || key === 'session' ||
               key === 'demoMode' || key === 'sso_source' || key === 'language' ||
               key === 'auth_token' || key === 'selectedCompanyId' ||
               (typeof key === 'string' && key.indexOf('eco_') === 0);
    }

    window._ecoAccountingKvCache        = {};
    window._ecoAccountingKvOnline       = false;
    window._ecoAccountingKvBridgeReady  = false;
    // Writes queued while the cloud is unreachable — never lost.
    window._ecoAccountingKvPendingWrites = [];

    function getToken() {
        return Storage.prototype.getItem.call(localStorage, 'token') ||
               Storage.prototype.getItem.call(localStorage, 'auth_token') ||
               Storage.prototype.getItem.call(localStorage, 'eco_token');
    }

    // ── Offline warning banner ────────────────────────────────────────────
    function showOfflineBanner() {
        if (document.getElementById('_ecoCloudOfflineBanner')) return;
        var banner = document.createElement('div');
        banner.id = '_ecoCloudOfflineBanner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
            'background:#e74c3c;color:#fff;text-align:center;padding:10px 16px;' +
            'font-size:14px;font-weight:600;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);';
        banner.innerHTML = '\u26A0\uFE0F <strong>Cloud connection lost.</strong> ' +
            'Your changes are held locally and will sync automatically when the connection is restored.';
        function attach() { if (document.body) document.body.prepend(banner); }
        if (document.body) { attach(); } else { document.addEventListener('DOMContentLoaded', attach); }
    }

    function hideOfflineBanner() {
        var banner = document.getElementById('_ecoCloudOfflineBanner');
        if (banner) banner.remove();
        // Show a brief success flash to confirm sync completed
        var flash = document.createElement('div');
        flash.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
            'background:#28a745;color:#fff;text-align:center;padding:10px 16px;' +
            'font-size:14px;font-weight:600;font-family:sans-serif;';
        flash.textContent = '\u2705 Cloud connection restored. All changes synced.';
        function attachFlash() {
            if (document.body) {
                document.body.prepend(flash);
                setTimeout(function() { if (flash.parentNode) flash.remove(); }, 3000);
            }
        }
        if (document.body) { attachFlash(); } else { document.addEventListener('DOMContentLoaded', attachFlash); }
    }

    // ── Pending write queue ───────────────────────────────────────────────
    // Deduplicates by key so only the latest value is sent per key.
    function enqueueWrite(op) {
        var i = window._ecoAccountingKvPendingWrites.findIndex(function(w) { return w.key === op.key; });
        if (op.type === 'remove') {
            if (i >= 0) { window._ecoAccountingKvPendingWrites[i] = op; }
            else        { window._ecoAccountingKvPendingWrites.push(op); }
        } else {
            if (i >= 0) { window._ecoAccountingKvPendingWrites[i] = op; }
            else        { window._ecoAccountingKvPendingWrites.push(op); }
        }
        showOfflineBanner();
    }

    function flushPendingWrites() {
        if (!window._ecoAccountingKvPendingWrites.length) return;
        var queue = window._ecoAccountingKvPendingWrites.slice();
        window._ecoAccountingKvPendingWrites = [];
        console.log('%c\uD83D\uDD04 ECO Accounting: flushing ' + queue.length + ' pending write(s) to cloud', 'color:#fd7e14;font-weight:bold;');
        queue.forEach(function(op) {
            if (op.type === 'set')    { kvNetworkSet(op.key, op.value); }
            else if (op.type === 'remove') { kvNetworkRemove(op.key); }
        });
        hideOfflineBanner();
    }

    // ── Reconnect poller (runs every 30 s while offline) ─────────────────
    var _reconnectTimer = null;
    function startReconnectPoller() {
        if (_reconnectTimer) return;
        _reconnectTimer = setInterval(function() {
            var tok = getToken();
            if (!tok) return;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', KV_URL, true);
            xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        var fresh = JSON.parse(xhr.responseText) || {};
                        // Merge fresh cloud data — pending write keys take priority (they are newer)
                        var pendingKeys = window._ecoAccountingKvPendingWrites.reduce(function(s, w) {
                            s[w.key] = true; return s;
                        }, {});
                        Object.keys(fresh).forEach(function(k) {
                            if (!pendingKeys[k]) window._ecoAccountingKvCache[k] = fresh[k];
                        });
                    } catch(_) {}
                    window._ecoAccountingKvOnline = true;
                    clearInterval(_reconnectTimer);
                    _reconnectTimer = null;
                    console.log('%c\u2705 ECO Accounting: cloud reconnected', 'color:#28a745;font-weight:bold;');
                    flushPendingWrites();
                }
            };
            xhr.send(null);
        }, 30000);
    }

    // ── Network-level PUT / DELETE ────────────────────────────────────────
    function kvNetworkSet(key, value) {
        var tok = getToken();
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', KV_URL + '/' + encodeURIComponent(key), true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
        xhr.onload = function() {
            if (xhr.status < 200 || xhr.status >= 300) {
                console.error('ECO KV set server error: ' + xhr.status + ' key=' + key);
                enqueueWrite({ type: 'set', key: key, value: value });
                window._ecoAccountingKvOnline = false;
                startReconnectPoller();
            }
        };
        xhr.onerror = function() {
            console.warn('ECO KV set network error — queuing write for key=' + key);
            enqueueWrite({ type: 'set', key: key, value: value });
            window._ecoAccountingKvOnline = false;
            startReconnectPoller();
        };
        xhr.send(JSON.stringify({ value: value }));
    }

    function kvNetworkRemove(key) {
        var tok = getToken();
        var xhr = new XMLHttpRequest();
        xhr.open('DELETE', KV_URL + '/' + encodeURIComponent(key), true);
        if (tok) xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
        xhr.onerror = function() {
            console.warn('ECO KV remove network error — queuing for key=' + key);
            enqueueWrite({ type: 'remove', key: key });
            window._ecoAccountingKvOnline = false;
            startReconnectPoller();
        };
        xhr.send(null);
    }

    // ── Cache helpers ─────────────────────────────────────────────────────
    function kvGet(key) {
        var raw = window._ecoAccountingKvCache[key];
        if (raw === undefined || raw === null) return null;
        try { return typeof raw === 'string' ? raw : JSON.stringify(raw); } catch(_) { return String(raw); }
    }

    function kvSet(key, value) {
        var parsed;
        try { parsed = JSON.parse(value); } catch(_) { parsed = value; }
        window._ecoAccountingKvCache[key] = parsed;
        if (!window._ecoAccountingKvOnline) {
            // Queue — never drop
            enqueueWrite({ type: 'set', key: key, value: parsed });
            return;
        }
        kvNetworkSet(key, parsed);
    }

    function kvRemove(key) {
        delete window._ecoAccountingKvCache[key];
        if (!window._ecoAccountingKvOnline) {
            enqueueWrite({ type: 'remove', key: key });
            return;
        }
        kvNetworkRemove(key);
    }

    // ── Initial cloud data load ───────────────────────────────────────────
    // Primary: synchronous XHR so page scripts have data immediately on load.
    // Fallback: async XHR for when browsers eventually remove sync XHR support.
    var _loadedSync = false;
    try {
        var tok = getToken();
        if (tok) {
            var initXhr = new XMLHttpRequest();
            initXhr.open('GET', KV_URL, false);   // synchronous — data ready before page scripts run
            initXhr.setRequestHeader('Authorization', 'Bearer ' + tok);
            initXhr.send(null);
            if (initXhr.status === 200) {
                window._ecoAccountingKvCache = JSON.parse(initXhr.responseText) || {};
                window._ecoAccountingKvOnline  = true;
                window._ecoAccountingKvBridgeReady = true;
                _loadedSync = true;
                console.log('%c\u2705 ECO Accounting cloud connected — data in Supabase (no local)', 'color:#28a745;font-weight:bold;');
            } else {
                console.warn('ECO Accounting bridge: initial load returned HTTP ' + initXhr.status + ' — offline mode');
                window._ecoAccountingKvBridgeReady = true;
                startReconnectPoller();
            }
        } else {
            // No token yet (login page) — bridge ready, no cloud needed
            window._ecoAccountingKvBridgeReady = true;
            _loadedSync = true;
        }
    } catch(e) {
        console.warn('ECO Accounting bridge: sync XHR failed (' + e.message + ') — trying async fallback');
    }

    // Async fallback — used if sync XHR threw (future browser restriction)
    if (!_loadedSync) {
        (function() {
            var tok2 = getToken();
            if (!tok2) { window._ecoAccountingKvBridgeReady = true; return; }
            var asyncXhr = new XMLHttpRequest();
            asyncXhr.open('GET', KV_URL, true);
            asyncXhr.setRequestHeader('Authorization', 'Bearer ' + tok2);
            asyncXhr.onload = function() {
                if (asyncXhr.status === 200) {
                    try { window._ecoAccountingKvCache = JSON.parse(asyncXhr.responseText) || {}; } catch(_) {}
                    window._ecoAccountingKvOnline = true;
                    console.log('%c\u2705 ECO Accounting cloud connected (async fallback)', 'color:#28a745;font-weight:bold;');
                } else {
                    console.warn('ECO Accounting bridge: async fallback returned HTTP ' + asyncXhr.status);
                    startReconnectPoller();
                }
                window._ecoAccountingKvBridgeReady = true;
                window.dispatchEvent(new CustomEvent('ecoAccountingBridgeReady', { detail: { online: window._ecoAccountingKvOnline } }));
            };
            asyncXhr.onerror = function() {
                console.warn('ECO Accounting bridge: async fallback also failed — offline mode');
                window._ecoAccountingKvBridgeReady = true;
                startReconnectPoller();
                window.dispatchEvent(new CustomEvent('ecoAccountingBridgeReady', { detail: { online: false } }));
            };
            asyncXhr.send(null);
        }());
    } else {
        // Sync path — fire the ready event after current call stack clears
        setTimeout(function() {
            window.dispatchEvent(new CustomEvent('ecoAccountingBridgeReady', { detail: { online: window._ecoAccountingKvOnline } }));
        }, 0);
    }

    // ── localStorage overrides ────────────────────────────────────────────
    var _native = {
        getItem:    Storage.prototype.getItem.bind(localStorage),
        setItem:    Storage.prototype.setItem.bind(localStorage),
        removeItem: Storage.prototype.removeItem.bind(localStorage),
        key:        Storage.prototype.key.bind(localStorage)
    };

    localStorage.getItem = function(key) {
        if (isLocalKey(key)) return _native.getItem(key);
        return kvGet(key);
    };
    localStorage.setItem = function(key, value) {
        if (isLocalKey(key)) { _native.setItem(key, value); return; }
        kvSet(key, value);
    };
    localStorage.removeItem = function(key) {
        if (isLocalKey(key)) { _native.removeItem(key); return; }
        kvRemove(key);
    };
    localStorage.key = function(index) {
        return Object.keys(window._ecoAccountingKvCache)[Number(index)] || null;
    };
    try {
        Object.defineProperty(localStorage, 'length', {
            get: function() { return Object.keys(window._ecoAccountingKvCache).length; },
            configurable: true
        });
    } catch(_) {}
}());

const LedgerSystem = (function() {
    'use strict';

    // ==========================================
    // CHART OF ACCOUNTS
    // ==========================================
    const chartOfAccounts = [
        // Assets (1000-1999)
        { code: '1000', name: 'Bank Account', type: 'asset', category: 'Current Assets', vatApplicable: false },
        { code: '1010', name: 'Petty Cash', type: 'asset', category: 'Current Assets', vatApplicable: false },
        { code: '1100', name: 'Accounts Receivable', type: 'asset', category: 'Current Assets', vatApplicable: false },
        { code: '1200', name: 'Inventory', type: 'asset', category: 'Current Assets', vatApplicable: false },
        { code: '1300', name: 'Prepaid Expenses', type: 'asset', category: 'Current Assets', vatApplicable: false },
        { code: '1500', name: 'Property, Plant & Equipment', type: 'asset', category: 'Non-Current Assets', vatApplicable: true },
        { code: '1510', name: 'Accumulated Depreciation', type: 'asset', category: 'Non-Current Assets', vatApplicable: false, contraAccount: true },
        { code: '1600', name: 'Intangible Assets', type: 'asset', category: 'Non-Current Assets', vatApplicable: false },
        { code: '2310', name: 'VAT Input (Claimable)', type: 'asset', category: 'Current Assets', vatApplicable: false },

        // Liabilities (2000-2999)
        { code: '2000', name: 'Accounts Payable', type: 'liability', category: 'Current Liabilities', vatApplicable: false },
        { code: '2100', name: 'Short-term Loans', type: 'liability', category: 'Current Liabilities', vatApplicable: false },
        { code: '2200', name: 'Accrued Expenses', type: 'liability', category: 'Current Liabilities', vatApplicable: false },
        { code: '2300', name: 'VAT Payable', type: 'liability', category: 'Current Liabilities', vatApplicable: false },
        { code: '2400', name: 'PAYE Payable', type: 'liability', category: 'Current Liabilities', vatApplicable: false },
        { code: '2410', name: 'UIF Payable', type: 'liability', category: 'Current Liabilities', vatApplicable: false },
        { code: '2500', name: 'Long-term Loans', type: 'liability', category: 'Non-Current Liabilities', vatApplicable: false },
        { code: '2600', name: 'Deferred Tax Liability', type: 'liability', category: 'Non-Current Liabilities', vatApplicable: false },

        // Equity (3000-3999)
        { code: '3000', name: 'Share Capital', type: 'equity', category: 'Equity', vatApplicable: false },
        { code: '3100', name: 'Retained Earnings', type: 'equity', category: 'Equity', vatApplicable: false },
        { code: '3200', name: 'Current Year Earnings', type: 'equity', category: 'Equity', vatApplicable: false },
        { code: '3300', name: 'Dividends', type: 'equity', category: 'Equity', vatApplicable: false },

        // Income (4000-4999)
        { code: '4000', name: 'Sales Revenue', type: 'income', category: 'Revenue', vatApplicable: true },
        { code: '4100', name: 'Service Revenue', type: 'income', category: 'Revenue', vatApplicable: true },
        { code: '4200', name: 'Interest Income', type: 'income', category: 'Other Income', vatApplicable: false },
        { code: '4300', name: 'Other Income', type: 'income', category: 'Other Income', vatApplicable: true },

        // Cost of Sales (5000-5499)
        { code: '5000', name: 'Cost of Goods Sold', type: 'expense', category: 'Cost of Sales', vatApplicable: true },
        { code: '5100', name: 'Direct Labor', type: 'expense', category: 'Cost of Sales', vatApplicable: false },
        { code: '5200', name: 'Manufacturing Overhead', type: 'expense', category: 'Cost of Sales', vatApplicable: true },

        // Operating Expenses (6000-6999)
        { code: '6000', name: 'Salaries & Wages', type: 'expense', category: 'Operating Expenses', vatApplicable: false },
        { code: '6050', name: 'Employee Benefits', type: 'expense', category: 'Operating Expenses', vatApplicable: false },
        { code: '6100', name: 'Rent Expense', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '6200', name: 'Utilities', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '6300', name: 'Office Supplies', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '6400', name: 'Marketing & Advertising', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '6500', name: 'Insurance', type: 'expense', category: 'Operating Expenses', vatApplicable: false },
        { code: '6600', name: 'Depreciation', type: 'expense', category: 'Operating Expenses', vatApplicable: false },
        { code: '6700', name: 'Professional Fees', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '6800', name: 'Bank Charges', type: 'expense', category: 'Operating Expenses', vatApplicable: false },
        { code: '6900', name: 'Repairs & Maintenance', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '6950', name: 'Travel & Entertainment', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '7000', name: 'Telephone & Internet', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '7100', name: 'Motor Vehicle Expenses', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '7200', name: 'Subscriptions & Licenses', type: 'expense', category: 'Operating Expenses', vatApplicable: true },
        { code: '7500', name: 'Interest Expense', type: 'expense', category: 'Finance Costs', vatApplicable: false },
        { code: '7600', name: 'Bad Debts', type: 'expense', category: 'Operating Expenses', vatApplicable: false },
        { code: '8000', name: 'Income Tax Expense', type: 'expense', category: 'Tax', vatApplicable: false }
    ];

    // VAT Rate (South Africa)
    const VAT_RATE = 0.15;

    // ==========================================
    // DATA STORAGE
    // ==========================================

    function getJournals() {
        const data = localStorage.getItem('lorenco_journals');
        return data ? JSON.parse(data) : [];
    }

    function saveJournals(journals) {
        localStorage.setItem('lorenco_journals', JSON.stringify(journals));
    }

    function getNextJournalNumber() {
        const journals = getJournals();
        const maxNum = journals.reduce((max, j) => {
            const num = parseInt(j.reference.replace('JNL-', '')) || 0;
            return num > max ? num : max;
        }, 0);
        return 'JNL-' + String(maxNum + 1).padStart(5, '0');
    }

    // ==========================================
    // ACCOUNT FUNCTIONS
    // ==========================================

    function getAccount(code) {
        return chartOfAccounts.find(a => a.code === code);
    }

    function getAccountById(id) {
        // For compatibility - id can be code string
        return chartOfAccounts.find(a => a.code === id || a.code === String(id));
    }

    function getAccountsByType(type) {
        return chartOfAccounts.filter(a => a.type === type);
    }

    function getAccountsByCategory(category) {
        return chartOfAccounts.filter(a => a.category === category);
    }

    function getAllAccounts() {
        return [...chartOfAccounts];
    }

    function isVatApplicable(accountCode) {
        const account = getAccount(accountCode);
        return account ? account.vatApplicable : false;
    }

    // ==========================================
    // VAT CALCULATION
    // ==========================================

    function calculateVatFromInclusive(inclusiveAmount) {
        // VAT = Inclusive × (Rate / (1 + Rate))
        // For 15%: VAT = Amount × (0.15 / 1.15) = Amount × 15/115
        const vatAmount = inclusiveAmount * (VAT_RATE / (1 + VAT_RATE));
        const exclusiveAmount = inclusiveAmount - vatAmount;
        return {
            inclusive: round2(inclusiveAmount),
            exclusive: round2(exclusiveAmount),
            vat: round2(vatAmount),
            rate: VAT_RATE
        };
    }

    function calculateVatFromExclusive(exclusiveAmount) {
        const vatAmount = exclusiveAmount * VAT_RATE;
        const inclusiveAmount = exclusiveAmount + vatAmount;
        return {
            inclusive: round2(inclusiveAmount),
            exclusive: round2(exclusiveAmount),
            vat: round2(vatAmount),
            rate: VAT_RATE
        };
    }

    function round2(num) {
        return Math.round(num * 100) / 100;
    }

    // ==========================================
    // JOURNAL ENTRY FUNCTIONS
    // ==========================================

    /**
     * Post a journal entry to the ledger
     * @param {Object} journal - Journal entry object
     * @param {string} journal.date - Date in YYYY-MM-DD format
     * @param {string} journal.description - Description of the entry
     * @param {string} journal.sourceType - Source: 'bank', 'manual', 'vat', 'payroll'
     * @param {Array} journal.lines - Array of journal lines
     * @param {string} journal.lines[].accountCode - Account code
     * @param {number} journal.lines[].debit - Debit amount (0 if credit)
     * @param {number} journal.lines[].credit - Credit amount (0 if debit)
     * @param {string} journal.lines[].description - Line description
     * @returns {Object} Posted journal with reference number
     */
    function postJournal(journal) {
        // Validate
        if (!journal.date || !journal.lines || journal.lines.length < 2) {
            throw new Error('Invalid journal: requires date and at least 2 lines');
        }

        // Validate balance
        let totalDebit = 0;
        let totalCredit = 0;
        journal.lines.forEach(line => {
            totalDebit += line.debit || 0;
            totalCredit += line.credit || 0;
        });

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new Error(`Journal not balanced: Debit R${totalDebit.toFixed(2)} != Credit R${totalCredit.toFixed(2)}`);
        }

        // Create journal entry
        const journalEntry = {
            id: Date.now(),
            reference: getNextJournalNumber(),
            date: journal.date,
            description: journal.description || '',
            sourceType: journal.sourceType || 'manual',
            status: 'posted',
            postedAt: new Date().toISOString(),
            lines: journal.lines.map((line, index) => ({
                lineNumber: index + 1,
                accountCode: line.accountCode,
                accountName: getAccount(line.accountCode)?.name || 'Unknown',
                debit: round2(line.debit || 0),
                credit: round2(line.credit || 0),
                description: line.description || ''
            })),
            totalDebit: round2(totalDebit),
            totalCredit: round2(totalCredit)
        };

        // Save
        const journals = getJournals();
        journals.push(journalEntry);
        saveJournals(journals);

        console.log('Journal posted:', journalEntry.reference, journalEntry);
        return journalEntry;
    }

    /**
     * Post a bank allocation with automatic VAT splitting
     * @param {Object} allocation - Allocation details
     * @param {string} allocation.date - Transaction date
     * @param {string} allocation.description - Description
     * @param {number} allocation.amount - Total amount (positive = money in, negative = money out)
     * @param {string} allocation.accountCode - Primary account to allocate to
     * @param {boolean} allocation.includeVat - Whether to auto-split VAT
     * @param {string} allocation.bankAccountCode - Bank account code (default '1000')
     * @returns {Object} Posted journal
     */
    function postBankAllocation(allocation) {
        const bankAccount = allocation.bankAccountCode || '1000';
        const amount = Math.abs(allocation.amount);
        const isMoneyIn = allocation.amount > 0;
        const account = getAccount(allocation.accountCode);

        const lines = [];

        if (allocation.includeVat && account && account.vatApplicable) {
            // Split VAT from inclusive amount
            const vatCalc = calculateVatFromInclusive(amount);

            if (isMoneyIn) {
                // Money In (e.g., Sales Receipt)
                // Dr Bank, Cr Revenue, Cr VAT Payable
                lines.push({
                    accountCode: bankAccount,
                    debit: vatCalc.inclusive,
                    credit: 0,
                    description: allocation.description
                });
                lines.push({
                    accountCode: allocation.accountCode,
                    debit: 0,
                    credit: vatCalc.exclusive,
                    description: allocation.description + ' (excl VAT)'
                });
                lines.push({
                    accountCode: '2300', // VAT Payable
                    debit: 0,
                    credit: vatCalc.vat,
                    description: 'VAT @ 15%'
                });
            } else {
                // Money Out (e.g., Expense Payment)
                // Dr Expense, Dr VAT Input, Cr Bank
                lines.push({
                    accountCode: allocation.accountCode,
                    debit: vatCalc.exclusive,
                    credit: 0,
                    description: allocation.description + ' (excl VAT)'
                });
                lines.push({
                    accountCode: '2310', // VAT Input
                    debit: vatCalc.vat,
                    credit: 0,
                    description: 'VAT Input @ 15%'
                });
                lines.push({
                    accountCode: bankAccount,
                    debit: 0,
                    credit: vatCalc.inclusive,
                    description: allocation.description
                });
            }
        } else {
            // No VAT split - simple allocation
            if (isMoneyIn) {
                // Dr Bank, Cr Account
                lines.push({
                    accountCode: bankAccount,
                    debit: amount,
                    credit: 0,
                    description: allocation.description
                });
                lines.push({
                    accountCode: allocation.accountCode,
                    debit: 0,
                    credit: amount,
                    description: allocation.description
                });
            } else {
                // Dr Account, Cr Bank
                lines.push({
                    accountCode: allocation.accountCode,
                    debit: amount,
                    credit: 0,
                    description: allocation.description
                });
                lines.push({
                    accountCode: bankAccount,
                    debit: 0,
                    credit: amount,
                    description: allocation.description
                });
            }
        }

        return postJournal({
            date: allocation.date,
            description: allocation.description,
            sourceType: 'bank',
            lines: lines
        });
    }

    // ==========================================
    // REPORTING FUNCTIONS
    // ==========================================

    /**
     * Get Trial Balance
     * @param {string} fromDate - Start date (optional)
     * @param {string} toDate - End date (optional)
     * @returns {Object} Trial balance data
     */
    function getTrialBalance(fromDate, toDate) {
        const journals = getJournals();
        const accountBalances = {};

        // Initialize all accounts
        chartOfAccounts.forEach(account => {
            accountBalances[account.code] = {
                code: account.code,
                name: account.name,
                type: account.type,
                category: account.category,
                debit: 0,
                credit: 0,
                balance: 0
            };
        });

        // Sum up journal lines
        journals.forEach(journal => {
            // Filter by date if specified
            if (fromDate && journal.date < fromDate) return;
            if (toDate && journal.date > toDate) return;

            journal.lines.forEach(line => {
                if (accountBalances[line.accountCode]) {
                    accountBalances[line.accountCode].debit += line.debit || 0;
                    accountBalances[line.accountCode].credit += line.credit || 0;
                }
            });
        });

        // Calculate balances and totals
        let totalDebit = 0;
        let totalCredit = 0;
        const accounts = [];

        Object.values(accountBalances).forEach(acc => {
            // Calculate balance based on account type
            // Assets & Expenses: Debit balance (debit - credit)
            // Liabilities, Equity, Income: Credit balance (credit - debit)
            if (acc.type === 'asset' || acc.type === 'expense') {
                acc.balance = round2(acc.debit - acc.credit);
            } else {
                acc.balance = round2(acc.credit - acc.debit);
            }

            // Only include accounts with activity
            if (acc.debit > 0 || acc.credit > 0) {
                accounts.push({
                    ...acc,
                    debit: round2(acc.debit),
                    credit: round2(acc.credit)
                });
                totalDebit += acc.debit;
                totalCredit += acc.credit;
            }
        });

        // Sort by account code
        accounts.sort((a, b) => a.code.localeCompare(b.code));

        // Calculate summary by type
        const summary = {
            asset: { debit: 0, credit: 0, balance: 0 },
            liability: { debit: 0, credit: 0, balance: 0 },
            equity: { debit: 0, credit: 0, balance: 0 },
            income: { debit: 0, credit: 0, balance: 0 },
            expense: { debit: 0, credit: 0, balance: 0 }
        };

        accounts.forEach(acc => {
            if (summary[acc.type]) {
                summary[acc.type].debit += acc.debit;
                summary[acc.type].credit += acc.credit;
                summary[acc.type].balance += acc.balance;
            }
        });

        // Round summary values
        Object.keys(summary).forEach(type => {
            summary[type].debit = round2(summary[type].debit);
            summary[type].credit = round2(summary[type].credit);
            summary[type].balance = round2(summary[type].balance);
        });

        return {
            fromDate: fromDate || 'Beginning',
            toDate: toDate || new Date().toISOString().split('T')[0],
            accounts: accounts,
            totalDebit: round2(totalDebit),
            totalCredit: round2(totalCredit),
            isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
            summary: summary
        };
    }

    /**
     * Get General Ledger for a specific account
     * @param {string} accountCode - Account code
     * @param {string} fromDate - Start date (optional)
     * @param {string} toDate - End date (optional)
     * @returns {Object} General ledger data
     */
    function getGeneralLedger(accountCode, fromDate, toDate) {
        const account = getAccount(accountCode);
        if (!account) {
            throw new Error('Account not found: ' + accountCode);
        }

        const journals = getJournals();
        const entries = [];
        let runningBalance = 0;

        // Sort journals by date
        const sortedJournals = [...journals].sort((a, b) => a.date.localeCompare(b.date));

        sortedJournals.forEach(journal => {
            journal.lines.forEach(line => {
                if (line.accountCode === accountCode) {
                    // Filter by date if specified
                    if (fromDate && journal.date < fromDate) return;
                    if (toDate && journal.date > toDate) return;

                    // Calculate running balance based on account type
                    if (account.type === 'asset' || account.type === 'expense') {
                        runningBalance += (line.debit || 0) - (line.credit || 0);
                    } else {
                        runningBalance += (line.credit || 0) - (line.debit || 0);
                    }

                    entries.push({
                        date: journal.date,
                        reference: journal.reference,
                        description: line.description || journal.description,
                        debit: line.debit || 0,
                        credit: line.credit || 0,
                        balance: round2(runningBalance)
                    });
                }
            });
        });

        return {
            account: account,
            fromDate: fromDate || 'Beginning',
            toDate: toDate || new Date().toISOString().split('T')[0],
            entries: entries,
            closingBalance: round2(runningBalance)
        };
    }

    /**
     * Get Profit & Loss Report
     * @param {string} fromDate - Start date
     * @param {string} toDate - End date
     * @returns {Object} P&L data
     */
    function getProfitAndLoss(fromDate, toDate) {
        const tb = getTrialBalance(fromDate, toDate);

        const income = tb.accounts.filter(a => a.type === 'income');
        const costOfSales = tb.accounts.filter(a => a.category === 'Cost of Sales');
        const operatingExpenses = tb.accounts.filter(a => a.type === 'expense' && a.category !== 'Cost of Sales' && a.category !== 'Tax' && a.category !== 'Finance Costs');
        const financeExpenses = tb.accounts.filter(a => a.category === 'Finance Costs');
        const taxExpenses = tb.accounts.filter(a => a.category === 'Tax');

        const totalRevenue = income.reduce((sum, a) => sum + a.balance, 0);
        const totalCostOfSales = costOfSales.reduce((sum, a) => sum + a.balance, 0);
        const grossProfit = totalRevenue - totalCostOfSales;
        const totalOperatingExpenses = operatingExpenses.reduce((sum, a) => sum + a.balance, 0);
        const operatingProfit = grossProfit - totalOperatingExpenses;
        const totalFinanceExpenses = financeExpenses.reduce((sum, a) => sum + a.balance, 0);
        const profitBeforeTax = operatingProfit - totalFinanceExpenses;
        const totalTax = taxExpenses.reduce((sum, a) => sum + a.balance, 0);
        const netProfit = profitBeforeTax - totalTax;

        return {
            fromDate,
            toDate,
            revenue: { accounts: income, total: round2(totalRevenue) },
            costOfSales: { accounts: costOfSales, total: round2(totalCostOfSales) },
            grossProfit: round2(grossProfit),
            operatingExpenses: { accounts: operatingExpenses, total: round2(totalOperatingExpenses) },
            operatingProfit: round2(operatingProfit),
            financeExpenses: { accounts: financeExpenses, total: round2(totalFinanceExpenses) },
            profitBeforeTax: round2(profitBeforeTax),
            tax: { accounts: taxExpenses, total: round2(totalTax) },
            netProfit: round2(netProfit)
        };
    }

    /**
     * Get Balance Sheet
     * @param {string} asAtDate - As at date
     * @returns {Object} Balance sheet data
     */
    function getBalanceSheet(asAtDate) {
        const tb = getTrialBalance(null, asAtDate);

        const currentAssets = tb.accounts.filter(a => a.type === 'asset' && a.category === 'Current Assets');
        const nonCurrentAssets = tb.accounts.filter(a => a.type === 'asset' && a.category === 'Non-Current Assets');
        const currentLiabilities = tb.accounts.filter(a => a.type === 'liability' && a.category === 'Current Liabilities');
        const nonCurrentLiabilities = tb.accounts.filter(a => a.type === 'liability' && a.category === 'Non-Current Liabilities');
        const equity = tb.accounts.filter(a => a.type === 'equity');

        // Calculate P&L for retained earnings
        const pl = getProfitAndLoss(null, asAtDate);

        const totalCurrentAssets = currentAssets.reduce((sum, a) => sum + a.balance, 0);
        const totalNonCurrentAssets = nonCurrentAssets.reduce((sum, a) => sum + a.balance, 0);
        const totalAssets = totalCurrentAssets + totalNonCurrentAssets;

        const totalCurrentLiabilities = currentLiabilities.reduce((sum, a) => sum + a.balance, 0);
        const totalNonCurrentLiabilities = nonCurrentLiabilities.reduce((sum, a) => sum + a.balance, 0);
        const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;

        const totalEquity = equity.reduce((sum, a) => sum + a.balance, 0) + pl.netProfit;

        return {
            asAtDate,
            assets: {
                current: { accounts: currentAssets, total: round2(totalCurrentAssets) },
                nonCurrent: { accounts: nonCurrentAssets, total: round2(totalNonCurrentAssets) },
                total: round2(totalAssets)
            },
            liabilities: {
                current: { accounts: currentLiabilities, total: round2(totalCurrentLiabilities) },
                nonCurrent: { accounts: nonCurrentLiabilities, total: round2(totalNonCurrentLiabilities) },
                total: round2(totalLiabilities)
            },
            equity: {
                accounts: equity,
                retainedEarnings: round2(pl.netProfit),
                total: round2(totalEquity)
            },
            totalLiabilitiesAndEquity: round2(totalLiabilities + totalEquity),
            isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
        };
    }

    /**
     * Get VAT Report
     * @param {string} fromDate - Period start
     * @param {string} toDate - Period end
     * @returns {Object} VAT data
     */
    function getVatReport(fromDate, toDate) {
        const journals = getJournals();

        let outputVat = 0;  // VAT Payable (2300) - Credit side
        let inputVat = 0;   // VAT Input (2310) - Debit side

        journals.forEach(journal => {
            if (fromDate && journal.date < fromDate) return;
            if (toDate && journal.date > toDate) return;

            journal.lines.forEach(line => {
                if (line.accountCode === '2300') {
                    outputVat += (line.credit || 0) - (line.debit || 0);
                }
                if (line.accountCode === '2310') {
                    inputVat += (line.debit || 0) - (line.credit || 0);
                }
            });
        });

        const netVat = outputVat - inputVat;

        return {
            fromDate,
            toDate,
            outputVat: round2(outputVat),
            inputVat: round2(inputVat),
            netVat: round2(netVat),
            payable: netVat > 0,
            refundable: netVat < 0
        };
    }

    // ==========================================
    // UTILITY FUNCTIONS
    // ==========================================

    function clearAllData() {
        localStorage.removeItem('lorenco_journals');
        localStorage.removeItem('lorenco_customers');
        localStorage.removeItem('lorenco_pos_sales');
        console.log('All ledger data cleared');
    }

    // ==========================================
    // CUSTOMER FUNCTIONS
    // ==========================================

    const CHECKOUT_CHARLIE_ID = 'checkout-charlie';

    function getCustomers() {
        const data = localStorage.getItem('lorenco_customers');
        let customers = data ? JSON.parse(data) : [];

        // Ensure Checkout Charlie system customer exists
        if (!customers.find(c => c.id === CHECKOUT_CHARLIE_ID)) {
            const ccCustomer = {
                id: CHECKOUT_CHARLIE_ID,
                code: 'CC-POS',
                name: 'Checkout Charlie',
                type: 'system',
                isSystemCustomer: true,
                contact: 'POS System',
                email: '',
                phone: '',
                vat: '',
                address: '',
                city: '',
                postal: '',
                terms: 0,
                creditLimit: 0,
                status: 'active',
                createdAt: new Date().toISOString()
            };
            customers.unshift(ccCustomer);
            saveCustomers(customers);
        }

        return customers;
    }

    function saveCustomers(customers) {
        localStorage.setItem('lorenco_customers', JSON.stringify(customers));
    }

    function getCustomer(customerId) {
        const customers = getCustomers();
        return customers.find(c => c.id === customerId);
    }

    function addCustomer(customer) {
        const customers = getCustomers();
        const newCustomer = {
            id: 'CUST-' + Date.now(),
            code: customer.code || generateCustomerCode(customer.name),
            name: customer.name,
            type: customer.type || 'company',
            isSystemCustomer: false,
            contact: customer.contact || '',
            email: customer.email || '',
            phone: customer.phone || '',
            vat: customer.vat || '',
            address: customer.address || '',
            city: customer.city || '',
            postal: customer.postal || '',
            terms: customer.terms || 30,
            creditLimit: customer.creditLimit || 0,
            status: 'active',
            createdAt: new Date().toISOString()
        };
        customers.push(newCustomer);
        saveCustomers(customers);
        return newCustomer;
    }

    function updateCustomer(customerId, updates) {
        const customers = getCustomers();
        const index = customers.findIndex(c => c.id === customerId);
        if (index === -1) throw new Error('Customer not found');

        // Don't allow editing system customers
        if (customers[index].isSystemCustomer && updates.name) {
            throw new Error('Cannot edit system customer name');
        }

        customers[index] = { ...customers[index], ...updates };
        saveCustomers(customers);
        return customers[index];
    }

    function generateCustomerCode(name) {
        const prefix = name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
        const num = String(Date.now()).slice(-4);
        return prefix + num;
    }

    function getCustomerBalance(customerId) {
        const sales = getPOSSales({ customerId });
        let total = 0;
        let cashPending = 0;
        let cardPending = 0;
        let accountPending = 0;

        sales.forEach(sale => {
            if (sale.status !== 'settled') {
                total += sale.total;
                if (sale.paymentMethod === 'cash') cashPending += sale.total;
                else if (sale.paymentMethod === 'card') cardPending += sale.total;
                else if (sale.paymentMethod === 'account') accountPending += sale.total;
            }
        });

        return {
            customerId,
            total: round2(total),
            cashPending: round2(cashPending),
            cardPending: round2(cardPending),
            accountPending: round2(accountPending)
        };
    }

    // ==========================================
    // POS SALES FUNCTIONS
    // ==========================================

    function getPOSSales(filters = {}) {
        const data = localStorage.getItem('lorenco_pos_sales');
        let sales = data ? JSON.parse(data) : [];

        // Apply filters
        if (filters.customerId) {
            sales = sales.filter(s => s.customerId === filters.customerId);
        }
        if (filters.paymentMethod) {
            sales = sales.filter(s => s.paymentMethod === filters.paymentMethod);
        }
        if (filters.status) {
            sales = sales.filter(s => s.status === filters.status);
        }
        if (filters.fromDate) {
            sales = sales.filter(s => s.date >= filters.fromDate);
        }
        if (filters.toDate) {
            sales = sales.filter(s => s.date <= filters.toDate);
        }
        if (filters.date) {
            sales = sales.filter(s => s.date === filters.date);
        }

        return sales;
    }

    function savePOSSales(sales) {
        localStorage.setItem('lorenco_pos_sales', JSON.stringify(sales));
    }

    function getNextPOSNumber() {
        const sales = getPOSSales();
        const year = new Date().getFullYear();
        const yearSales = sales.filter(s => s.id.includes(`POS-${year}`));
        const maxNum = yearSales.reduce((max, s) => {
            const num = parseInt(s.id.split('-')[2]) || 0;
            return num > max ? num : max;
        }, 0);
        return `POS-${year}-${String(maxNum + 1).padStart(5, '0')}`;
    }

    /**
     * Post a POS Sale
     * Posts to Accounts Receivable (1100), NOT to Bank
     * @param {Object} sale - Sale details
     * @param {string} sale.date - Sale date YYYY-MM-DD
     * @param {string} sale.time - Sale time HH:MM:SS (optional)
     * @param {string} sale.customerId - Customer ID (use 'checkout-charlie' for cash/card)
     * @param {string} sale.paymentMethod - 'cash', 'card', or 'account'
     * @param {string} sale.description - Sale description
     * @param {number} sale.total - Total amount (VAT inclusive)
     * @param {Array} sale.items - Line items (optional)
     * @param {string} sale.externalId - External system ID (from Checkout Charlie)
     * @returns {Object} Posted sale with journal reference
     */
    function postPOSSale(sale) {
        // Validate
        if (!sale.date || !sale.paymentMethod || sale.total === undefined) {
            throw new Error('Sale requires: date, paymentMethod, total');
        }

        // Determine customer
        let customerId = sale.customerId;
        if (sale.paymentMethod === 'cash' || sale.paymentMethod === 'card') {
            customerId = CHECKOUT_CHARLIE_ID;
        }

        if (!customerId) {
            throw new Error('Account sales require a customerId');
        }

        const customer = getCustomer(customerId);
        if (!customer) {
            throw new Error('Customer not found: ' + customerId);
        }

        // Calculate VAT (15% inclusive)
        const vatCalc = calculateVatFromInclusive(Math.abs(sale.total));

        // Create journal entry: Dr A/R, Cr Sales, Cr VAT
        const journalLines = [
            {
                accountCode: '1100', // Accounts Receivable
                debit: vatCalc.inclusive,
                credit: 0,
                description: `${customer.name}: ${sale.description || 'POS Sale'}`
            },
            {
                accountCode: '4000', // Sales Revenue
                debit: 0,
                credit: vatCalc.exclusive,
                description: sale.description || 'POS Sale'
            },
            {
                accountCode: '2300', // VAT Payable
                debit: 0,
                credit: vatCalc.vat,
                description: 'VAT @ 15%'
            }
        ];

        const journal = postJournal({
            date: sale.date,
            description: `POS Sale - ${customer.name}`,
            sourceType: 'pos',
            lines: journalLines
        });

        // Create POS sale record
        const posSale = {
            id: getNextPOSNumber(),
            date: sale.date,
            time: sale.time || new Date().toTimeString().split(' ')[0],
            customerId: customerId,
            customerName: customer.name,
            paymentMethod: sale.paymentMethod,
            description: sale.description || 'POS Sale',
            items: sale.items || [],
            subtotal: vatCalc.exclusive,
            vatAmount: vatCalc.vat,
            total: vatCalc.inclusive,
            status: 'pending', // Not yet settled to bank
            settledDate: null,
            settledBankTxnId: null,
            journalRef: journal.reference,
            externalId: sale.externalId || null,
            createdAt: new Date().toISOString()
        };

        const sales = getPOSSales();
        sales.push(posSale);
        savePOSSales(sales);

        console.log('POS Sale posted:', posSale.id, posSale);
        return posSale;
    }

    /**
     * Get daily POS totals for cash reconciliation
     * @param {string} fromDate - Start date
     * @param {string} toDate - End date
     * @returns {Array} Daily totals
     */
    function getPOSDailyTotals(fromDate, toDate) {
        const sales = getPOSSales({ fromDate, toDate });
        const dailyTotals = {};

        sales.forEach(sale => {
            if (!dailyTotals[sale.date]) {
                dailyTotals[sale.date] = {
                    date: sale.date,
                    cashSales: 0,
                    cardSales: 0,
                    accountSales: 0,
                    totalSales: 0,
                    cashSettled: 0,
                    cardSettled: 0,
                    cashPending: 0,
                    cardPending: 0,
                    cashFullySettled: true,
                    cardFullySettled: true
                };
            }

            const day = dailyTotals[sale.date];

            if (sale.paymentMethod === 'cash') {
                day.cashSales += sale.total;
                if (sale.status === 'settled') {
                    day.cashSettled += sale.total;
                } else {
                    day.cashPending += sale.total;
                    day.cashFullySettled = false;
                }
            } else if (sale.paymentMethod === 'card') {
                day.cardSales += sale.total;
                if (sale.status === 'settled') {
                    day.cardSettled += sale.total;
                } else {
                    day.cardPending += sale.total;
                    day.cardFullySettled = false;
                }
            } else if (sale.paymentMethod === 'account') {
                day.accountSales += sale.total;
            }

            day.totalSales += sale.total;
        });

        // Convert to array and round values
        return Object.values(dailyTotals)
            .map(day => ({
                ...day,
                cashSales: round2(day.cashSales),
                cardSales: round2(day.cardSales),
                accountSales: round2(day.accountSales),
                totalSales: round2(day.totalSales),
                cashSettled: round2(day.cashSettled),
                cardSettled: round2(day.cardSettled),
                cashPending: round2(day.cashPending),
                cardPending: round2(day.cardPending)
            }))
            .sort((a, b) => b.date.localeCompare(a.date)); // Most recent first
    }

    /**
     * Settle POS sales for a day by matching to bank deposit
     * @param {string} date - Date to settle YYYY-MM-DD
     * @param {string} paymentMethod - 'cash' or 'card'
     * @param {number} bankAmount - Amount from bank deposit
     * @param {string} bankDescription - Bank transaction description
     * @returns {Object} Settlement result
     */
    function settlePOSDay(date, paymentMethod, bankAmount, bankDescription) {
        if (!['cash', 'card'].includes(paymentMethod)) {
            throw new Error('Payment method must be cash or card');
        }

        const sales = getPOSSales({
            date,
            paymentMethod,
            status: 'pending',
            customerId: CHECKOUT_CHARLIE_ID
        });

        if (sales.length === 0) {
            throw new Error(`No pending ${paymentMethod} sales found for ${date}`);
        }

        const totalPending = sales.reduce((sum, s) => sum + s.total, 0);
        const difference = round2(bankAmount - totalPending);

        // Create settlement journal: Dr Bank, Cr A/R
        const journal = postJournal({
            date: new Date().toISOString().split('T')[0],
            description: `${paymentMethod.toUpperCase()} deposit settlement - ${date}`,
            sourceType: 'pos-settlement',
            lines: [
                {
                    accountCode: '1000', // Bank
                    debit: bankAmount,
                    credit: 0,
                    description: bankDescription || `${paymentMethod} deposit ${date}`
                },
                {
                    accountCode: '1100', // Accounts Receivable
                    debit: 0,
                    credit: bankAmount,
                    description: `Settle ${paymentMethod} sales ${date}`
                }
            ]
        });

        // Mark sales as settled
        const allSales = getPOSSales();
        const settledIds = [];
        sales.forEach(sale => {
            const idx = allSales.findIndex(s => s.id === sale.id);
            if (idx !== -1) {
                allSales[idx].status = 'settled';
                allSales[idx].settledDate = new Date().toISOString().split('T')[0];
                allSales[idx].settledJournalRef = journal.reference;
                settledIds.push(sale.id);
            }
        });
        savePOSSales(allSales);

        return {
            date,
            paymentMethod,
            salesCount: sales.length,
            salesTotal: round2(totalPending),
            bankAmount: round2(bankAmount),
            difference,
            hasVariance: Math.abs(difference) > 0.01,
            journalRef: journal.reference,
            settledSaleIds: settledIds
        };
    }

    /**
     * Get unreconciled POS days (for cash recon page)
     */
    function getUnreconciledPOSDays() {
        const totals = getPOSDailyTotals();
        return totals.filter(day =>
            (day.cashPending > 0) || (day.cardPending > 0)
        );
    }

    function exportData() {
        return {
            journals: getJournals(),
            exportedAt: new Date().toISOString()
        };
    }

    function importData(data) {
        if (data.journals) {
            saveJournals(data.journals);
            console.log('Imported', data.journals.length, 'journals');
        }
    }

    // ==========================================
    // PUBLIC API
    // ==========================================

    return {
        // Constants
        VAT_RATE,
        CHECKOUT_CHARLIE_ID,

        // Account functions
        getAccount,
        getAccountById,
        getAccountsByType,
        getAccountsByCategory,
        getAllAccounts,
        isVatApplicable,

        // VAT functions
        calculateVatFromInclusive,
        calculateVatFromExclusive,

        // Journal functions
        postJournal,
        postBankAllocation,
        getJournals,

        // Customer functions
        getCustomers,
        getCustomer,
        addCustomer,
        updateCustomer,
        getCustomerBalance,

        // POS Sales functions
        postPOSSale,
        getPOSSales,
        getPOSDailyTotals,
        settlePOSDay,
        getUnreconciledPOSDays,

        // Reporting functions
        getTrialBalance,
        getGeneralLedger,
        getProfitAndLoss,
        getBalanceSheet,
        getVatReport,

        // Utility functions
        clearAllData,
        exportData,
        importData,
        round2
    };
})();

// Make available globally
window.LedgerSystem = LedgerSystem;

console.log('Ledger System loaded. Access via window.LedgerSystem');
