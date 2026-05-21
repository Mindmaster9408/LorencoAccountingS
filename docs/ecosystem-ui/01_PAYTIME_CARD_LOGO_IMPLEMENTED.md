# 01 — PAYTIME DASHBOARD CARD LOGO IMPLEMENTED
## ECO Dashboard — Paytime App Card Brand Image

**Date:** 2026-05-21
**Status:** ✅ Implemented

---

## 1. Files Inspected

| File | Purpose |
|---|---|
| `accounting-ecosystem/frontend-ecosystem/dashboard.html` | ECO dashboard — hosts `APP_DEFS` and `renderApps()` |
| `accounting-ecosystem/backend/server.js` | Static serving configuration |
| `accounting-ecosystem/frontend-payroll/assets/branding/paytime/` | Source brand image directory |

---

## 2. Current Source (Before Change)

- Paytime app card used: `icon: '&#128176;'` (money bag emoji)
- Rendered as: `<div class="app-icon">💰</div>`
- `.app-icon` is a 52×52px flex container with a green tinted background (`rgba(16, 185, 129, 0.15)`)

---

## 3. Image Found

**Source path:**
```
accounting-ecosystem/frontend-payroll/assets/branding/paytime/ChatGPT Image May 21, 2026, 07_35_52 PM.png
```

Format: PNG, brand image with transparent background.

---

## 4. Asset Path Decision

**Problem:** `frontend-ecosystem/` is served at `/dashboard/` and `frontend-payroll/` is served at `/payroll/` as separate Express static roots. A relative path from `frontend-ecosystem/dashboard.html` cannot reach `frontend-payroll/assets/`. Cross-directory browser paths would result in 404s.

**Solution:** Copy the image into the ecosystem static root with a clean filename.

**Destination:**
```
accounting-ecosystem/frontend-ecosystem/assets/branding/paytime/paytime-logo.png
```

**Served at runtime as:** `assets/branding/paytime/paytime-logo.png` (relative to dashboard.html)

---

## 5. Changes Made

### `accounting-ecosystem/frontend-ecosystem/dashboard.html`

**A — Added `logo` field to payroll `APP_DEFS` entry (line ~1798):**
```javascript
{
    key: 'payroll',
    name: 'Lorenco Paytime',
    subtitle: 'Payroll Management',
    icon: '&#128176;',
    logo: 'assets/branding/paytime/paytime-logo.png',  // ← added
    desc: 'Full payroll — pay runs, payslips, PAYE/UIF, attendance, leave management.',
    path: '/payroll',
    cssClass: 'payroll',
},
```

The `icon` field is retained as fallback (used by `renderAppsMatrix()` and other non-card contexts).

**B — Updated `renderApps()` app-icon rendering (line ~2149):**
```javascript
// Before:
<div class="app-icon">${app.icon}</div>

// After:
<div class="app-icon">${app.logo
    ? `<img src="${app.logo}" alt="${app.name}" class="app-card-logo-image">`
    : app.icon}</div>
```

Only apps with a `logo` property get the image path. All other cards are unchanged (emoji rendered as before).

**C — Added `.app-card-logo-image` CSS (after `.app-icon` block):**
```css
.app-card-logo-image {
    width: 100%; height: 100%;
    object-fit: contain;
    border-radius: 10px;
    display: block;
}
```

- `object-fit: contain` — preserves aspect ratio, no cropping
- `border-radius: 10px` — slightly inset from the parent container's 14px radius
- `width/height: 100%` — fills the 52×52px `.app-icon` container

### `accounting-ecosystem/frontend-ecosystem/assets/branding/paytime/paytime-logo.png`

New file. Copied from source with a clean filename (no spaces, no timestamp).

---

## 6. What Was NOT Changed

- `icon: '&#128176;'` retained in `APP_DEFS` — used by `renderAppsMatrix()` (admin user matrix) and any other context that reads `app.icon`
- Paytime card routing, auth, `launchApp()` behaviour — unchanged
- All other app cards — unchanged (no `logo` property, emoji rendering path unchanged)
- Backend, payroll engine, any Paytime stability-locked files — not touched
- No browser storage used

---

## 7. Remaining Risks

| Risk | Severity | Notes |
|---|---|---|
| Image fails to load (404) | LOW | Path is within same static root. If image is missing from `frontend-ecosystem/assets/branding/paytime/`, card will show a broken img icon rather than the emoji fallback. Add `onerror` handler if this becomes a concern. |
| Image looks poor at 52×52px | LOW | Source image is large-format PNG. `object-fit: contain` preserves aspect ratio. Visual should be checked after deploy. |
| `.dockerignore` excludes `assets/` | NEGLIGIBLE | `.dockerignore` uses `node_modules` and `.env` exclusions. PNG assets are included in `COPY . .`. |
| `renderAppsMatrix()` still shows emoji | INFORMATIONAL | Expected. Matrix uses `app.icon` not `app.logo`. If branding consistency is required in the matrix view, add logo support there separately. |
