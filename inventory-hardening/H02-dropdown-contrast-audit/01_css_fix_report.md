# H02 — CSS Fix Report

**Date:** 2026-06-05  
**File modified:** `accounting-ecosystem/frontend-inventory/index.html`  
**Insertion point:** After `.btn-gold` / before `/* ── Table ──*/` (line ~126)

---

## CSS Block Added

A single central style block was inserted. No existing rules were modified or removed. All existing `.filter-select`, `.form-field select`, and `.bom-line-row select` rules continue to take precedence through CSS specificity — the new block only fills gaps.

### What was added and why

#### 1. Global `select` baseline

```css
select {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: inherit;
  outline: none;
}
select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}
```

**Why:** Any `<select>` element that does not have a class covered by an existing rule (e.g., some modal selects with no class, or selects added in future) now gets the dark theme automatically. Specificity: `(0,0,1)` — always overridden by class-level rules.

#### 2. `select option` — MOST CRITICAL FIX

```css
select option {
  background-color: #1e1b4b;
  color: #f8fafc;
}
select option:checked {
  background-color: #1e40af;
  color: #ffffff;
}
select option:disabled {
  color: #475569;
  background-color: #1e1b4b;
}
```

**Why:** This is the root cause of the reported Costing Method dropdown issue and ALL other native dropdown option lists appearing white. The `select` element itself can be styled, but the option list rendered by the browser uses OS defaults unless `select option` is explicitly coloured. Must use solid hex colours — `rgba()` on `option` elements has no compositing parent and renders as solid black/transparent.

**Colour choices:**
- `#1e1b4b` = `--eco-panel` (dark indigo-navy, consistent with modal backgrounds)
- `#f8fafc` = `--eco-text` (near-white readable text)
- `#1e40af` = dark blue for selected option (distinct but harmonious with theme)
- `#475569` = slate-500, muted for disabled options (readable but clearly dimmed)

#### 3. `.form-control` — First definition

```css
.form-control {
  width: 100%;
  padding: 9px 12px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text);
  font-size: 0.88rem;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}
.form-control:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-glow);
}
```

**Why:** This class was used in 8 selects and 7 inputs/textareas across 5 modals with zero CSS defined. All rendered with the browser default white background and dark text. Now matches the visual pattern of `.form-field input/select`.

**Selects covered:**
- Stock Count modal: `scCountType`, `scWarehouseId`, `scMode`, `scCategory`
- Manual Hold modal: `mhItemId`
- Approve Count modal: `approveCountAction`
- PO line rows (JS-generated): `poLineItem_${id}`
- Count line table (JS-generated): `cl-rsn-${l.id}`

#### 4. `.bom-line-item` — First definition

```css
.bom-line-item {
  padding: 7px 10px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 0.82rem;
  width: 100%;
  outline: none;
  font-family: inherit;
}
.bom-line-item:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
```

**Why:** JS-generated `addBomLine()` creates `<select class="bom-line-item">` elements dynamically. No CSS existed for this class — all rendered white. Now matches the visual pattern of `.bom-line-row select`.

---

## What Was NOT Changed

| Element | Reason |
|---|---|
| `.filter-select` | Already dark-themed, unchanged |
| `.form-field select` | Already dark-themed, unchanged |
| `.bom-line-row select` | Already dark-themed, unchanged |
| `.search-input` | Input-only, not affected |
| All buttons | Not affected |
| All table styles | Not affected |
| All modal layout | Not affected |
| All business logic | Not touched |

---

## Specificity Analysis — No Conflicts

The new global `select` rule has specificity `(0,0,1)`. Existing rules:

| Rule | Specificity | Overrides global? |
|---|---|---|
| `.filter-select` | `(0,1,0)` | Yes — padding/radius preserved |
| `.form-field select` | `(0,1,1)` | Yes — padding/radius preserved |
| `.bom-line-row select` | `(0,1,1)` | Yes — padding/radius preserved |
| `.form-control` | `(0,1,0)` | Yes — padding/radius overridden |
| `.bom-line-item` | `(0,1,0)` | Yes — padding/radius overridden |

The new `select option` rule is the only rule of its type — no conflicts possible.

---

## Lines Changed

- **Line ~126:** 70 lines of CSS inserted before `/* ── Table ──*/`
- No other lines modified
- Total net change: +70 lines CSS added to `<style>` block
