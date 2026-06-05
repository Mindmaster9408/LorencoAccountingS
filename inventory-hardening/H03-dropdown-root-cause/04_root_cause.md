# H03 — Root Cause Report

**Date:** 2026-06-05
**Status:** ROOT CAUSE CONFIRMED via static code analysis

---

## Direct answers to investigation questions

| Question | Answer |
|---|---|
| Is the custom dropdown script loading? | YES — code is at lines 5884–6202 in `index.html` |
| Is it wrapping selects? | YES — `build()` runs on all selects at DOMContentLoaded, including modal selects |
| Is the white dropdown native OS select or custom panel? | Native OS popup — BUT only if the live file is stale (no custom select code deployed). If live file is current, the native select has `pointer-events:none` and CANNOT produce a popup. |
| Is the issue cache/deployment? | UNKNOWN — no build marker existed before this session. Added now. Must verify after next push. |
| Is the issue CSS override? | NO — no CSS overrides `.cs-panel` background. The panel background is dark (#1e1b4b). |
| Is the issue z-index/overflow? | **YES — CONFIRMED. This is the primary root cause.** |
| Is the issue event timing? | NO — timing is correct for all modal selects (built at page load) |
| Which exact file/line causes it? | `frontend-inventory/index.html` line 253 + line 372 |

---

## PRIMARY ROOT CAUSE

### `.modal { overflow-y: auto }` clips `.cs-panel { position: absolute }`

**File:** `accounting-ecosystem/frontend-inventory/index.html`
**Line 253 (modal rule):**
```css
.modal {
  ...
  max-height: 92vh;
  overflow-y: auto;     ← THIS IS THE PROBLEM
  border-radius: 20px;
}
```

**Line 371–377 (panel rule):**
```css
.cs-panel {
  display: none;
  position: absolute;   ← THIS GETS CLIPPED
  left: 0;
  min-width: 100%;
  top: calc(100% + 3px);
  ...
}
```

### Why this clips the panel

The CSS spec requires that a scroll container (any element with `overflow` != `visible`) clips all descendant content — INCLUDING absolutely positioned descendants — whose containing block is INSIDE the scroll container.

The DOM chain is:
```
.modal { overflow-y: auto }              ← scroll container
  └─ .modal-body
       └─ .form-section
            └─ .form-grid.cols3
                 └─ .form-field
                      └─ .cs-wrap { position: relative }   ← containing block of .cs-panel
                           ├─ <select> (native, hidden)
                           ├─ .cs-trigger (visible button)
                           └─ .cs-panel { position: absolute }   ← CLIPPED
```

`.cs-wrap` (the containing block of `.cs-panel`) is inside `.modal` (the scroll container). Therefore `.cs-panel` IS subject to `.modal`'s overflow clipping.

### When does the clipping become visible

The panel opens at `top: calc(100% + 3px)` relative to `.cs-wrap` — i.e., directly below the trigger. The panel has `max-height: 240px`. If the trigger is positioned anywhere in the lower portion of the modal's visible area, the panel extends below the modal's bottom edge and is clipped to nothing (or a sliver).

On a typical laptop screen with `max-height: 92vh`, the `#itemModal` is tall and the Costing Method field sits in the middle of the form. The clipping ALWAYS happens when:
- The user has scrolled the modal (the trigger is at/near the modal's bottom edge)
- The screen is small (modal is at max-height, form is long)
- The browser zoom level is high (more content is at/near the edge)

The user sees: nothing where the panel should be, or a thin sliver of options.

### Why the viewport-flip logic doesn't save it

```js
window.requestAnimationFrame(function () {
    var r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) { ... flip ... }
});
```

`getBoundingClientRect()` returns the **rendered** (already-clipped) bounds. When the panel is clipped at the modal's bottom edge:
- `r.bottom` = the Y coordinate of the modal's bottom edge
- This is well within `window.innerHeight`
- `r.bottom > window.innerHeight - 8` is **FALSE**
- The flip never triggers
- The panel stays clipped

The flip logic is designed to detect viewport overflow (panel escaping the screen). It CANNOT detect intermediate scroll-container clipping. This is a fundamental design limitation.

---

## SECONDARY ROOT CAUSE

### `.modal-overlay { backdrop-filter }` creates a containing block for `position:fixed`

**File:** `accounting-ecosystem/frontend-inventory/index.html`
**Line 251:**
```css
.modal-overlay {
  position: fixed;
  inset: 0;
  backdrop-filter: blur(6px);   ← creates containing block for position:fixed descendants
  z-index: 500;
}
```

Per the W3C CSS Filter Effects specification: an element with `backdrop-filter` establishes a containing block for `position:fixed` descendants.

This means: changing `.cs-panel` to `position:fixed` would make it positioned relative to `.modal-overlay` (NOT the viewport directly).

**This is not a blocker** — since `.modal-overlay { position:fixed; inset:0 }` covers the entire viewport, coordinates obtained from `trigger.getBoundingClientRect()` are equivalent to coordinates within the modal-overlay. The fix still works correctly.

**The benefit:** `position:fixed` relative to `.modal-overlay` DOES escape `.modal { overflow-y:auto }` clipping, because `.modal` does NOT establish a containing block for fixed-positioned elements (no `transform`/`filter`/`backdrop-filter` on `.modal` itself). The panel escapes the scroll container.

---

## POSSIBLE PARALLEL CAUSE (unverifiable without live test)

### Stale deployment / cache

No build marker existed before this session. The last 5 commits all touched `frontend-inventory/index.html` with dropdown fixes. If Zeabur's build cache or the browser is serving an older version of the file (pre-H02-B), the custom select IIFE does not exist in the deployed file. The native `<select>` has NO `pointer-events:none`. Clicking on the select area produces the native OS popup — white on Windows Chrome.

**This cannot be ruled out without browser verification.**

The build marker added in this session (`window.STOREHOUSE_UI_BUILD = 'H03-forensic-d80e1d9'`) will resolve this question after the next push.

---

## What is NOT the root cause

| Hypothesis | Status |
|---|---|
| Custom select script not loading | NOT confirmed — code IS in source file |
| Script runs before selects exist | NOT the issue — DOMContentLoaded guard in place |
| Select wrappers created but hidden behind native select | NOT the issue — native has `pointer-events:none` |
| CSS specificity override on `.cs-panel` background | NOT the issue — no rule overrides it |
| z-index issue (panel behind modal content) | NOT the issue — `z-index:99999` within stacking context is highest |
| MutationObserver not catching static modal selects | NOT the issue — static selects built at page load via querySelectorAll |
| Event handlers break after modal opens | NOT the issue — handlers are set on DOM elements, survive modal show/hide |
| Select re-render wipes wrapper | NOT the issue — openItemModal() only sets .value, does not recreate selects |
| Old cached frontend (deployment) | UNKNOWN — possible, added build marker to verify |

---

## Confirmed root cause statement

> The custom select panel (`.cs-panel`) uses `position: absolute` and is contained within `.modal { overflow-y: auto }`. CSS overflow clipping applies to all absolutely-positioned descendants whose containing block is inside a scroll container. The panel is clipped at the modal's bottom edge when it opens downward. The viewport-flip logic fails to detect this because `getBoundingClientRect()` returns the clipped (already-hidden) panel bounds. The user sees nothing where the panel should appear.
>
> The white popup that appears is the native OS select popup, which becomes reachable only if the custom select code is NOT deployed (stale cache scenario) OR if the user somehow bypasses the trigger div and reaches the native select.
