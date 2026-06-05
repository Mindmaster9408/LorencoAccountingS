# H03 — Step 2: DOM Inspection (Code-Based Analysis)

**Date:** 2026-06-05
**Method:** Static analysis of `frontend-inventory/index.html` (6202 lines after build-marker addition)

---

## Select inventory in the DOM

Total `<select>` elements found in `index.html`: confirmed present across modals, toolbars, and JS-generated rows.

Key selects in scope for this investigation:

| ID | Location | Class | Context |
|---|---|---|---|
| `iItemType` | `#itemModal` > `.form-field` | none | Add Stock Item modal |
| `iUnit` | `#itemModal` > `.form-field` | none | Add Stock Item modal |
| `iWarehouse` | `#itemModal` > `.form-field` | none | Add Stock Item modal |
| `iCostingMethod` | `#itemModal` > `.form-field` | none | Add Stock Item modal — **the reported failing dropdown** |
| `mItem`, `mType`, `mWarehouse` | `#movementModal` | none | Movement modal |
| `filter-select` selects | toolbar (outside modal) | `filter-select` | Main page, no modal |
| BOM component selects | `addBomLine()` | `bom-line-item` | Dynamically generated |

---

## Custom select wrapper status (from code)

The custom select IIFE runs on `DOMContentLoaded` via:

```js
function boot() {
    document.querySelectorAll('select').forEach(build);
    ...
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
```

**All `<select>` elements present in the HTML at page load time (including those inside hidden modals) ARE included in the initial `querySelectorAll('select')` call.** They receive the `build()` function immediately. The `_cs` guard prevents double-init.

### What `build()` does to `#iCostingMethod`

1. `sel._cs = true` — marks element as already-initialised
2. Creates `<div class="cs-wrap cs-block">` before the select in DOM; moves select inside
3. Sets inline styles on the native select: `position:absolute; opacity:0; pointer-events:none; width:1px; height:1px; overflow:hidden`
4. Creates `<div class="cs-trigger cs-sz-form">` with label + arrow spans, appended inside wrap
5. Creates `<div class="cs-panel">` appended inside wrap
6. Intercepts `sel.value` setter via `Object.defineProperty`
7. Sets up `MutationObserver` per-select for option reinjection
8. Calls `syncLabel()` to set initial label

**Expected DOM structure after `build()` runs on `#iCostingMethod`:**

```html
<div class="form-field">
  <label>Costing Method</label>
  <div class="cs-wrap cs-block">          ← wrapper (position:relative)
    <select id="iCostingMethod"           ← native (hidden, pointer-events:none)
      style="position:absolute; opacity:0; pointer-events:none; width:1px; height:1px; overflow:hidden">
      <option value="average">Weighted Average</option>
      <option value="fifo">FIFO</option>
      <option value="standard">Standard</option>
    </select>
    <div class="cs-trigger cs-sz-form">   ← visible trigger button
      <span class="cs-label">Weighted Average</span>
      <span class="cs-arrow">▾</span>
    </div>
    <div class="cs-panel">               ← dropdown panel (display:none until open)
      <!-- options rendered here on open -->
    </div>
  </div>
</div>
```

---

## console commands to run in live browser

```js
// 1. How many native selects?
document.querySelectorAll('select').length

// 2. How many custom wrappers?
document.querySelectorAll('.cs-wrap').length
document.querySelectorAll('.cs-trigger').length
document.querySelectorAll('.cs-panel').length

// 3. Is #iCostingMethod wrapped?
document.getElementById('iCostingMethod')._cs    // expected: true
document.getElementById('iCostingMethod').closest('.cs-wrap')  // expected: div.cs-wrap

// 4. Is native hidden?
getComputedStyle(document.getElementById('iCostingMethod')).pointerEvents  // expected: 'none'
getComputedStyle(document.getElementById('iCostingMethod')).opacity        // expected: '0'

// 5. After opening the Add Item modal and clicking Costing Method:
document.querySelector('#itemModal .cs-panel').style.display   // expected: 'block'
document.querySelector('#itemModal .cs-panel').getBoundingClientRect()     // check position
```

---

## Expected vs likely actual result

If build marker confirms live file is current, and `_cs = true` is confirmed, the custom select IS active. The problem is then NOT "select not wrapped" — it is the RENDERING/POSITIONING of the panel.

See `04_root_cause.md` for the confirmed rendering failure cause.
