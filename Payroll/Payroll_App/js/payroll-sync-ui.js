/**
 * ============================================================================
 * Payroll Employee Sync — Frontend Component
 * ============================================================================
 * Detects unsynced employees and provides sync button.
 * Integrates into employee management page.
 *
 * Features:
 *   - Detects unsynced employees on page load
 *   - Shows clear message if unsynced found
 *   - "Sync Missing Employees" button
 *   - Success/error feedback
 *   - Auto-refresh list after successful sync
 *   - Per-company isolation
 *
 * Usage:
 *   <script src="payroll-sync-ui.js"></script>
 *
 *   // Initialize when page loads
 *   document.addEventListener('DOMContentLoaded', () => {
 *     PayrollSyncUI.init({
 *       containerId: 'sync-banner',
 *       companyId: currentCompanyId,
 *       onSyncComplete: () => location.reload()
 *     });
 *   });
 * ============================================================================
 */

(function() {
  'use strict';

  window.PayrollSyncUI = {

    /**
     * Initialize sync UI
     *
     * Options:
     *   - containerId: ID of element to insert banner into
     *   - companyId: Active company ID (required)
     *   - onSyncComplete: Callback after successful sync
     *   - onError: Callback for errors
     */
    init: function(options) {
      const opts = options || {};
      this.companyId = opts.companyId;
      this.onSyncComplete = opts.onSyncComplete || (() => { location.reload(); });
      this.onError = opts.onError || console.error;

      if (!this.companyId) {
        console.warn('PayrollSyncUI: companyId required');
        return;
      }

      this.detectUnsynced();
    },

    /**
     * Detect unsynced employees
     */
    detectUnsynced: async function() {
      try {
        const response = await fetch(
          `/api/payroll/sync/detect?companyId=${this.companyId}`,
          { method: 'GET' }
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        if (data.unsyncedCount > 0) {
          this.showSyncBanner(data.employees);
        }

      } catch (err) {
        console.error('PayrollSyncUI: Detection error', err);
        this.onError(err);
      }
    },

    /**
     * Show banner with unsynced employees and sync button
     */
    showSyncBanner: function(employees) {
      // Create banner HTML
      const banner = document.createElement('div');
      banner.className = 'payroll-sync-banner';
      banner.innerHTML = `
        <div style="padding: 20px; background: #f0f4ff; border: 2px solid #667eea; border-radius: 12px; margin-bottom: 20px;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 20px;">
            <div style="flex: 1;">
              <div style="font-weight: 600; color: #667eea; font-size: 1rem; margin-bottom: 8px;">
                ℹ️ Employees Not Yet in Master List
              </div>
              <p style="color: #555; margin: 0 0 12px; font-size: 0.9rem; line-height: 1.5;">
                <strong>${employees.length} employee(s)</strong> found in payroll records but not yet in the Employees master list.
                You can sync them automatically—no need to manually re-add them!
              </p>
              <div style="padding: 12px; background: white; border-radius: 6px; font-size: 0.85rem; color: #666; margin-top: 10px;">
                <strong>Employees to sync:</strong>
                <ul style="list-style: none; padding-left: 0; margin: 8px 0 0;">
                  ${employees.map(e => `<li style="margin: 4px 0;">• ${e.name}${e.payrollNumber ? ` (${e.payrollNumber})` : ''}</li>`).join('')}
                </ul>
              </div>
            </div>
            <div style="flex-shrink: 0;">
              <button id="payroll-sync-btn" class="btn-sync" style="padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background 0.2s;">
                🔄 Sync Now
              </button>
            </div>
          </div>
          <div id="sync-status" style="margin-top: 12px; padding: 10px; border-radius: 6px; display: none; font-size: 0.9rem;"></div>
        </div>
      `;

      // Insert into page (if container exists, use it; otherwise prepend to main content)
      const container = document.getElementById(opts.containerId || 'sync-container')
        || document.querySelector('.main-content')
        || document.querySelector('.content')
        || document.body;

      const firstChild = container.firstChild;
      if (firstChild) {
        container.insertBefore(banner, firstChild);
      } else {
        container.appendChild(banner);
      }

      // Attach sync button event
      const btn = document.getElementById('payroll-sync-btn');
      if (btn) {
        btn.addEventListener('click', () => this.executeSyncWith(employees, banner));
      }

      this.currentBanner = banner;
    },

    /**
     * Execute sync with employees list
     */
    executeSyncWith: async function(employees, banner) {
      const btn = banner.querySelector('#payroll-sync-btn');
      const statusEl = banner.querySelector('#sync-status');

      // Disable button, show loading
      btn.disabled = true;
      btn.textContent = '⏳ Syncing...';
      statusEl.style.display = 'block';
      statusEl.style.background = '#e3f2fd';
      statusEl.style.color = '#0d47a1';
      statusEl.textContent = 'Syncing employees...';

      try {
        const response = await fetch('/api/payroll/sync/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId: this.companyId,
            employees: employees
          })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();

        if (result.success) {
          // Success!
          statusEl.style.background = '#d4edda';
          statusEl.style.color = '#155724';
          statusEl.innerHTML = `
            <strong>✅ Sync complete!</strong>
            <br>${result.created} new employee(s) created, ${result.linked} linked to existing records.
            <br>Page will refresh in 3 seconds...
          `;
          btn.textContent = '✅ SyncdSuccess ';
          btn.disabled = true;

          // Refresh page after 3 seconds
          setTimeout(() => {
            this.onSyncComplete();
          }, 3000);

        } else {
          // Partial failure
          statusEl.style.background = '#fff3cd';
          statusEl.style.color = '#856404';
          statusEl.innerHTML = `
            <strong>⚠ Sync completed with issues:</strong>
            <br>${result.created} created, ${result.linked} linked, ${result.failed.length} failed.
            <br>${result.failed.map(f => `• ${f.emp}: ${f.reason}`).join('<br>')}
          `;
          btn.textContent = '🔄 Retry';
          btn.disabled = false;
        }

      } catch (err) {
        // Error
        statusEl.style.background = '#ffebee';
        statusEl.style.color = '#c62828';
        statusEl.innerHTML = `
          <strong>❌ Sync failed:</strong>
          <br>${err.message}
          <br><small>Check browser console for details.</small>
        `;
        btn.textContent = '🔄 Retry';
        btn.disabled = false;
        this.onError(err);
      }
    }

  };

})();
