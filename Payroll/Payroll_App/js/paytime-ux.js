// ============================================================
// paytime-ux.js — Shared UX Utilities for Lorenco Paytime
// Provides: save toast, sync banner wiring, search filtering
// Used by: employee-detail, employee-management, payruns,
//          payroll-items and any Paytime page.
// ============================================================

// ----------------------------------------------------------
// SAVE / ACTION TOAST
// Shows a non-blocking confirmation at the bottom-right corner.
// Type: 'success' (default) | 'error' | 'warning'
// ----------------------------------------------------------
function showSaveToast(message, type, durationMs) {
    var toast = document.getElementById('pt-save-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'pt-save-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message || 'Saved';
    toast.className = '';
    if (type === 'error') toast.classList.add('error');
    else if (type === 'warning') toast.classList.add('warning');

    // Force reflow so transition fires
    void toast.offsetWidth;
    toast.classList.add('show');

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(function() {
        toast.classList.remove('show');
    }, durationMs || 2500);
}

// ----------------------------------------------------------
// SYNC ERROR BANNER
// Wires the #payrollSyncErrorBanner element (added to each page)
// to show when DataAccess.set() encounters a server 5xx error.
// Call once on DOMContentLoaded.
// ----------------------------------------------------------
function initSyncErrorBanner() {
    var banner = document.getElementById('payrollSyncErrorBanner');
    if (!banner) return;

    // Wire the dismiss button if present
    var dismissBtn = banner.querySelector('.pt-sync-dismiss');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', function() {
            banner.style.display = 'none';
        });
    }

    // Poll the write-error flag set by DataAccess.set() on 5xx
    // Check once after a short delay (gives async writes time to fail)
    setTimeout(function checkWriteError() {
        if (window._payrollWriteError) {
            banner.style.display = 'flex';
            banner.classList.add('show');
        }
    }, 3000);
}

// ----------------------------------------------------------
// LIVE EMPLOYEE TABLE SEARCH
// Filters an <tbody id="employee-list"> table by name or
// employee number. Updates a counter element if present.
//
// Usage:
//   initEmployeeSearch('empSearchInput', 'employee-list', 'empSearchCount');
// ----------------------------------------------------------
function initEmployeeSearch(inputId, tbodyId, countId) {
    var input = document.getElementById(inputId);
    var tbody = document.getElementById(tbodyId);
    var counter = countId ? document.getElementById(countId) : null;
    if (!input || !tbody) return;

    function doFilter() {
        var q = input.value.trim().toLowerCase();
        var rows = tbody.querySelectorAll('tr');
        var visible = 0;
        rows.forEach(function(row) {
            if (row.cells.length < 2) { return; } // header or empty-state row
            var empNum  = (row.cells[0] ? row.cells[0].textContent : '').toLowerCase();
            var empName = (row.cells[1] ? row.cells[1].textContent : '').toLowerCase();
            var idNum   = (row.cells[2] ? row.cells[2].textContent : '').toLowerCase();
            var matches = !q || empNum.indexOf(q) !== -1 || empName.indexOf(q) !== -1 || idNum.indexOf(q) !== -1;
            row.style.display = matches ? '' : 'none';
            if (matches) visible++;
        });
        if (counter) {
            var total = Array.from(rows).filter(function(r) { return r.cells.length >= 2; }).length;
            counter.textContent = q ? (visible + ' of ' + total) : (total + ' employees');
        }
    }

    input.addEventListener('input', doFilter);
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            input.value = '';
            doFilter();
        }
    });
    // Run once to set initial counter
    doFilter();
}

// ----------------------------------------------------------
// EMPLOYEE PAYRUN CARD SEARCH
// Filters .employee-card elements by text content.
//
// Usage:
//   initCardSearch('payrunEmpSearchInput', '.employee-card');
// ----------------------------------------------------------
function initCardSearch(inputId, cardSelector) {
    var input = document.getElementById(inputId);
    if (!input) return;

    input.addEventListener('input', function() {
        var q = input.value.trim().toLowerCase();
        var cards = document.querySelectorAll(cardSelector);
        cards.forEach(function(card) {
            var text = card.textContent.toLowerCase();
            card.style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
        });
    });
}

// ----------------------------------------------------------
// PAYROLL ITEM SELECT SEARCH
// Filters <option> elements in a <select> by the text typed
// in a search input. Options that don't match are hidden.
// Call after populating the select each time the modal opens.
//
// Usage:
//   initItemSearch('regularItemSearch', 'regularItemSelect');
// ----------------------------------------------------------
function initItemSearch(inputId, selectId) {
    var input = document.getElementById(inputId);
    var select = document.getElementById(selectId);
    if (!input || !select) return;

    // Store original options for reset
    var allOptions = Array.from(select.options).map(function(opt) {
        return { value: opt.value, text: opt.text };
    });

    // Remove old listener if re-initialized
    if (input._itemSearchHandler) {
        input.removeEventListener('input', input._itemSearchHandler);
    }

    input._itemSearchHandler = function() {
        var q = input.value.trim().toLowerCase();
        // Rebuild options matching query
        select.innerHTML = '';
        var matched = 0;
        allOptions.forEach(function(o) {
            if (!q || o.text.toLowerCase().indexOf(q) !== -1 || o.value === '__custom__') {
                var opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.text;
                select.appendChild(opt);
                matched++;
            }
        });
        // Auto-select first real match when filtered
        if (q && select.options.length > 0) {
            select.selectedIndex = 0;
            // Trigger onchange so item info loads
            select.dispatchEvent(new Event('change'));
        }
    };

    input.addEventListener('input', input._itemSearchHandler);

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            input.value = '';
            input._itemSearchHandler();
        }
    });
}
