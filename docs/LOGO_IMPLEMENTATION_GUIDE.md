# Lorenco Logo Implementation Guide

**Date:** April 2026  
**Status:** Ready for implementation  
**Master Reference:** `/memories/repo/LOGO_USAGE_STANDARD.md`

---

## Overview

Implement the approved Lorenco neon circuit logo (PNG) across all authentication and branding areas. The logo preserves premium visual depth, glow effects, orbital rings, and node lighting in exact approved render style.

---

## Files to Prepare

### Approved PNG Reference Images (Provided)
- **Full reference:** `lorenco-logo-exact-reference.png` (high-resolution complete artwork)
- **App-ready cropped:** `lorenco-logo-cropped.png` (tighter crop for UI placement)

**Visual specification:** Neon circuit board with premium glow effects, purple-to-cyan orbital gradient, dotted particle rings, and bright glowing nodes.

### Destination Locations (where static assets are served)

Backend serves each frontend as static content. Place PNGs in frontend directories:

```
accounting-ecosystem/
├── frontend-ecosystem/
│   └── lorenco-logo-cropped.png
├── frontend-payroll/
│   └── lorenco-logo-cropped.png
├── frontend-coaching/
│   └── lorenco-logo-cropped.png
```

**Served at:** `/lorenco-logo-cropped.png` (from each frontend's root)

---

## Login Screens to Update

| File | Type | Status |
|---|---|---|
| `accounting-ecosystem/frontend-ecosystem/login.html` | Main ecosystem login | Primary |
| `accounting-ecosystem/frontend-payroll/login.html` | Payroll app login | Secondary |
| `accounting-ecosystem/frontend-coaching/login.html` | Coaching app login | Secondary |
| `Lorenco Accounting/public/login.html` | Accounting app login | Secondary |

---

## Implementation Pattern

### Current Implementation (SVG inline)

```html
<div class="brand-logo">
    <svg width="108" height="108" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Large inline SVG gradients and paths -->
    </svg>
</div>
```

### New Implementation (PNG image)

```html
<div class="brand-logo">
    <img
      src="/lorenco-logo-cropped.png"
      alt="Lorenco Ecosystem"
      class="logo-image"
    />
</div>
```

### CSS Changes

**Add to the login page CSS (immediately after `.brand-logo` style):**

```css
.brand-logo img {
    width: 108px;
    height: auto;
    display: block;
    opacity: 1;
    filter: drop-shadow(0 0 28px rgba(154, 124, 255, 0.55))
            drop-shadow(0 0 60px rgba(255, 107, 234, 0.2));
}
```

**Important:** Do NOT add additional filtering (blur, hue-rotate, brightness, etc.) that distorts the approved artwork.

---

## Step-by-Step Implementation

### Step 1: Generate the Logo PNG

```bash
cd /root/of/ecosystem
python generate-neon-logo.py
# Output: lorenco-logo-cropped.png in current directory
```

### Step 2: Place PNG Files in Frontend Root Directories

Backend serves static files from each frontend directory root. Place the approved PNG:

```bash
# Copy approved lorenco-logo-cropped.png to each frontend root
cp lorenco-logo-cropped.png accounting-ecosystem/frontend-ecosystem/
cp lorenco-logo-cropped.png accounting-ecosystem/frontend-payroll/
cp lorenco-logo-cropped.png accounting-ecosystem/frontend-coaching/
```

**Path in HTML:** `<img src="/lorenco-logo-cropped.png" ... />`  
(served by backend static middleware from each frontend directory)

### Step 3: Update Login HTML Files

For each login file listed above, **replace the entire SVG element** with the new PNG `<img>` tag.

**Example for `accounting-ecosystem/frontend-ecosystem/login.html`:**

Find:
```html
<div class="brand-logo">
    <svg width="108" height="108" viewBox="0 0 1024 1024" ... >
        <!-- 300+ lines of SVG defs and paths -->
    </svg>
</div>
```

Replace with:
```html
<div class="brand-logo">
    <img
      src="/lorenco-logo-cropped.png"
      alt="Lorenco Ecosystem"
      class="logo-image"
    />
</div>
```

### Step 4: Ensure CSS Stays in Place

The `.brand-logo` CSS (drop-shadow filter) should remain **unchanged**.  
The `.brand-logo img` CSS (new) ensures proper sizing and rendering.

### Step 5: Verify Auth Logic Remains Intact

✓ Form validation logic  
✓ API endpoints (`/api/auth/login`)  
✓ JWT token handling  
✓ localStorage management  
✓ Company context switching  
✓ Permission routing  

**Auth logic must not be modified** — only the logo visual presentation changes.

---

## Validation Checklist

- [ ] PNG file placed in `accounting-ecosystem/frontend-ecosystem/lorenco-logo-cropped.png`
- [ ] PNG file placed in `accounting-ecosystem/frontend-payroll/lorenco-logo-cropped.png`
- [ ] PNG file placed in `accounting-ecosystem/frontend-coaching/lorenco-logo-cropped.png`
- [ ] Logo appears sharp and unfiltered on login page
- [ ] Drop-shadow filter applied (glow effect preserved from original)
- [ ] Image centered and properly sized (108px width)
- [ ] Logo render matches approved visual style (premium neon circuit aesthetic)
- [ ] All auth flows working (submit, error handling, redirect)
- [ ] Company selection still functions
- [ ] No horizontal scroll or layout breaking
- [ ] Cross-browser tested (Chrome, Safari, Firefox, Edge)
- [ ] Mobile responsive

---

## What Does NOT Change

| Component | Status |
|---|---|
| Form fields (username, password) | ✓ Keep as-is |
| Error message display | ✓ Keep as-is |
| API endpoints | ✓ Keep as-is |
| JWT token handling | ✓ Keep as-is |
| Company selection | ✓ Keep as-is |
| Permission routing | ✓ Keep as-is |
| localStorage management | ✓ Keep as-is |
| Brand text (LORENCO, ECOSYSTEM) | ✓ Keep as-is |

---

## Next Phase: Paytime App Logo

After the Lorenco ecosystem logo is implemented:

1. Generate Paytime logo in **identical neon render style** (not flat SVG)
2. Follow the same implementation pattern
3. Place in `accounting-ecosystem/frontend-payroll/public/paytime-logo-neon.png`
4. Update Payroll login to use the new logo

---

## References

- **Master Logo Standard:** `/memories/repo/LOGO_USAGE_STANDARD.md`
- **Logo Generator Script:** `generate-neon-logo.py`
- **Ecosystem Architecture:** `docs/ecosystem-architecture.md`

---

*This implementation preserves the approved premium visual aesthetic while modernizing the login experience.*
