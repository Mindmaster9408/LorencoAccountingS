# Accounting Dark Theme — Architecture Reference

> Last updated: March 2026
> Status: Implemented — global coverage with shared guard + CSS extension system

---

## Overview

The Lorenco Accounting frontend uses a **dark-first** theme: an amber/gold accent (`#f59e0b`) on a deep purple/navy gradient background, matching the ecosystem dashboard look.

The theme is implemented as a **load-order cascade**:

1. Each page has an inline `<style>` block (light-mode defaults — these were the original styles and remain untouched for print compatibility)
2. `css/dark-theme.css` is loaded **after** the inline styles — it overrides everything using `!important`
3. `js/theme-guard.js` runs in `<head>` — adds `data-theme="dark"` to `<html>` and injects the CSS if missing

This means no page's inline styles need to change. Dark theme is applied purely through the external stylesheet override.

---

## Files

| File | Purpose |
|---|---|
| `css/dark-theme.css` | Complete dark theme override — ~1453 lines covering all pages |
| `js/theme-guard.js` | JS guard: adds `data-theme="dark"` to `<html>`, auto-injects CSS if missing, provides `ThemeGuard` API (including `tokens`) |

---

## CSS Variables

Defined in `:root` at the top of `dark-theme.css`:

| Variable | Value | Usage |
|---|---|---|
| `--bg-dark` | `#0f0c29` | Body gradient start |
| `--bg-mid` | `#302b63` | Body gradient mid |
| `--bg-end` | `#24243e` | Body gradient end |
| `--surface` | `rgba(255,255,255,0.06)` | Card/panel background |
| `--surface-hover` | `rgba(255,255,255,0.10)` | Card hover state |
| `--surface-alt` | `rgba(255,255,255,0.04)` | Alternate/subtle surface |
| `--border` | `rgba(255,255,255,0.08)` | Default border |
| `--border-strong` | `rgba(255,255,255,0.12)` | Emphasized border |
| `--text` | `#fff` | Primary text |
| `--text-secondary` | `rgba(255,255,255,0.7)` | Secondary text |
| `--text-muted` | `rgba(255,255,255,0.5)` | Muted/label text |
| `--accent` | `#f59e0b` | Amber accent |
| `--accent-dark` | `#d97706` | Dark amber (gradient end) |
| `--accent-light` | `#fbbf24` | Light amber (links/highlights) |
| `--accent-glow` | `rgba(245,158,11,0.3)` | Glow/focus shadow |
| `--accent-subtle` | `rgba(245,158,11,0.15)` | Subtle amber tint |

---

## Coverage Map

### All pages

| Component | CSS Rule | Coverage |
|---|---|---|
| Body background | `body { background: linear-gradient(...) }` | ✅ |
| Top bar / navbar | `.top-bar`, `.navbar`, `.main-nav` | ✅ |
| Cards / panels | `.card`, `.report-card`, `.panel`, `.widget` | ✅ |
| Tables (th/td/thead) | `th`, `td`, `thead`, `tbody tr:hover` | ✅ |
| Forms (input/select/textarea) | Global element selectors | ✅ |
| Buttons | `.btn-primary` (amber), `.btn-secondary` (surface) | ✅ |
| Modals / overlays | `.modal-overlay`, `.modal-content` | ✅ |
| Dropdowns | `.dropdown`, `.dropdown-header` | ✅ |
| Tabs | `.tab`, `.tab.active` | ✅ |
| Status badges | `.status-*` (paid/unpaid/draft/etc.) | ✅ |

### Report pages (P&L, Balance Sheet, Trial Balance, etc.)

| Component | CSS Rule | Coverage |
|---|---|---|
| Report banner header | `.report-header` — amber gradient | ✅ |
| Report filter bar | `.report-controls` — dark surface | ✅ |
| Section header rows | `tr.section-header td` — amber tinted | ✅ |
| Section total rows | `tr.section-total td` — amber tinted | ✅ |
| Grand total rows | `tr.grand-total td` — amber gradient | ✅ |
| Positive amounts | `.positive` — green preserved | ✅ |
| Negative amounts | `.negative` — red preserved | ✅ |

### Bank Reconciliation page

| Component | CSS Rule | Coverage |
|---|---|---|
| Header/content panels | `.recon-header`, `.transactions-section`, `.summary-panel` | ✅ |
| Detail boxes | `.detail-box` — dark surface | ✅ |
| Highlighted detail box | `.detail-box.highlight` — amber tinted | ✅ |
| Filter buttons | `.filter-btn`, `.filter-btn.active` | ✅ |
| Reconciled rows | `.transactions-table tbody tr.reconciled` — green tinted | ✅ |
| Difference box | `.difference-box` — amber/green per state | ✅ |
| Summary labels/values | `.summary-label`, `.summary-value` | ✅ |

### Contacts page

| Component | CSS Rule | Coverage |
|---|---|---
| Section container | `.section` | ✅ |
| Tabs border | `.tabs` — dark border | ✅ |
| Tab base text | `.tab` — muted text | ✅ |
| Tab hover | `.tab:hover` — amber hover | ✅ |
| Active tab text | `.tab.active` — amber text | ✅ |
| Active tab underline | `.tab.active::after` — amber gradient | ✅ |
| Table th/td | Global `th`/`td` rules | ✅ |
| Filter dropdown | Global `select` rule | ✅ |
| Summary stats bar | `.summary-stats` — dark surface | ✅ |
| Contact name (link) | `.contact-name` — amber text | ✅ |
| Contact stat card | `.contact-stat-card` — dark surface | ✅ |
| Activity item divider | `.activity-item` — dark border | ✅ |
| Activity icon | `.activity-icon` — amber-subtle bg + amber text | ✅ |
| Form section dividers | `.form-section` — dark border | ✅ |
| Form section title | `.form-section-title` + `::before` — amber accent bar | ✅ |
| Sean AI section | `.sean-ai-section` — dark surface + amber border | ✅ |
| Action buttons (small) | `.action-btn-small` — dark surface | ✅ |
| Modal header | `.modal-header` — amber gradient (replaces blue) | ✅ |
| Modal footer | `.modal-footer` — dark surface-alt | ✅ |
| Modal tabs | `.modal-tabs`, `.modal-tab`, `.modal-tab.active` | ✅ |
| Amount colours | `.amount-positive/.negative/.zero` | ✅ |

### Bank page (bank.html) — additional coverage

| Component | CSS Rule | Coverage |
|---|---|---|
| Bank account cards | `.bank-account-card`, `.active`, `:hover` | ✅ |
| Account balance | `.account-balance` — amber gradient clip text | ✅ |
| Tab count badge | `.tab-count`, `.tab.active .tab-count` | ✅ |
| AI allocation button | `.ai-btn`, `.ai-btn:hover/.active` | ✅ |
| AI suggestion row | `.ai-suggestion-row` — dark surface + amber left border | ✅ |
| AI decision / override panels | `.ai-decision`, `.ai-override` — dark surface | ✅ |
| Manual entry row | `.manual-entry-row`, `.manual-entry-label`, `.manual-input` | ✅ |
| Attachment modal items | `.attachment-item`, `.attachment-actions button` | ✅ |
| Upload drag area | `.upload-area`, `.drag-over` | ✅ |
| Import step wizard | `.import-steps`, `.import-step.active`, `.step-number` | ✅ |
| Import summary panel | `.import-summary`, `.summary-item` | ✅ |
| Import type toggle | `.import-type-toggle`, `.import-type-btn.active` | ✅ |
| PDF review table | `.pdf-review-table` th/td, `.is-duplicate` | ✅ |
| PDF warning banner | `.pdf-warning-banner` — amber-subtle + amber border | ✅ |
| PDF detected bank badge | `.pdf-detected-bank` — green dark tint | ✅ |

---

## How to Add a New Page

When creating a new accounting HTML page:

> **Current status (March 2026):** All 30 existing pages already have `theme-guard.js` wired in. New pages must maintain the same head block structure.

### Minimum required head block

```html
<head>
    <script src="js/navigation.js"></script>
    <script src="js/theme-guard.js"></script>   <!-- BEFORE inline styles -->
    <style>
        /* ... your page-specific layout styles ... */
    </style>
    <link rel="stylesheet" href="css/dark-theme.css">  <!-- always LAST -->
</head>
```

The `theme-guard.js` fires immediately (before rendering) and adds `data-theme="dark"` to `<html>`. The `dark-theme.css` link at the end overrides everything in the inline `<style>` block.

### If dark-theme.css has gaps for your new components

Add the CSS to `dark-theme.css` in the appropriate section. Use this pattern:

```css
/* ── My New Component ───────────────────────────────────────────────────────── */
.my-new-component {
    background: var(--surface) !important;
    border-color: var(--border) !important;
    color: var(--text) !important;
}
.my-new-component .label {
    color: var(--text-muted) !important;
}
```

**Rules:**
- Always use `!important` — dark-theme.css loads after inline styles which may also use `!important` (via the original light-theme `!important` declarations on some pages)
- Use CSS variables, never hardcoded colors
- Add the rule to the correct section (global components, page-specific, etc.)

### Using the ThemeGuard API

If your page renders content dynamically (after API calls), register a hook:

```javascript
// After rendering dynamically injected HTML:
ThemeGuard.onReady(function() {
    // Any code to apply theme to fresh elements
    // Usually not needed — CSS handles it. Use only if needed.
});

// After a dynamic render, trigger the hooks:
loadData().then(function(data) {
    renderTable(data);
    ThemeGuard.refresh();  // triggers any registered onReady hooks
});
```

For JS-driven chart/canvas rendering, use the colour tokens:

```javascript
// Access theme colours without hardcoding values
const { accent, surface, text, positive, negative } = ThemeGuard.tokens;

// Example: Chart.js dataset colours
const chartOptions = {
    datasets: [{
        borderColor: ThemeGuard.tokens.accent,
        backgroundColor: ThemeGuard.tokens.accentGlow,
    }],
    color: ThemeGuard.tokens.text,
};
```

`ThemeGuard.tokens` mirrors all `:root` CSS variables as JS constants. See `js/theme-guard.js` for the full list.

---

## Print / Export Compatibility

The inline `<style>` blocks are intentionally preserved on each page. For print/PDF:

- `@media print` rules in the inline styles will still fire (dark-theme.css does not override print media queries)
- If a page needs print-safe report output, add a `@media print { ... }` block to the inline styles that resets colors to light-mode values
- dark-theme.css does not have `@media print` rules — it applies to screen only

---

## Known Limitations

- **`vatRate = 0` in calcLineVAT**: Uses `|| 15` falsy fallback — `0` defaults to 15%. Separately tracked.
- **Inline `style=""` attributes on elements**: The generic selector `.report-content table tr[style*="background"]` handles most cases. If a page has deeply nested inline styles outside `.report-content`, add a targeted override.
- **IE compatibility**: Not targeted. Dark theme uses CSS variables and `backdrop-filter` which require modern browsers.

---

## Architecture Decision: Cascade Override vs. Per-Page CSS

**Decision**: Single external stylesheet (`dark-theme.css`) with `!important` overrides.

**Alternatives considered**:
1. Remove all inline styles from HTML pages and use shared CSS — rejected: too much churn, breaks print compatibility, requires touching all 30 files
2. JavaScript-based theme application — rejected: causes flash of unstyled content, JS-dependent
3. CSS custom properties with light/dark variants — current approach IS this, implemented via the dark-theme.css override model

**Why this works**: All 30 HTML pages load `dark-theme.css` as the last stylesheet. Since all inline styles have lower cascade specificity than `!important` rules in an external stylesheet that loads later, the dark theme wins for every element it targets.

---

## March 2026 — Global Theme Guard Extension

### Root cause analysis of remaining issues

Three patterns caused visible light-theme artefacts after dark-theme.css was loaded:

**Pattern 1 — TR-level inline blue backgrounds bleeding through semi-transparent TDs**

Report pages used:
```html
<tr class="section-total" style="background: rgba(0,102,204,0.12);">
```
The amber `td` backgrounds (`rgba(245,158,11,0.06)`) are only 6% opacity. The blue TR background bleeds through and creates a bluish tint.

Fix added to dark-theme.css:
```css
tr.section-header, tr.section-total, tr.grand-total {
    background: transparent !important;
}
```

**Pattern 2 — JS-generated HTML with inline styles and no class**

`bank.html` delete confirmation modal was created as:
```js
modal.innerHTML = '<div style="background:white;…">'
```
CSS cannot override this without an ID/class selector. Fixed by:
- Targeting `#deleteConfirmModal > div` in dark-theme.css
- Replacing inline JS `style="background:#fff8e1"` with `class="bank-delete-warning"`
- Replacing `style="background:#f5f5f5"` on cancel buttons with `class="bank-form-cancel"`
- Replacing `style="background:#e6f3ff"` info boxes with `class="info-box"`
- Adding `class="pdf-review-container"` to the scrollable wrapper

**Pattern 3 — Missing CSS coverage for contacts.html inline styles**

The Sean AI section in contacts.html had:
```html
<span style="color:#6c757d; background:#e9ecef">Helps Sean understand this contact</span>
<div style="background: linear-gradient(135deg, #e6f3ff 0%, #f0f8ff 100%); border-left: 3px solid #0066cc;">
```

Fixed by replacing with:
```html
<span class="sean-info-badge">…</span>
<div class="sean-info-box" style="border-left: 3px solid;">…</div>
```

And adding rules for `.sean-info-badge` and `.sean-info-box` to dark-theme.css.

### New CSS rules added (dark-theme.css, end of file)

| Rule | Purpose |
|---|---|
| `tr.section-header, tr.section-total, tr.grand-total { background: transparent }` | Prevents blue TR bleed-through |
| `tr.error-row td, tr.error-row th` | Dark red error rows in JS-rendered report tables |
| `#plError, #bsError, #tbError, #bankModalError` | Error divs shown on API failure |
| `.sean-info-badge` | Sean AI badge label (was grey) |
| `.sean-info-box` | Sean AI info panel under textarea (was light blue) |
| `.bank-form-cancel` | Bank account modal cancel button |
| `.info-box` | Bank import and info panels (was light blue) |
| `.pdf-review-container` | Scrollable PDF transaction review area |
| `#deleteConfirmModal > div` | JS-generated delete modal inner div |
| `#deleteConfirmModal button:not(#confirmDeleteBtn)` | Cancel button in delete modal |
| `.bank-delete-warning` | Warning message in delete modal |

### Files changed

| File | Change |
|---|---|
| `css/dark-theme.css` | Added ~120 lines of new rules covering the above |
| `reports.html` | Removed `style="background: rgba(0,102,204,0.12)"` from static `<tr class="section-total">` |
| `balance-sheet.html` | Removed inline blue backgrounds from 6 static TRs; fixed JS-generated section-total rows; converted error row to `class="error-row"` |
| `trial-balance.html` | Converted JS-generated error row to `class="error-row"` |
| `contacts.html` | Sean badge and info box: added `.sean-info-badge` and `.sean-info-box` classes |
| `bank.html` | Delete modal JS rewrite (classes); cancel button class; info box class; PDF review container class |
