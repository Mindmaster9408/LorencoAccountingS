# H03 — Step 5: Event Flow Analysis

**Date:** 2026-06-05
**Method:** Static code analysis of custom select IIFE (lines 5884–6202)

---

## Click flow for Costing Method dropdown

### Step 1: User clicks the cs-trigger div

```js
trigger.addEventListener('click', function (e) {
    if (sel.disabled) return;
    e.stopPropagation();                    // prevents document click listener from firing
    if (isOpen()) { close(); } else { closeAll(); open(); }
});
```

- `e.stopPropagation()` is correct — prevents the document-level `closeAll()` from firing
- `closeAll()` closes other open panels first
- `open()` is called

### Step 2: `open()` is called

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

- `buildPanel()` populates `.cs-panel` with `.cs-opt` divs (fresh every open)
- `panel.style.display = 'block'` — panel becomes visible (or would, if not clipped)
- `panel.style.top = 'calc(100% + 3px)'` — positions panel below trigger via CSS calc
- The `requestAnimationFrame` flip check fires after paint

**FINDING: At this point, the panel IS in the DOM and has `display:block`. It is not hidden by JS. The issue is purely CSS rendering/positioning.**

### Step 3: Viewport flip check fires

```js
var r = panel.getBoundingClientRect();
if (r.bottom > window.innerHeight - 8) { ... }
```

- `getBoundingClientRect()` returns the RENDERED bounds of the panel
- If the panel is clipped by `.modal { overflow-y: auto }`, the rendered bounds are the CLIPPED bounds (bottom = modal bottom edge, NOT natural panel bottom)
- `r.bottom` = modal bottom Y, which is well within the viewport
- Condition is FALSE
- Panel stays in clipped state — flip does NOT trigger

### Step 4: Native select

The native `<select>` has:
- `pointer-events: none` (inline style set by `build()`)
- `opacity: 0`
- `width: 1px; height: 1px`

The native select CANNOT be clicked by the user. It cannot produce a native OS popup.

**FINDING: The native popup ONLY appears if the custom select is NOT initialised (e.g., stale deployment without the custom select code).**

---

## MutationObserver flow for dynamic selects

```js
new MutationObserver(function (muts) {
    muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
            if (!n || n.nodeType !== 1) return;
            if (n.tagName === 'SELECT') {
                build(n);
            } else if (n.querySelectorAll) {
                n.querySelectorAll('select').forEach(build);
            }
        });
    });
}).observe(document.body, { childList: true, subtree: true });
```

This catches dynamically added selects (BOM lines, PO lines, count-line rows).

**Potential issue:** If a JS function inserts a `<select>` node and then IMMEDIATELY sets its value or adds options in the same tick, the MutationObserver fires asynchronously. The `build()` call happens after the synchronous JS completes. There's a tiny window where a freshly added select is unwrapped. In practice this is not visible to users.

**No bug found in MutationObserver for static modal selects** (all modal selects are in the HTML at load time and are initialised by the initial `boot()` scan).

---

## Option click flow

```js
item.addEventListener('mousedown', function (e) {
    e.preventDefault();   // stops trigger losing focus
    choose(optIdx);
});
```

```js
function choose(optIdx) {
    var opt = sel.options[optIdx];
    if (!opt || opt.disabled) return;
    _set(sel, opt.value);                             // set native select value
    syncLabel();                                      // update visible label
    sel.dispatchEvent(new Event('change', { bubbles: true }));  // fire onchange
    close();
}
```

This is correct. `mousedown` + `e.preventDefault()` ensures focus stays on trigger. `_set` uses the prototype descriptor (bypasses our own defineProperty, no infinite recursion). `change` event is dispatched — all `onchange=` handlers fire.

**No bug in option selection flow.**

---

## Summary of event flow findings

| Step | Finding |
|---|---|
| Click on trigger | Correct — opens custom panel |
| `open()` called | Correct — panel set to `display:block` |
| Panel visible | **FAIL — panel clipped by `.modal { overflow-y: auto }`** |
| Viewport flip check | **FAIL — getBoundingClientRect() returns clipped bounds; flip doesn't trigger** |
| Option click | Correct (when user can reach panel) |
| change event | Correct (dispatched on selection) |
| Native select popup | Only appears if build() was never called (stale deployment) |
