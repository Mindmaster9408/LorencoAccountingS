/**
 * Browser Compatibility Polyfills & Utilities
 * Lorenco Accounting Ecosystem
 * 
 * Provides fallbacks for:
 * - localStorage with error handling
 * - Modern JS methods (Object.fromEntries, Array.at, String.replaceAll)
 * - Standardized date parsing
 * - Utility functions for cross-browser compatibility
 */

// ============================================================================
// CLOUD-BACKED STORAGE LAYER
// ============================================================================
// RULE: NO business data is ever stored in browser localStorage.
//       All business data lives in Supabase (cloud) only.
//
// This script:
//   1. Synchronously loads all KV data from Supabase at page-load.
//   2. Provides window.safeLocalStorage (cloud-backed).
//   3. Monkey-patches native localStorage.* so ANY direct call from
//      any page script is also routed through cloud — no exceptions.
//   4. Auth / session / UI preference keys stay in native localStorage.
//
// KV endpoint: /api/payroll/kv
// ============================================================================

(function () {
    'use strict';

    if (window.__cloudStorageInstalled) return;
    window.__cloudStorageInstalled = true;

    var KV = '/api/payroll/kv';

    // ── Save native localStorage references FIRST ────────────────────────────
    // We MUST do this before any monkey-patching to avoid recursive calls.
    var _nGet = Storage.prototype.getItem.bind(localStorage);
    var _nSet = Storage.prototype.setItem.bind(localStorage);
    var _nDel = Storage.prototype.removeItem.bind(localStorage);

    // Keys that STAY in native browser localStorage (auth / session / UI only).
    // EVERYTHING else goes to Supabase. No exceptions.
    var LOCAL_KEYS = {
        token:1, paytime_token:1, sean_token:1, auth_token:1, eco_token:1,
        session:1, user:1, sean_user:1, current_user:1,
        eco_user:1, eco_companies:1, eco_company_name:1, eco_super_admin:1,
        sso_source:1, activeCompanyId:1, selectedCompanyId:1, company:1,
        eco_client_id:1, demoMode:1, isSuperAdmin:1,
        coaching_app_current_user:1, coaching_app_admin_mode:1
    };
    var LOCAL_PFX = ['theme','darkMode','dark_','sidebar',
                     'viewMode','language','lang_','_lastVisit','cache_',
                     'seanAI','notif'];

    function _isLocal(k) {
        if (LOCAL_KEYS[k]) return true;
        for (var i = 0; i < LOCAL_PFX.length; i++)
            if (k.indexOf(LOCAL_PFX[i]) === 0) return true;
        return false;
    }

    var _cache  = {};
    var _online = false;

    // Use native refs so _tok never triggers monkey-patched recursion
    function _tok() {
        try {
            return _nGet('token') || _nGet('paytime_token') ||
                   _nGet('sean_token') || '';
        } catch(e) { return ''; }
    }

    // ── Synchronous preload ───────────────────────────────────────────────────
    // Runs once at page-load. Blocks until server responds so _cache is
    // populated before any page script accesses data.
    (function _preload() {
        try {
            var tok = _tok();
            if (!tok) return;                 // not yet logged in (login page)
            var xhr = new XMLHttpRequest();
            xhr.open('GET', KV, false);       // false = synchronous
            xhr.setRequestHeader('Content-Type',  'application/json');
            xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
            xhr.send(null);
            if (xhr.status === 200) {
                _cache  = JSON.parse(xhr.responseText) || {};
                _online = true;
                console.log(
                    '%c\u2601\ufe0f  Paytime PAYROLL \u2014 all data in Supabase (zero local storage)',
                    'color:#667eea;font-weight:bold;'
                );
            } else if (xhr.status === 401) {
                // Expired token — clear it (use native refs to avoid recursion)
                try { _nDel('token');   } catch(e) {}
                try { _nDel('session'); } catch(e) {}
            }
        } catch(e) {
            console.warn('\u26a0\ufe0f  Cloud storage preload failed (Paytime PAYROLL):', e.message);
        }
    }());

    function _cloudSet(key, val) {
        if (!_online) return;
        try {
            var x = new XMLHttpRequest();
            x.open('PUT', KV + '/' + encodeURIComponent(key), true);
            x.setRequestHeader('Content-Type', 'application/json');
            var t = _tok();
            if (t) x.setRequestHeader('Authorization', 'Bearer ' + t);
            x.send(JSON.stringify({ value: val }));
        } catch(e) { console.warn('Cloud write failed:', key, e.message); }
    }

    function _cloudDel(key) {
        if (!_online) return;
        try {
            var x = new XMLHttpRequest();
            x.open('DELETE', KV + '/' + encodeURIComponent(key), true);
            var t = _tok();
            if (t) x.setRequestHeader('Authorization', 'Bearer ' + t);
            x.send();
        } catch(e) {}
    }

    // ── safeLocalStorage (public API) ─────────────────────────────────────────
    window.safeLocalStorage = {

        setItem: function (key, value) {
            if (_isLocal(key)) {
                try { _nSet(key, value); } catch(e) {}  // use native ref
                return true;
            }
            var parsed;
            try { parsed = (typeof value === 'string') ? JSON.parse(value) : value; }
            catch(e) { parsed = value; }
            _cache[key] = parsed;
            _cloudSet(key, parsed);
            return true;
        },

        getItem: function (key) {
            if (_isLocal(key)) {
                try { return _nGet(key); } catch(e) { return null; } // native ref
            }
            if (!Object.prototype.hasOwnProperty.call(_cache, key)) return null;
            var v = _cache[key];
            if (v === null || v === undefined) return null;
            if (typeof v === 'string') return v;
            return JSON.stringify(v);
        },

        removeItem: function (key) {
            if (_isLocal(key)) {
                try { _nDel(key); } catch(e) {}  // native ref
                return true;
            }
            delete _cache[key];
            _cloudDel(key);
            return true;
        },

        clear: function () {
            Object.keys(LOCAL_KEYS).forEach(function (k) {
                try { _nDel(k); } catch(e) {}  // native ref
            });
            _cache = {};
        },

        // Reload all company data from cloud (use after switching companies)
        reload: function () {
            return new Promise(function (resolve) {
                var tok = _tok();
                if (!tok) { resolve(); return; }
                var x = new XMLHttpRequest();
                x.open('GET', KV, true);
                x.setRequestHeader('Authorization', 'Bearer ' + tok);
                x.onload = function () {
                    if (x.status === 200) {
                        try { _cache = JSON.parse(x.responseText) || {}; _online = true; }
                        catch(e) {}
                    }
                    resolve();
                };
                x.onerror = function () { resolve(); };
                x.send();
            });
        },

        cleanup:            function () {},
        getUsageInfo:       function () {
            return { keys: Object.keys(_cache).length, percentage: 0,
                     available: true, cloudBacked: _online };
        },
        _checkAvailability: function () { return true; },
        _serverOnline:      function () { return _online; },

        // ── Enumeration (needed by PayrollEngine.getHistoricalPeriods) ────────
        // safeLocalStorage stores payroll data in _cache (cloud-backed).
        // .length and .key(i) allow code written for native localStorage iteration
        // to work transparently over the cloud-backed cache.
        key: function (i) {
            var keys = Object.keys(_cache);
            return (i >= 0 && i < keys.length) ? keys[i] : null;
        }
    };

    // Expose .length as a live getter over _cache keys
    Object.defineProperty(window.safeLocalStorage, 'length', {
        get: function () { return Object.keys(_cache).length; },
        configurable: true
    });

    // ── Monkey-patch native localStorage ─────────────────────────────────────
    // Intercepts ALL direct localStorage.getItem / setItem / removeItem calls
    // made anywhere on the page and routes them through safeLocalStorage.
    // This is the catch-all: pages that call localStorage.* directly are
    // also protected — nothing touches native browser localStorage except
    // auth/session keys.
    try {
        localStorage.getItem    = function(k) { return window.safeLocalStorage.getItem(k); };
        localStorage.setItem    = function(k, v) { window.safeLocalStorage.setItem(k, v); };
        localStorage.removeItem = function(k) { window.safeLocalStorage.removeItem(k); };
        console.log('%c\ud83d\udd12 localStorage intercepted \u2014 all writes go to Supabase',
                    'color:#48bb78;');
    } catch(e) {
        // Some browsers make localStorage properties read-only — that's fine,
        // pages should use window.safeLocalStorage explicitly in that case.
        console.warn('localStorage interception failed (read-only):', e.message);
    }

}());

// ============================================================================
// DATE HANDLING UTILITIES
// ============================================================================

/**
 * Parse date string in standardized way (avoids browser inconsistencies)
 * @param {string|Date} dateStr - Date string in YYYY-MM-DD or ISO 8601 format
 * @returns {Date|null}
 */
window.parseStandardDate = function(dateStr) {
    if (!dateStr) return null;
    
    // Already a Date object
    if (dateStr instanceof Date) {
        return isNaN(dateStr.getTime()) ? null : dateStr;
    }
    
    // Handle ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)
    if (typeof dateStr === 'string') {
        // Remove time component if present
        var cleanStr = dateStr.split('T')[0];
        var parts = cleanStr.split('-');
        
        if (parts.length === 3) {
            var year = parseInt(parts[0], 10);
            var month = parseInt(parts[1], 10) - 1;  // Month is 0-indexed
            var day = parseInt(parts[2], 10);
            
            // Validate ranges
            if (year < 1900 || year > 2100) {
                console.warn('Invalid year:', year);
                return null;
            }
            if (month < 0 || month > 11) {
                console.warn('Invalid month:', month);
                return null;
            }
            if (day < 1 || day > 31) {
                console.warn('Invalid day:', day);
                return null;
            }
            
            return new Date(year, month, day);
        }
        
        // Try DD/MM/YYYY format
        var slashParts = cleanStr.split('/');
        if (slashParts.length === 3) {
            var day2 = parseInt(slashParts[0], 10);
            var month2 = parseInt(slashParts[1], 10) - 1;
            var year2 = parseInt(slashParts[2], 10);
            return new Date(year2, month2, day2);
        }
    }
    
    // Fallback to native parsing (risky)
    console.warn('Non-standard date format, using native parsing:', dateStr);
    var date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
};

/**
 * Format date consistently across browsers
 * @param {Date|string} date - Date object or string
 * @param {string} format - 'ISO', 'ZA', 'US', 'UK'
 * @returns {string}
 */
window.formatDate = function(date, format) {
    if (!date) return '';
    
    // Parse if string
    if (!(date instanceof Date)) {
        date = window.parseStandardDate(date);
    }
    
    if (!date || isNaN(date.getTime())) return '';
    
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    
    switch(format) {
        case 'ISO':
            return year + '-' + month + '-' + day;
        case 'ZA':  // DD/MM/YYYY
            return day + '/' + month + '/' + year;
        case 'US':  // MM/DD/YYYY
            return month + '/' + day + '/' + year;
        case 'UK':  // DD-MM-YYYY
            return day + '-' + month + '-' + year;
        default:
            return day + '/' + month + '/' + year;  // Default to ZA format
    }
};

/**
 * Format date with time
 * @param {Date|string} date
 * @returns {string}
 */
window.formatDateTime = function(date) {
    if (!date) return '';
    if (!(date instanceof Date)) {
        date = window.parseStandardDate(date);
    }
    if (!date || isNaN(date.getTime())) return '';
    
    var dateStr = window.formatDate(date, 'ZA');
    var hours = String(date.getHours()).padStart(2, '0');
    var minutes = String(date.getMinutes()).padStart(2, '0');
    
    return dateStr + ' ' + hours + ':' + minutes;
};

/**
 * Get current date in ISO format (for storage)
 * @returns {string} YYYY-MM-DD
 */
window.getTodayISO = function() {
    var now = new Date();
    return window.formatDate(now, 'ISO');
};

/**
 * Format time only (HH:MM)
 * @param {Date|string} date
 * @returns {string} HH:MM
 */
window.formatTime = function(date) {
    if (!date) return '';
    if (!(date instanceof Date)) {
        date = window.parseStandardDate(date);
    }
    if (!date || isNaN(date.getTime())) return '';
    
    var hours = String(date.getHours()).padStart(2, '0');
    var minutes = String(date.getMinutes()).padStart(2, '0');
    return hours + ':' + minutes;
};

/**
 * Format date as "DD Mon YYYY" (e.g., "10 Mar 2026")
 * Safe cross-browser replacement for:
 *   toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
 * Uses a hardcoded month table — no browser locale engine required.
 * @param {Date|string} date
 * @returns {string} e.g. "10 Mar 2026"
 */
window.formatDateDisplay = function(date) {
    if (!date) return '';
    if (!(date instanceof Date)) {
        date = window.parseStandardDate(date);
    }
    if (!date || isNaN(date.getTime())) return '';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var day = String(date.getDate()).padStart(2, '0');
    var month = months[date.getMonth()];
    var year = date.getFullYear();
    return day + ' ' + month + ' ' + year;
};

// ============================================================================
// JAVASCRIPT POLYFILLS
// ============================================================================

/**
 * Object.fromEntries polyfill (ES2019)
 * Browser support: Chrome 73+, Edge 79+, Firefox 63+, Safari 12.1+ (March 2019)
 */
if (!Object.fromEntries) {
    Object.fromEntries = function(entries) {
        if (!entries || !entries[Symbol.iterator]) {
            throw new Error('Object.fromEntries requires an iterable');
        }
        
        var obj = {};
        for (var pair of entries) {
            if (Object(pair) !== pair) {
                throw new TypeError('iterable for fromEntries should yield objects');
            }
            var key = pair[0];
            var value = pair[1];
            Object.defineProperty(obj, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: value
            });
        }
        return obj;
    };
}

/**
 * Array.prototype.at polyfill (ES2022)
 * Browser support: Chrome 92+, Edge 92+, Firefox 90+, Safari 15.4+ (early 2022)
 */
if (!Array.prototype.at) {
    Array.prototype.at = function(index) {
        var len = this.length;
        
        // Convert negative index to positive
        var relativeIndex = index >= 0 ? index : len + index;
        
        // Out of bounds
        if (relativeIndex < 0 || relativeIndex >= len) {
            return undefined;
        }
        
        return this[relativeIndex];
    };
}

/**
 * String.prototype.replaceAll polyfill (ES2021)
 * Browser support: Chrome 85+, Edge 85+, Firefox 77+, Safari 13.1+ (mid-2020)
 */
if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function(search, replacement) {
        if (search instanceof RegExp) {
            if (!search.global) {
                throw new TypeError('String.prototype.replaceAll called with a non-global RegExp');
            }
            return this.replace(search, replacement);
        }
        
        // String search - split and join is safer than regex
        return this.split(search).join(replacement);
    };
}

/**
 * Array.prototype.flat polyfill (ES2019)
 * Browser support: Chrome 69+, Edge 79+, Firefox 62+, Safari 12+ (Sept 2018)
 */
if (!Array.prototype.flat) {
    Array.prototype.flat = function(depth) {
        var flattened = [];
        var maxDepth = depth === undefined ? 1 : Math.floor(depth);
        
        (function flatten(arr, currentDepth) {
            for (var i = 0; i < arr.length; i++) {
                if (Array.isArray(arr[i]) && currentDepth < maxDepth) {
                    flatten(arr[i], currentDepth + 1);
                } else {
                    flattened.push(arr[i]);
                }
            }
        })(this, 0);
        
        return flattened;
    };
}

/**
 * Array.prototype.flatMap polyfill (ES2019)
 */
if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function(callback, thisArg) {
        return this.map(callback, thisArg).flat(1);
    };
}

/**
 * Promise.allSettled polyfill (ES2020)
 * Browser support: Chrome 76+, Edge 79+, Firefox 71+, Safari 13+ (2019-2020)
 */
if (!Promise.allSettled) {
    Promise.allSettled = function(promises) {
        return Promise.all(
            promises.map(function(promise) {
                return Promise.resolve(promise).then(
                    function(value) {
                        return { status: 'fulfilled', value: value };
                    },
                    function(reason) {
                        return { status: 'rejected', reason: reason };
                    }
                );
            })
        );
    };
}

// ============================================================================
// FETCH API CHECK
// ============================================================================

/**
 * Warn if Fetch API is not available
 * Fetch support: Chrome 42+, Edge 14+, Firefox 39+, Safari 10.1+, NO IE11
 */
if (!window.fetch) {
    console.warn('⚠️  Fetch API not supported. Using XMLHttpRequest fallback or add fetch polyfill.');
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format currency consistently
 * @param {number} amount
 * @param {string} currency - 'ZAR', 'USD', etc.
 * @returns {string}
 */
window.formatMoney = function(amount, currency) {
    if (amount === null || amount === undefined || isNaN(amount)) {
        return 'R 0.00';  // Default for ZA
    }
    
    currency = currency || 'ZAR';
    var symbol = currency === 'ZAR' ? 'R ' : '$';
    
    // Format with proper thousands separator and 2 decimals
    var formatted = Math.abs(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    
    return (amount < 0 ? '-' : '') + symbol + formatted;
};

/**
 * Debounce function (useful for search inputs, resize handlers)
 * @param {Function} func
 * @param {number} wait - milliseconds
 * @returns {Function}
 */
window.debounce = function(func, wait) {
    var timeout;
    return function executedFunction() {
        var context = this;
        var args = arguments;
        var later = function() {
            timeout = null;
            func.apply(context, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

/**
 * Feature detection helper
 * @param {string} feature - 'localStorage', 'fetch', 'IntersectionObserver', etc.
 * @returns {boolean}
 */
window.hasFeature = function(feature) {
    switch(feature) {
        case 'localStorage':
            return window.storageAvailable('localStorage');
        case 'sessionStorage':
            return window.storageAvailable('sessionStorage');
        case 'fetch':
            return typeof window.fetch === 'function';
        case 'IntersectionObserver':
            return 'IntersectionObserver' in window;
        case 'ResizeObserver':
            return 'ResizeObserver' in window;
        case 'Intl':
            return typeof Intl !== 'undefined';
        case 'Promise':
            return typeof Promise !== 'undefined';
        default:
            return false;
    }
};

// ============================================================================
// INITIALIZATION
// ============================================================================

(function() {
    console.log('✅ Browser compatibility polyfills loaded');
    
    // Check critical features
    var warnings = [];
    
    if (!window.hasFeature('localStorage')) {
        warnings.push('localStorage not available - using memory fallback');
    }
    
    if (!window.hasFeature('fetch')) {
        warnings.push('Fetch API not supported - use XMLHttpRequest or polyfill');
    }
    
    if (warnings.length > 0) {
        console.warn('⚠️  Browser compatibility warnings:', warnings);
    }
    
    // Check localStorage usage
    if (window.hasFeature('localStorage')) {
        var usage = window.safeLocalStorage.getUsageInfo();
        if (usage.percentage > 80) {
            console.warn('⚠️  localStorage usage is at ' + usage.percentage + '% - consider cleanup');
        }
    }
})();
