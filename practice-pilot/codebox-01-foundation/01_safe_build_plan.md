# LORENCO PRACTICE — SAFE BUILD PLAN
# Codebox 02: Frontend Build-Out

> Date: May 2026
> Prerequisite: Codebox 01 (Foundation Audit) — COMPLETE

---

## 1. Build Goal

Transform the single-file `frontend-practice/index.html` placeholder into a full multi-page Practice Management application, matching the quality and architectural standards of Lorenco Paytime and Lorenco Accounting.

**Non-goals for this codebox:**
- No billing/invoicing engine
- No document upload
- No Sean AI integration
- No changes to the backend (backend is already complete)
- No changes to any other app in the ecosystem

---

## 2. Proposed App Architecture

```
frontend-practice/
├── index.html               Dashboard (stats + overview)
├── clients.html             Client list + add/edit
├── client.html              Single client profile + tasks + time + deadlines
├── tasks.html               Task board (kanban or table view)
├── time.html                Time tracker + entry log
├── deadlines.html           Deadline list + calendar strip
├── js/
│   ├── auth.js              (already exists — keep, do not modify)
│   └── polyfills.js         (ADD — copy from frontend-payroll, update KV prefix)
├── css/
│   └── practice.css         (EXTRACT from index.html — shared styles)
├── lorenco-logo-cropped.png
└── lorenco-logo-exact-reference.png
```

**Routing:** All pages are static HTML served at `/practice`. Deep-links like `/practice/clients` resolve to `index.html` (catch-all in server.js), so each page loads independently via `window.location.pathname`.

---

## 3. Frontend Structure

### Page: `index.html` (Dashboard)
- Auth guard: if no token → redirect to ecosystem dashboard
- Stats grid: Total Clients, Open Tasks, Overdue Tasks, Upcoming Deadlines (30 days), Hours This Month
- Recent activity: last 5 tasks modified, last 5 deadlines due soon
- Quick-add buttons: + Client, + Task, + Deadline
- Navigation links to each sub-page

### Page: `clients.html` (Client List)
- Search bar (client name, email)
- Filter: Active / Inactive
- Table: Name, Email, Phone, Industry, VAT Number, Fiscal Year End, Active/Inactive badge, Actions
- Add Client modal (all fields from `practice_clients` schema)
- Edit Client: inline or modal
- Click row → navigate to `client.html?id=X`
- Pagination (server-side, 50 per page)

### Page: `client.html` (Client Profile)
- Header: client name, email, phone, industry, VAT, reg number, fiscal year end
- Edit button → edit modal
- Tabs: Tasks | Time Entries | Deadlines
- Tasks tab: filtered task list for this client + add task
- Time tab: time entries for this client + totals
- Deadlines tab: upcoming + past deadlines for this client

### Page: `tasks.html` (Task Board)
- View toggle: Table | Kanban board
- Filters: Client, Status, Priority, Type, Assigned To, Due Date range
- Table columns: Title, Client, Type, Priority, Status, Due Date, Assigned To, Actions
- Quick status change: dropdown or drag (kanban)
- Add Task modal: title, client (dropdown), type, priority, due_date, assigned_to (user picker), description, notes
- Edit/Delete task

### Page: `time.html` (Time Tracker)
- Date range filter (default: current month)
- Client filter
- Log Time form: client, task (optional), date, hours, description, billable toggle, rate
- Table: Date, Client, Task, Hours, Billable, Rate, Description, Actions
- Summary bar: total hours, billable hours, non-billable hours, total value
- Edit/Delete time entries

### Page: `deadlines.html` (Deadlines)
- Month strip calendar showing deadlines by due date
- Filter: Status (pending / submitted / completed / missed), Client, Type
- Table: Title, Client, Type, Due Date, Status, Notes, Actions
- Status badge colour: pending=yellow, submitted=blue, completed=green, missed=red
- Add Deadline: title, client, type (full SARS/CIPC type list), due_date, notes
- Status update: one-click → submitted / completed / missed

---

## 4. Backend Structure

**No backend changes required for Codebox 02.**

The backend is fully implemented with all CRUD endpoints. The only addition needed is the KV endpoint for polyfills.js:

### ADD: `/api/practice/kv` (lightweight — 10 lines)

```javascript
// GET /api/practice/kv/:key
router.get('/kv/:key', async (req, res) => {
  const { data } = await supabase
    .from('payroll_kv_store_eco')
    .select('value')
    .eq('key', `practice_${req.companyId}_${req.params.key}`)
    .single();
  res.json({ value: data?.value ?? null });
});

// PUT /api/practice/kv/:key
router.put('/kv/:key', async (req, res) => {
  await supabase.from('payroll_kv_store_eco').upsert({
    key: `practice_${req.companyId}_${req.params.key}`,
    value: req.body.value
  }, { onConflict: 'key' });
  res.json({ success: true });
});
```

This reuses the existing `payroll_kv_store_eco` Supabase table (already deployed) with a `practice_` prefix for isolation.

---

## 5. Database Structure Needed Later

**No new migrations required for Codebox 02.**

Existing 4 tables (`practice_clients`, `practice_tasks`, `practice_time_entries`, `practice_deadlines`) cover all Codebox 02 requirements.

**Potential future additions (Codebox 03+):**

```sql
-- Billing / invoicing (Codebox 03)
CREATE TABLE IF NOT EXISTS practice_invoices (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  client_id   INTEGER REFERENCES practice_clients(id),
  invoice_number TEXT,
  issue_date  DATE,
  due_date    DATE,
  status      TEXT CHECK (status IN ('draft','sent','paid','overdue')),
  total_hours NUMERIC(8,2),
  total_amount NUMERIC(14,2),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 6. Auth / Tenant Rules

| Rule | Implementation |
|---|---|
| All pages must check for valid token on load | `if (!AUTH.getToken()) window.location.href = '/';` |
| All API calls must include Bearer token | `headers: { 'Authorization': 'Bearer ' + AUTH.getToken() }` |
| Company context comes from JWT only | Never read `companyId` from URL params or form fields |
| `companyId` in JWT set at dashboard SSO launch | Dashboard → `select-company` → embedded in JWT |
| Token expiry: 8h | On 401 from API → redirect to dashboard |

**Auth guard (add to every page `<script>` block, line 1 of init):**

```javascript
(function() {
  if (!AUTH || !AUTH.getToken()) {
    window.location.href = '/';
  }
})();
```

---

## 7. Access Control Rules

| Check | Where enforced |
|---|---|
| `MODULE_PRACTICE_ENABLED=true` | Backend env var — routes not registered if false |
| `practice` in company's `modules_enabled` | `requireModule('practice')` middleware — returns 403 |
| User must have valid JWT with `companyId` | `authenticateToken` middleware — returns 401 |
| User can only see their company's data | All backend queries filter by `req.companyId` |
| No role-based restrictions yet | All practice users see all practice data for their company |

**Future access control (Codebox 03):**
- `assigned_to` filter so staff see only tasks assigned to them
- Manager role can see all; staff see their own time entries only

---

## 8. No-localStorage Enforcement

### Rule (CLAUDE.md Part D — absolute)

Business data MUST NOT be written to `localStorage`, `sessionStorage`, `IndexedDB`, or `safeLocalStorage` KV bridge.

### What IS allowed in Practice localStorage

| Key | Purpose | Allowed |
|---|---|---|
| `token` | JWT auth token | ✅ Yes |
| `user` | User object (name, id) | ✅ Yes |
| `company` | Selected company (id, name) | ✅ Yes |
| `sso_source` | SSO bridge from dashboard | ✅ Yes |

### What MUST go to API

| Data | Route |
|---|---|
| Client records | `/api/practice/clients` |
| Tasks | `/api/practice/tasks` |
| Time entries | `/api/practice/time-entries` |
| Deadlines | `/api/practice/deadlines` |
| UI preferences (sort order, last tab) | `/api/practice/kv/:key` via safeLocalStorage |

### Implementation

Add `polyfills.js` as first `<script>` in every page:

```html
<script src="/practice/js/polyfills.js"></script>
<script src="/practice/js/auth.js"></script>
```

`polyfills.js` configuration for Practice:
```javascript
const KV_ENDPOINT = '/api/practice/kv';
const ALLOWED_LOCAL_KEYS = ['token', 'user', 'company', 'sso_source', 'practice_token'];
```

---

## 9. Deployment Considerations

### Zeabur Rules (CLAUDE.md Part C — permanent)

- `accounting-ecosystem/zbpack.json` must NOT exist
- `accounting-ecosystem/Dockerfile` is the build source
- `WORKDIR /app` — `frontend-practice/` is inside the Docker context
- `COPY . .` in Dockerfile already picks up new `frontend-practice/` files automatically
- No Dockerfile changes needed for Codebox 02

### Environment Variables Required

```
MODULE_PRACTICE_ENABLED=true
```

Set in Zeabur service environment. Already required for backend routes — no new variables needed.

### Serving

```javascript
// server.js lines 538-540 (existing — no changes needed)
app.use('/practice', express.static(practiceFrontendPath));
app.get('/practice/*', (req, res) => {
  res.sendFile(path.join(practiceFrontendPath, 'index.html'));
});
```

All new HTML pages placed in `frontend-practice/` are automatically served. No server changes needed.

---

## 10. Testing Strategy

### Pre-commit checks (each page)

1. **Auth guard**: Access page directly without token → should redirect to `/`
2. **401 recovery**: Expire token manually → should redirect on first failed API call
3. **CRUD smoke test**: Create, read, update, delete each entity type
4. **Company isolation**: Verify all data is scoped to logged-in company's `companyId`
5. **No localStorage business data**: Open DevTools → Application → Local Storage → confirm only token/user/company keys

### Regression tests to run after each Codebox 02 build

- [ ] Ecosystem dashboard still loads and all other app tiles work
- [ ] Paytime still loads and payroll calculations still work
- [ ] Accounting still loads
- [ ] POS still loads
- [ ] Inventory still loads
- [ ] Practice tile on dashboard navigates to `/practice`
- [ ] Auth guard redirects unauthenticated users

### Automated scan

Run `scripts/test_inventory_no_local_storage.mjs` pattern adapted for Practice:
- Scan `frontend-practice/` for `localStorage.setItem`, `sessionStorage.setItem`
- Whitelist: `token`, `user`, `company`, `sso_source`
- Fail on any other key

---

## 11. Codebox Sequence Recommendation

| Codebox | Goal | Scope |
|---|---|---|
| **01** ✅ | Foundation audit + safe build plan | Docs only (this document) |
| **02** | Frontend build-out | Multi-page app, auth guard, polyfills, user picker, pagination |
| **03** | Reporting + billing | Time summary report, deadline PDF, invoice generation |
| **04** | Document management | Client document upload/storage, compliance checklists |
| **05** | Sean AI integration | Query practice data via Sean (deadlines, overdue tasks, time summary) |

**Next immediate action:** Codebox 02 — start with auth guard + polyfills.js + clients.html.
