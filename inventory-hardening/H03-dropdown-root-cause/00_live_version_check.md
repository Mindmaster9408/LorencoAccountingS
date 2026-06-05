# H03 — Step 1: Live Version Check

**Date:** 2026-06-05
**Task:** Verify whether the live deployed file matches the local source.

---

## Build Marker Status

**Before this session:** NO build marker existed in `frontend-inventory/index.html`.

This is a finding in itself. Without a marker, there is no way to confirm from the browser console whether Zeabur is serving the latest source or a cached older version.

**Action taken (this session):**

Added to `frontend-inventory/index.html` at line 1786 (first line inside the `<script>` tag):

```js
window.STOREHOUSE_UI_BUILD = 'H03-forensic-d80e1d9';
```

---

## How to verify after next deploy

1. Open: `https://lorenco.zeabur.app/inventory`
2. Open browser DevTools → Console tab
3. Type: `window.STOREHOUSE_UI_BUILD`
4. Expected: `'H03-forensic-d80e1d9'`

### If result is `'H03-forensic-d80e1d9'` → LIVE FILE IS CURRENT
Proceed to DOM inspection. The custom select code IS in the deployed file.

### If result is `undefined` or another value → STALE FILE
Zeabur is serving a cached version. Steps:
1. Go to Zeabur dashboard → service → Redeploy without cache
2. Hard-refresh browser (Ctrl+Shift+R)
3. Verify again

---

## What commit is expected to be live

Last commit touching `frontend-inventory/index.html`:

```
d80e1d9 fix(storehouse): H02-B hardened custom select — keyboard nav, focus guard, no duplicate wrappers
```

This commit added the full custom select IIFE (lines 5884–6196) and the cs-* CSS block (lines 338–387).

---

## Verification status (at time of forensic investigation)

Cannot test live app from code analysis alone. Marker has been added. Ruan must confirm in browser console after next push.

**Risk:** If the live file is stale, ALL CSS and JS fixes since the last successfully cached deploy are NOT live. The native white popup would still appear regardless of any code change.
