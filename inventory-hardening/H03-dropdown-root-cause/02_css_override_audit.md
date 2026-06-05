# H03 — Step 3 & 4: CSS Override Audit

**Date:** 2026-06-05
**File:** `accounting-ecosystem/frontend-inventory/index.html`

---

## All CSS touching select elements (in order)

| Line | Selector | Properties | Effect |
|---|---|---|---|
| 113 | `.filter-select` | `padding; background: var(--surface); border; border-radius; color; color-scheme:dark` | Toolbar filter selects — dark, works |
| 154–167 | `select` (global) | `background: var(--surface); color; border; border-radius; color-scheme:dark` | Fallback for any unstyled select |
| 168–170 | `select:focus` | `border-color; box-shadow` | Focus ring |
| 176–183 | `select option` | `background-color:#1e1b4b; color:#f8fafc` | Option list dark (for native popup) |
| 191–211 | `.form-control` | `width:100%; padding; background:#1e1b4b; border; border-radius; color; color-scheme:dark` | Modal/table selects with .form-control class |
| 215–230 | `.bom-line-item` | `padding; background:#1e1b4b; border; border-radius; color; color-scheme:dark` | JS-generated BOM selects |
| 268 | `.form-field input, .form-field select, .form-field textarea` | `padding; background:#1e1b4b; border; border-radius; color; color-scheme:dark` | All modal form inputs AND selects |
| 269 | `.form-field input:focus, .form-field select:focus` | `border-color; box-shadow` | Focus ring |
| 280 | `.bom-line-row input, .bom-line-row select` | `padding; background:#1e1b4b; border; border-radius; color; color-scheme:dark` | BOM row selects |
| 338–387 | `.cs-wrap`, `.cs-trigger`, `.cs-panel`, `.cs-opt`, etc. | All custom dropdown CSS | Custom overlay system |

---

## Critical finding: `.form-field select` vs. native select after wrapping

**Line 268**: `.form-field select { ... background: #1e1b4b; ... }`

After `build()` runs on `#iCostingMethod`, the native select is inside `.cs-wrap` which is inside `.form-field`. The selector `.form-field select` still matches the native `<select id="iCostingMethod">` through the `.cs-wrap` wrapper. This sets `background:#1e1b4b` on the native select.

However, the native select has `opacity:0; pointer-events:none` via inline styles. CSS background doesn't affect whether the native popup appears — only `pointer-events:none` matters.

**Verdict:** `.form-field select` does NOT interfere with the custom select system. The native select remains non-interactive.

---

## CSS that creates overflow clipping

| Line | Selector | Properties | Clipping effect |
|---|---|---|---|
| 251 | `.modal-overlay` | `position:fixed; inset:0; backdrop-filter:blur(6px); z-index:500` | Creates new stacking context AND a containing block for `position:fixed` descendants |
| 253 | `.modal` | `max-height:92vh; overflow-y:auto; border-radius:20px` | **CLIPS absolutely-positioned descendants** |
| 375 | `.cs-panel` | `overflow:hidden; overflow-y:auto` | Panel's own internal scroll (correct) |

---

## CRITICAL CSS FACT: `.modal { overflow-y: auto }` clips `.cs-panel`

**How overflow clipping works with absolute positioning:**

The CSS specification states: a scroll container clips all descendant content, including absolutely positioned descendants whose **containing block** is inside the scroll container.

Chain for `#iCostingMethod`'s panel:
```
.cs-panel { position: absolute }
    → positioned relative to .cs-wrap { position: relative }    ← containing block
        → inside .modal { overflow-y: auto }                    ← scroll container (clips)
            → inside .modal-overlay { position: fixed }
```

Since `.cs-wrap` (the containing block of `.cs-panel`) is INSIDE `.modal` (the scroll container), the panel IS subject to `.modal`'s overflow clipping.

**Result:** When the panel visually extends below `.modal`'s bottom edge, it is clipped and invisible to the user.

---

## CSS that creates additional stacking contexts

| Element | Property | Effect |
|---|---|---|
| `.modal-overlay` | `backdrop-filter: blur(6px)` | Creates stacking context + containing block for `position:fixed` |
| `.modal-overlay` | `z-index: 500` | Element is in page stacking context |
| `.modal-header` | `position: sticky; z-index: 1` | Creates stacking context within modal-overlay's context |
| `.toast` | `position: fixed; z-index: 9999` | Outside modal stacking context; NOT a conflict |

**CRITICAL: `backdrop-filter` on `.modal-overlay` makes it a containing block for `position:fixed`**

Per W3C CSS Filter Effects spec: elements with `backdrop-filter` establish a containing block for fixed-positioned descendants. This means any attempt to use `position:fixed` on `.cs-panel` does NOT escape the modal-overlay to the viewport — the panel is positioned relative to `.modal-overlay`.

**This is actually helpful:** since `.modal-overlay { position:fixed; inset:0 }` covers the full viewport, coordinates from `getBoundingClientRect()` on the trigger are directly usable as pixel positions within the modal-overlay. No coordinate adjustment needed.

And critically: `.modal { overflow-y: auto }` does NOT establish a containing block for fixed-positioned elements (no `transform`, `perspective`, `filter`, or `backdrop-filter`). So a `position:fixed` panel inside the modal-overlay is **NOT clipped by `.modal { overflow-y: auto }`**.

---

## Viewport flip logic failure

The current flip logic in `open()`:

```js
window.requestAnimationFrame(function () {
    var r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
        panel.style.top    = 'auto';
        panel.style.bottom = 'calc(100% + 3px)';
    }
});
```

**This logic is broken when the panel is being clipped by `.modal { overflow-y: auto }`.**

`getBoundingClientRect()` returns the RENDERED (clipped) bounds. When the panel is clipped at the modal's bottom edge, `r.bottom` returns the modal's bottom Y coordinate — which is WITHIN the viewport (not beyond `window.innerHeight - 8`). The condition `r.bottom > window.innerHeight - 8` is FALSE. The flip never triggers. The panel stays clipped below.

The flip logic correctly handles viewport overflow (panel near the bottom of the screen), but it CANNOT detect or correct overflow caused by an intermediate scroll container (`.modal`).

---

## No CSS rule resets `.cs-panel` background to white

Searching all CSS in the file: no rule matches `.cs-panel` or overrides its `background: #1e1b4b`. The panel's background is NOT the problem.

**If the user sees a "white" area: that white is the page/modal background showing through where the panel was expected to appear — the panel itself is clipped and invisible.**
