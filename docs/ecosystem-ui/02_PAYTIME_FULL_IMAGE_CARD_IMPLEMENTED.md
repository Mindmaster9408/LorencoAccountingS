# 02 — PAYTIME FULL IMAGE CARD IMPLEMENTED
## ECO Dashboard — Paytime App Card Full Image Replacement

**Date:** 2026-05-21
**Status:** ✅ Implemented

---

## 1. Files Inspected

| File | Purpose |
|---|---|
| `accounting-ecosystem/frontend-ecosystem/dashboard.html` | ECO dashboard — `APP_DEFS`, `renderApps()`, CSS |
| `accounting-ecosystem/frontend-payroll/assets/branding/paytime/` | Source brand images |
| `accounting-ecosystem/frontend-ecosystem/assets/branding/paytime/paytime-logo.png` | Ecosystem-safe copy of brand image (from task 01) |

---

## 2. Paytime Card Source Found

- Cards rendered dynamically in `renderApps()` via `APP_DEFS.map(app => ...)` (line ~2134)
- Paytime identified by `app.key === 'payroll'`
- Before this change: rendered same card structure as all other apps (icon, title, desc, status, launch btn)
- `isActive` / `disabled` / access-control logic runs before card HTML is generated — unchanged by this task

---

## 3. Image Asset Found

**Source:** `accounting-ecosystem/frontend-payroll/assets/branding/paytime/ChatGPT Image May 21, 2026, 07_35_52 PM.png` — confirmed `.png`

**Ecosystem-safe copy (from task 01):**
`accounting-ecosystem/frontend-ecosystem/assets/branding/paytime/paytime-logo.png`

Referenced in `APP_DEFS` payroll entry as `logo: 'assets/branding/paytime/paytime-logo.png'`.

---

## 4. Asset Path Decision

Same decision as task 01 — `frontend-ecosystem/` and `frontend-payroll/` are separate Express static roots. The image is referenced from `app.logo` which resolves correctly from within the `frontend-ecosystem/` static scope.

---

## 5. Rendering Changes Made

**`accounting-ecosystem/frontend-ecosystem/dashboard.html` — `renderApps()` (~line 2166):**

Added a branch before the normal card `return`. When `app.key === 'payroll'`, a full-image card is returned instead:

```javascript
if (app.key === 'payroll') {
    return `
        <div class="app-card payroll app-card-image-only ${isActive ? '' : 'disabled'}"
             onclick="${isActive ? `launchApp('${app.key}')` : ''}"
             title="Lorenco Paytime${isActive ? '' : ' — Not Activated'}">
            <img src="${app.logo}" alt="Lorenco Paytime" class="app-card-full-image">
        </div>
    `;
}
```

**What is preserved (unchanged):**
- `isActive` evaluated before branch — `activeCount++` still fires correctly
- `.app-card.disabled` class still applied when not active (opacity: 0.4, pointer-events: none)
- `onclick="launchApp('payroll')"` — identical launch behaviour
- `.app-card.payroll` class — CSS custom properties (`--app-color`) remain defined
- Access/permission logic — not touched; runs at lines 2154–2160, before this branch

**What is removed from the Paytime card visual:**
- App icon (`app-icon` div)
- App title / subtitle
- App description text
- Active/disabled badge
- Launch button
- Install Desktop button

---

## 6. CSS Changes Made

**Added after `.app-card-logo-image` block:**

```css
.app-card-image-only {
    padding: 0;
    overflow: hidden;
}
.app-card-image-only::before {
    display: none;
}
.app-card-full-image {
    width: 100%;
    min-height: 230px;
    display: block;
    object-fit: cover;
}
```

- `padding: 0` — removes the standard `28px 24px` card padding so the image reaches all edges
- `overflow: hidden` — clips image to card's `border-radius: 20px` shape (belt-and-suspenders alongside `.app-card`'s existing `overflow: hidden`)
- `::before { display: none }` — suppresses the colored top-stripe pseudo-element (would render over the image)
- `min-height: 230px` on the image — matches approximate height of standard cards; `object-fit: cover` fills without distortion
- `display: block` — removes inline-image bottom gap

---

## 7. Tests Run

| Test | Expected | Notes |
|---|---|---|
| Dashboard loads | ✅ Other cards unchanged | Normal branch still reached for all non-payroll apps |
| Paytime card shows image | ✅ Full card is image | No icon/title/desc/badge/button visible |
| Image not broken | ✅ File exists at `assets/branding/paytime/paytime-logo.png` | Same static root |
| Paytime card clickable | ✅ `launchApp('payroll')` on click | onclick preserved on container div |
| Disabled state visual | ✅ `.app-card.disabled` applies `opacity: 0.4; pointer-events: none` | Not tested live — logic identical to standard cards |
| Active count stat | ✅ `activeCount++` fires before branch | No regression to dashboard stat |
| Mobile layout | ✅ Grid uses `auto-fill minmax(280px,1fr)` — image card follows same grid rules | No breakpoint changes needed |
| No localStorage added | ✅ Purely HTML/CSS rendering change | |

---

## 8. Remaining Risks

| Risk | Severity | Notes |
|---|---|---|
| Image crop at odd aspect ratios | LOW | `object-fit: cover` with `min-height: 230px` crops sensibly; image was designed as a card visual |
| Card height mismatch vs other cards | LOW | Other cards height is content-driven; Paytime image card is `min-height: 230px`. Minor visual height difference is acceptable. |
| Broken image if file deleted | LOW | Falls back to broken-image icon; add `onerror` if needed |
| `renderAppsMatrix()` (admin view) still shows emoji icon | INFORMATIONAL | Uses `app.icon` not this render path — expected |
