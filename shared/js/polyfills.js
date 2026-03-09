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
// LOCALSTORAGE SAFETY WRAPPER
// ============================================================================

/**
 * Check if storage is available and not disabled
 * @param {string} type - 'localStorage' or 'sessionStorage'
 * @returns {boolean}
 */
window.storageAvailable = function(type) {
    try {
        var storage = window[type];
        var x = '__storage_test__';
        storage.setItem(x, x);
        storage.removeItem(x);
        return true;
    } catch(e) {
        return e instanceof DOMException && (
            // everything except Firefox
            e.code === 22 ||
            // Firefox
            e.code === 1014 ||
            // test name field too, because code might not be present
            // everything except Firefox
            e.name === 'QuotaExceededError' ||
            // Firefox
            e.name === 'NS_ERROR_DOM_QUOTA_REACHED') &&
            // acknowledge QuotaExceededError only if there's something already stored
            (storage && storage.length !== 0);
    }
};

/**
 * Safe localStorage wrapper with automatic error handling
 * Gracefully degrades if localStorage is unavailable
 */
window.safeLocalStorage = {
    // In-memory fallback for when localStorage is unavailable
    _memoryStorage: {},
    _useMemory: false,
    
    /**
     * Check if we can use localStorage
     */
    _checkAvailability: function() {
        if (this._useMemory) return false;
        if (!window.storageAvailable('localStorage')) {
            console.warn('localStorage not available - using memory fallback');
            this._useMemory = true;
            return false;
        }
        return true;
    },
    
    /**
     * Set item with error handling
     * @param {string} key
     * @param {string} value
     * @returns {boolean} Success status
     */
    setItem: function(key, value) {
        if (this._useMemory || !this._checkAvailability()) {
            this._memoryStorage[key] = value;
            return true;
        }
        
        try {
            localStorage.setItem(key, value);
            return true;
        } catch(e) {
            console.error('localStorage.setItem failed:', e.name, e.message);
            
            if (e.name === 'QuotaExceededError') {
                console.warn('localStorage quota exceeded - attempting cleanup');
                this.cleanup();
                
                // Try again after cleanup
                try {
                    localStorage.setItem(key, value);
                    return true;
                } catch(e2) {
                    console.error('localStorage still full after cleanup');                    // Fall back to memory
                    this._useMemory = true;
                    this._memoryStorage[key] = value;
                    return false;
                }
            }
            
            // Other error - fall back to memory
            this._useMemory = true;
            this._memoryStorage[key] = value;
            return false;
        }
    },
    
    /**
     * Get item with error handling
     * @param {string} key
     * @returns {string|null}
     */
    getItem: function(key) {
        if (this._useMemory || !this._checkAvailability()) {
            return this._memoryStorage[key] || null;
        }
        
        try {
            return localStorage.getItem(key);
        } catch(e) {
            console.error('localStorage.getItem failed:', e);
            // Fall back to memory
            return this._memoryStorage[key] || null;
        }
    },
    
    /**
     * Remove item with error handling
     * @param {string} key
     * @returns {boolean} Success status
     */
    removeItem: function(key) {
        if (this._useMemory || !this._checkAvailability()) {
            delete this._memoryStorage[key];
            return true;
        }
        
        try {
            localStorage.removeItem(key);
            return true;
        } catch(e) {
            console.error('localStorage.removeItem failed:', e);
            delete this._memoryStorage[key];
            return false;
        }
    },
    
    /**
     * Clear all items
     */
    clear: function() {
        this._memoryStorage = {};
        if (this._checkAvailability()) {
            try {
                localStorage.clear();
            } catch(e) {
                console.error('localStorage.clear failed:', e);
            }
        }
    },
    
    /**
     * Cleanup old/temporary data to free space
     * Removes audit logs older than 30 days and temp data
     */
    cleanup: function() {
        console.log('Running localStorage cleanup...');
        var removed = 0;
        
        try {
            var keys = Object.keys(localStorage);
            var now = Date.now();
            var thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
            
            keys.forEach(function(key) {
                // Remove temp data
                if (key.startsWith('temp_') || key.startsWith('cache_')) {
                    localStorage.removeItem(key);
                    removed++;
                }
                
                // Remove old audit logs (keep last 30 days)
                if (key.startsWith('audit_')) {
                    try {
                        var data = JSON.parse(localStorage.getItem(key));
                        var timestamp = data.timestamp || 0;
                        if (timestamp < thirtyDaysAgo) {
                            localStorage.removeItem(key);
                            removed++;
                        }
                    } catch(e) {
                        // Invalid JSON - remove it
                        localStorage.removeItem(key);
                        removed++;
                    }
                }
            });
            
            console.log('Cleanup complete: removed ' + removed + ' items');
        } catch(e) {
            console.error('Cleanup failed:', e);
        }
    },
    
    /**
     * Get storage usage info
     */
    getUsageInfo: function() {
        if (!this._checkAvailability()) {
            return {
                used: 0,
                available: 0,
                percentage: 0,
                itemCount: Object.keys(this._memoryStorage).length
            };
        }
        
        try {
            var total = 0;
            for (var key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    total += localStorage[key].length + key.length;
                }
            }
            
            // Most browsers limit to 5MB (~5,000,000 characters)
            var limit = 5000000;
            var used = total * 2; // UTF-16 encoding = 2 bytes per character
            var percentage = Math.round((used / limit) * 100);
            
            return {
                used: used,
                available: limit - used,
                percentage: percentage,
                itemCount: localStorage.length
            };
        } catch(e) {
            return { used: 0, available: 0, percentage: 0, itemCount: 0 };
        }
    }
};

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
