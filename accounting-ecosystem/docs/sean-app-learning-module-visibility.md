# SEAN App — Learning Module Visibility Model

> Implemented: March 2026
> File changed: `frontend-sean/index.html`
> Area: SEAN Transactions tab — Learning Sources panel

---

## CHANGE IMPACT NOTE

- **Area being changed:** SEAN app Transactions tab — which learning modules are visible per selected app
- **Files/services involved:** `frontend-sean/index.html` (UI-only change — no backend changes)
- **Current behaviour identified:** `loadLearningPatterns()` rendered Bank Allocation Patterns for **all apps** regardless of which app was selected. Clicking Paytime or Checkout Charlie showed the heading "🧠 Bank Allocation Patterns — paytime", making it look like Paytime had bank allocation learning. The backend's `getPatterns()` defaulted to `source_app = 'accounting'` so even Paytime's view was showing accounting data.
- **Required behaviours to preserve:** Accounting bank allocation patterns, proposals panel, authorize/reject flow — all unchanged. Only the visibility for Paytime and Checkout Charlie is affected.
- **UX confusion risk:** Showing accounting-native modules under Paytime implies Paytime generates bank allocation data, which is false.
- **Safe implementation plan:** Add `SEAN_MODULE_REGISTRY` config and a `isModuleVisible()` check at the top of `loadLearningPatterns()`. No backend changes needed. Accounting path is untouched.

---

## 1. Why Bank Allocation Patterns Belongs to Accounting (not Paytime or Checkout Charlie)

Bank allocation learning records which GL account a bank transaction was posted to, based on the normalized transaction description. This data comes exclusively from:

- **Accounting** bank transaction imports (PDF/API source)
- **Accounting** bank allocation workflow (allocating transactions to GL accounts)

The `sean_bank_allocation_patterns` table stores `source_app = 'accounting'` for all current records because that is where the raw bank transaction data lives.

**Paytime** processes salary payments, but:
- It does not import bank statements
- It does not do bank transaction GL allocation
- Salary payment **matching** (future) would be a different, Paytime-specific module

**Checkout Charlie** processes POS sales, but:
- It does not import bank statements
- Daily cash reconciliation (future) would be a different, POS-specific module

Showing bank allocation patterns under Paytime or Checkout Charlie was incorrect and misleading.

---

## 2. The App-Specific Learning Module Visibility Model

### Core Principle

> SEAN's global knowledge base is universal — it learns in the background across all apps.
> SEAN's UI modules are app-specific — they are only shown where currently relevant.

### Implementation: `SEAN_MODULE_REGISTRY`

Defined in `frontend-sean/index.html` in the Bank Learning JS section:

```javascript
const SEAN_MODULE_REGISTRY = {
    bank_allocation_patterns: {
        label:       'Bank Allocation Patterns',
        icon:        '🧠',
        description: 'Bank transaction GL allocation learning from accounting data',
        apps:        ['accounting'],  // Only active in Accounting
    },
    // Future modules registered here when built:
    // salary_matching:       { apps: ['paytime'] }
    // pos_category_learning: { apps: ['pos'] }
};
```

### How It Works

When a user clicks an app in "Learning Sources":
1. `selectLearningApp(slug)` sets `_selectedLearningApp` and calls `loadLearningPatterns()`
2. `loadLearningPatterns()` calls `isModuleVisible('bank_allocation_patterns')`
3. `isModuleVisible()` checks `SEAN_MODULE_REGISTRY.bank_allocation_patterns.apps.includes(slug)`
4. If **true** (Accounting): renders the full Bank Allocation Patterns panel as before
5. If **false** (Paytime / Checkout Charlie): renders `renderNoModulePlaceholder(slug)` and hides the filter controls and proposals panel

### Helper Functions

| Function | Purpose |
|---|---|
| `isModuleVisible(moduleKey)` | Returns true if the module is active for `_selectedLearningApp` |
| `appDisplayName(slug)` | Maps slug → display name (e.g. `pos` → `Checkout Charlie`) |
| `renderNoModulePlaceholder(slug)` | Returns contextual HTML explaining why no module is active here |

---

## 3. Global SEAN Knowledge vs App-Specific SEAN UI Modules

| Layer | Scope | Controlled by |
|---|---|---|
| **Backend learning** (event recording, pattern analysis) | Global — fires for any supported source | `bank-learning.js` — always universal |
| **Backend patterns table** | Scoped per `source_app` | `sean_bank_allocation_patterns.source_app` |
| **Frontend module visibility** | Per selected app | `SEAN_MODULE_REGISTRY` in `index.html` |

The backend will continue learning globally and is not affected by frontend visibility rules. This is correct — SEAN builds knowledge across the entire ecosystem, but surfaces it contextually per app.

---

## 4. What Users Now See

### Accounting selected
- Title: `🧠 Bank Allocation Patterns — Accounting`
- Filter controls visible
- Patterns table renders normally
- Proposals panel shows for super admins
- All existing functionality unchanged

### Paytime selected
- Title: `🔮 SEAN — Paytime`
- Filter controls hidden
- Proposals panel hidden
- Placeholder shown:
  > **No Active Learning Modules for Paytime**
  > Bank Allocation Patterns belong to Accounting, where the bank transaction data lives.
  > Paytime IRP5 code learning happens directly inside the Paytime app when payroll items are coded.
  > 🔭 Coming later: Salary payment matching and PAYE reconciliation learning will appear here once that integration is built — as a dedicated Paytime module, not a reuse of accounting logic.

### Checkout Charlie selected
- Title: `🔮 SEAN — Checkout Charlie`
- Filter controls hidden
- Proposals panel hidden
- Placeholder shown:
  > **No Active Learning Modules for Checkout Charlie**
  > SEAN currently has no active learning modules for Checkout Charlie in this view.
  > 🔭 Coming later: POS product category learning and daily reconciliation intelligence will appear here once those modules are built.

---

## 5. How to Add a Future Module

When salary payment matching for Paytime is built:

1. Register the module in `SEAN_MODULE_REGISTRY`:
   ```javascript
   salary_matching: {
       label: 'Salary Payment Matching',
       icon:  '💼',
       apps:  ['paytime'],
   },
   ```
2. In `loadLearningPatterns()` (or a new dedicated function), add a branch:
   ```javascript
   if (isModuleVisible('salary_matching')) {
       // render Paytime salary matching panel
   }
   ```
3. The Paytime placeholder will automatically disappear when a real module is available (because `renderNoModulePlaceholder` is only called when no module is visible).

No other changes needed. The registry is the single point of control.

---

## 6. Future Cross-App Integration Note

```
FOLLOW-UP NOTE
- Area: Paytime — salary payment matching / PAYE reconciliation learning
- What was done: Bank Allocation Patterns hidden from Paytime (correct — it belongs to Accounting)
- Future integration: Accounting bank allocations may inform salary payment matching in Paytime
  (e.g. detecting that a payment matches a payroll run amount, PAYE reconciliation)
- Why NOT built now: The salary matching logic does not yet exist. Showing accounting bank
  allocation patterns in Paytime would expose wrong data from the wrong source.
- Correct approach when ready: Build salary_matching as a NEW module in SEAN_MODULE_REGISTRY
  with apps: ['paytime'], backed by its own backend logic and data model.
  Do NOT reuse the accounting bank_allocation_patterns data for this.
- Risk if built prematurely: Cross-tenant data leakage, wrong GL account suggestions in payroll context
- Recommended next: Build salary_matching module when Paytime payroll run → bank matching flow exists

FOLLOW-UP NOTE
- Area: Checkout Charlie — POS category learning
- What was done: Bank Allocation Patterns hidden from Checkout Charlie (correct)
- Future integration: POS daily totals → cash reconciliation may inform category learning
- Correct approach when ready: Build pos_category_learning as a new module with apps: ['pos']
```

---

## 7. Testing Checklist

**Module Visibility**
- [ ] Navigate to SEAN → Transactions tab → Click "Accounting" → Bank Allocation Patterns panel renders with filter controls and patterns table
- [ ] Click "Paytime" → Panel shows "No Active Learning Modules for Paytime" placeholder, filter controls hidden, proposals card hidden
- [ ] Click "Checkout Charlie" → Panel shows "No Active Learning Modules for Checkout Charlie" placeholder
- [ ] Click back to "Accounting" → Bank Allocation Patterns panel restores with filter controls visible

**Regression**
- [ ] Accounting bank allocation still loads patterns from backend
- [ ] Authorize/Reject proposal flow still works under Accounting
- [ ] Refresh button still works under Accounting
- [ ] Status filter dropdown still works under Accounting
- [ ] Learning Sources navigation still switches correctly between all apps
- [ ] Stats (events, patterns, pending proposals) still load in left sidebar
