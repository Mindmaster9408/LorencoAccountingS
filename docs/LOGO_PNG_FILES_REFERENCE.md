# Lorenco Logo PNG Files — Master Reference

**Approval Date:** April 2026  
**Format:** PNG with transparent background | **Style:** Neon circuit board with premium glow  
**Status:** APPROVED ARTWORK — Use as-is, do not modify

---

## Two Approved Versions

### 1. Full Reference Artwork
**File:** `lorenco-logo-exact-reference.png`  
**Use case:** Master reference for consistency  
**Display:** Can be archived or used for detailed documentation

### 2. App-Ready Cropped Version
**File:** `lorenco-logo-cropped.png`  
**Use case:** Login screens, splash screens, hero areas  
**Recommended size:** 108px width (scales proportionally)

---

## Visual Specification

### Design Elements
- **Central circuit:** Neon glowing nodes connected by flowing lines
  - Purple-to-magenta primary gradient
  - Cyan-to-blue secondary elements
  - White bright highlights
- **Orbital rings:** Premium glow effects with multiple transparency layers
  - Outer dotted particle ring
  - Smooth gradient transition rings
- **Node lighting:** Intense white centers with color halos
  - Interior magenta highlights
  - Precise glow falloff
- **Background:** Dark with transparent areas for integration

### Color Palette
| Element | Color | Purpose |
|---------|-------|---------|
| Primary line | Purple-magenta gradient | Main circuit path |
| Secondary line | Cyan-blue | Right-side elements |
| Ring glow | Purple-blue | Orbital effect, layered transparency |
| Node centers | Bright white | Primary glow source |
| Node halos | Magenta, cyan | Color-specific glows |
| Particle dots | Light blue | Distant orbit accents |

### Technical Specs
- **Format:** PNG-32 (RGBA)
- **Resolution:** 150 DPI (app-ready)
- **Dimensions:** ~800×800 px (scales to any size)
- **Transparency:** Full alpha channel (dark background optional)
- **Rendering:** High-quality anti-aliased vectors rendered as raster

---

## File Placement

### Frontend Directory Structure

```
accounting-ecosystem/
├── frontend-ecosystem/
│   ├── login.html
│   └── lorenco-logo-cropped.png  ✓ Place here
├── frontend-payroll/
│   ├── login.html
│   └── lorenco-logo-cropped.png  ✓ Place here
└── frontend-coaching/
    ├── login.html
    └── lorenco-logo-cropped.png  ✓ Place here
```

**URL pattern in HTML:** `<img src="/lorenco-logo-cropped.png" ... />`

Backend `express.static()` serves each frontend directory, making the PNG accessible at the root path.

---

## Usage in HTML/React

### Basic HTML
```html
<img 
  src="/lorenco-logo-cropped.png" 
  alt="Lorenco Ecosystem" 
  style="width: 108px; height: auto;"
/>
```

### React Component
```jsx
<img
  src="/lorenco-logo-cropped.png"
  alt="Lorenco Ecosystem"
  className="w-44 h-auto"
/>
```

### With CSS Glow
```css
.brand-logo img {
  width: 108px;
  height: auto;
  filter: drop-shadow(0 0 28px rgba(154, 124, 255, 0.55))
          drop-shadow(0 0 60px rgba(255, 107, 234, 0.2));
}
```

---

## Implementation Checklist

- [ ] PNG files exist in frontend directories
- [ ] HTML img tags render correctly
- [ ] Login pages use PNG (not SVG replacements)
- [ ] Drop-shadow filter applied for glow effect
- [ ] Image appears sharp without distortion
- [ ] Cross-browser rendering verified
- [ ] Mobile responsive tested

---

## Preservation Rules (PERMANENT)

**✓ DO**
- Use PNG file directly
- Apply drop-shadow filter for glow
- Keep image rendering at full quality
- Preserve original color palette

**✗ DO NOT**
- Replace with SVG or simplified icon
- Apply CSS filters (blur, hue-rotate, brightness, saturate)
- Stretch or distort aspect ratio
- Reduce visual complexity

---

## Future: Paytime Logo

Next step: Create Paytime payroll app logo in **identical neon render style** (not SVG).

File: `paytime-logo-neon-cropped.png`  
Location: `accounting-ecosystem/frontend-payroll/paytime-logo-neon-cropped.png`  
Style: Maintain same premium glow, node lighting, and orbital effects

---

## Technical Notes

- **Background:** Can integrate with dark login backgrounds; transparency allows flexible backgrounds
- **Scaling:** Safe to scale from 80px to 400px width without quality loss (raster-rendered at optimal DPI)
- **Browser support:** All modern browsers (Chrome, Firefox, Safari, Edge 2020+)
- **Performance:** Single PNG file load, minimal file size vs. inline SVG

---

*This file documents the approved Lorenco ecosystem logo PNG artwork. Treat these files as permanent master assets. All branding must use these exact files for consistency.*
