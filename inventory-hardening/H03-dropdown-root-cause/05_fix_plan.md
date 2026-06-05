# H03 — Targeted Fix Plan

**Date:** 2026-06-05
**Based on:** Confirmed root cause in `04_root_cause.md`

---

## The one targeted fix

**Make `.cs-panel` use `position: fixed` with viewport-pixel coordinates calculated at open time.**

This lets the panel escape `.modal { overflow-y: auto }` clipping entirely. The panel paints at viewport level (relative to `.modal-overlay` which covers the full screen). It can never be clipped by any intermediate scroll container.

---

## Exact changes required

### Change 1 — CSS (line 371–377 in `index.html`)

**Before (line 372):**
```css
.cs-panel {
  display: none; position: absolute; left: 0; min-width: 100%;
  top: calc(100% + 3px); bottom: auto;
  background: #1e1b4b; border: 1px solid var(--border); border-radius: 9px;
  overflow: hidden; overflow-y: auto; max-height: 240px;
  z-index: 99999; box-shadow: 0 10px 40px rgba(0,0,0,0.65);
}
```

**After:**
```css
.cs-panel {
  display: none; position: fixed;
  background: #1e1b4b; border: 1px solid var(--border); border-radius: 9px;
  overflow: hidden; overflow-y: auto; max-height: 240px;
  z-index: 99999; box-shadow: 0 10px 40px rgba(0,0,0,0.65);
}
```

Removed: `left: 0; min-width: 100%; top: calc(100% + 3px); bottom: auto;`
These are now set by JS in `open()` using real pixel coordinates.

Changed: `position: absolute` → `position: fixed`

---

### Change 2 — JS `open()` function (~lines 6070–6087 in `index.html`)

**Before:**
```js
function open() {
  if (sel.disabled) return;
  buildPanel();
  panel.style.display = 'block';
  panel.style.top     = 'calc(100% + 3px)';
  panel.style.bottom  = 'auto';
  trigger.classList.add('cs-open');
  trigger.setAttribute('aria-expanded', 'true');

  window.requestAnimationFrame(function () {
    var r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
      panel.style.top    = 'auto';
      panel.style.bottom = 'calc(100% + 3px)';
    }
  });
}
```

**After:**
```js
function open() {
  if (sel.disabled) return;
  buildPanel();

  // Position at trigger coordinates using fixed positioning.
  // Fixed escapes .modal { overflow-y: auto } clipping.
  // Since .modal-overlay has backdrop-filter (= containing block for fixed),
  // getBoundingClientRect() coords are equivalent to coords within .modal-overlay.
  var tr = trigger.getBoundingClientRect();
  panel.style.left   = tr.left + 'px';
  panel.style.width  = tr.width + 'px';
  panel.style.top    = (tr.bottom + 3) + 'px';
  panel.style.bottom = 'auto';
  panel.style.display = 'block';

  trigger.classList.add('cs-open');
  trigger.setAttribute('aria-expanded', 'true');

  // Flip above trigger if panel would overflow the viewport bottom
  window.requestAnimationFrame(function () {
    var r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
      panel.style.top    = 'auto';
      panel.style.bottom = (window.innerHeight - tr.top + 3) + 'px';
    }
  });
}
```

Key differences:
- Uses `trigger.getBoundingClientRect()` to get exact screen coordinates
- Sets `panel.style.left` and `panel.style.width` from trigger's actual screen position
- Sets `panel.style.top` to `tr.bottom + 3` (pixels below trigger bottom)
- The `requestAnimationFrame` flip now uses `window.innerHeight - tr.top + 3` for the `bottom` position, which correctly anchors the panel above the trigger

---

## Why this works

1. `position: fixed` elements are positioned relative to their nearest containing block with `transform`/`filter`/`backdrop-filter`. Here that is `.modal-overlay { backdrop-filter }`.
2. `.modal-overlay { position: fixed; inset: 0 }` covers the full viewport. So fixed-pixel coordinates from `getBoundingClientRect()` are directly valid.
3. `.modal { overflow-y: auto }` does NOT establish a containing block for fixed-positioned elements. The panel escapes `.modal`'s scroll container.
4. The panel paints above the modal scroll container, at viewport (modal-overlay) level. No clipping occurs.
5. The flip logic now correctly uses `window.innerHeight - tr.top + 3` for `bottom` in fixed coords — this works even when `.modal` is scrolled.

---

## What this does NOT change

- No backend changes
- No database changes
- No localStorage added
- No business logic changed
- No existing select CSS modified (`.filter-select`, `.form-field select`, `.bom-line-row select` unchanged)
- The native select remains hidden with `pointer-events:none` (the `build()` function is unchanged)
- All keyboard navigation, change event dispatch, and MutationObserver logic is unchanged
- All other modal behaviour (scroll, overlay, close on click outside) unchanged

---

## Files to change

| File | Change |
|---|---|
| `accounting-ecosystem/frontend-inventory/index.html` | CSS: `.cs-panel` rule (line 371) + JS: `open()` function (line ~6070) |

**Only ONE file. Two small edits within that file.**

---

## Test list after applying fix

| Test | What to verify |
|---|---|
| T1 — Toolbar filter selects | Click Category/Warehouse filters on Items tab. Panel opens dark, no clipping. |
| T2 — Add Item modal — Item Type | Open Add Item. Click Item Type dropdown. Panel opens dark below trigger, NOT clipped. |
| T3 — Add Item modal — Unit | Same as T2 for Unit. |
| T4 — Add Item modal — Costing Method | **Primary failure case.** Panel must open dark and fully visible. |
| T5 — Add Item modal — Location | Same for Location (dynamically populated). |
| T6 — Modal scrolled | Open Add Item. Scroll modal to bottom. Click a dropdown. Panel opens above trigger if needed (flip). |
| T7 — Small screen / zoom | Open Add Item at 125% browser zoom. All dropdowns remain visible. |
| T8 — Movement modal | Open Movement modal. Click Item dropdown (populated from API). Options visible dark. |
| T9 — BOM editor | Open BOM. Add component line. Component dropdown opens dark. |
| T10 — PO modal | Open Create PO. Supplier dropdown opens dark. |
| T11 — Keyboard navigation | Tab to any dropdown trigger, press Space/Enter, arrow keys navigate, Enter selects. |
| T12 — Click outside | Open any dropdown, click elsewhere. Panel closes. |
| T13 — build marker check | `window.STOREHOUSE_UI_BUILD` in console returns `'H03-forensic-d80e1d9'` |

---

## Rollback note

If the fix causes a regression:

The ONLY change is in `open()` (JS) and `.cs-panel` (CSS). To revert:

**CSS — restore to:**
```css
.cs-panel {
  display: none; position: absolute; left: 0; min-width: 100%;
  top: calc(100% + 3px); bottom: auto;
  background: #1e1b4b; border: 1px solid var(--border); border-radius: 9px;
  overflow: hidden; overflow-y: auto; max-height: 240px;
  z-index: 99999; box-shadow: 0 10px 40px rgba(0,0,0,0.65);
}
```

**JS `open()` — restore to:**
```js
function open() {
  if (sel.disabled) return;
  buildPanel();
  panel.style.display = 'block';
  panel.style.top     = 'calc(100% + 3px)';
  panel.style.bottom  = 'auto';
  trigger.classList.add('cs-open');
  trigger.setAttribute('aria-expanded', 'true');
  window.requestAnimationFrame(function () {
    var r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
      panel.style.top    = 'auto';
      panel.style.bottom = 'calc(100% + 3px)';
    }
  });
}
```

Or use `git revert` to the commit that precedes this fix.

---

## Authorization required before implementing

Per CLAUDE.md Rule A1: audit must be complete before change. It is.

The fix is narrow, targeted, and provably correct. Awaiting confirmation from Ruan before applying.
