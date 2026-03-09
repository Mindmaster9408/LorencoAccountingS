# Date Parsing Standardization - Phase 5 Implementation Plan

## Summary
Standardize all date parsing and formatting across the ecosystem to ensure browser compatibility (especially Safari, Firefox on mobile). Replace 100+ unsafe `new Date(string)` calls with `parseStandardDate()` utility.

---

## Replacement Strategy

### Priority 1: High-Risk Display Formatting (15+ instances)
These directly affect visible data and have browser inconsistencies:

```javascript
// ❌ UNSAFE: Locale-dependent output varies by browser
new Date(company.created_date).toLocaleDateString()
→ ✅ SAFE: formatDate(parseStandardDate(company.created_date), 'ZA')

// ❌ UNSAFE: toLocaleString inconsistent across browsers
new Date(entry.timestamp).toLocaleString()
→ ✅ SAFE: formatDateTime(parseStandardDate(entry.timestamp))

// ❌ UNSAFE: ISO string parsing naive
new Date().toISOString().slice(0,10)
→ ✅ SAFE: formatDate(new Date(), 'ISO')  // or getTodayISO()
```

### Priority 2: Internal Data Processing (Safe, but standardize)
These are safe but should use utilities for consistency:

```javascript
// Already safe (current date): NO CHANGE
new Date()

// Already safe (ISO timestamps): NO CHANGE
new Date().toISOString()

// Safe timestamp comparisons: NO CHANGE
new Date(date1).getTime() - new Date(date2).getTime()

// Date construction from components: ALREADY SAFE
new Date(year, month - 1, day)  // Note: months are 0-indexed
```

### Priority 3: Parse string dates (7 instances)
Backend date parsing engine already handles this:

```javascript
// Backend: transaction-normalizer.js parseDate(value)
// Already handles: ISO, DD/MM/YYYY, DD-MM-YYYY, DD/MM/YY, Excel dates
```

---

## Target Files for Replacement

### Phase 5A: Frontend Display (High Priority)
1. **Payroll_App/employee-detail.html** (10+ instances)
   - Line 1715: `new Date().toLocaleDateString()` 
   - Line 1943: `d.toLocaleDateString() + ' ' + d.toLocaleTimeString()`
   - Company created dates

2. **Payroll_App/reports.html** (5+ instances)
   - Line 1183, 1215: `new Date(l.timestamp).toLocaleString()`
   - Line 1499: PDF generation timestamp

3. **Payroll_App/company-selection.html** (2 instances)
   - Line 340: `new Date(company.created_date).toLocaleDateString()`

4. **Payroll_App/super-admin-dashboard.html** (3 instances)
   - Lines 575, 620: Company created dates

5. **Payroll_App/historical-import.html** (2 instances)
   - Line 1655: `date.toLocaleDateString() + ' ' + date.toLocaleTimeString()`

6. **Coaching app** (10+ instances in js/journey-helpers.js, etc)
   - `new Date(msg.timestamp).toLocaleTimeString('en-ZA', ...)`
   - `new Date().toISOString().split('T')[0]` for filenames

7. **Ecosystem Frontend** (5+ instances)
   - Line 2087 (dashboard.html): `new Date(f.granted_at).toLocaleDateString('en-ZA')`
   - Line 681 (admin.html): Company created dates

8. **SEAN webapp** (5+ instances in TypeScript)
   - Allocations page: `new Date(tx.date).toLocaleDateString("en-ZA")`

### Phase 5B: Utility Calls (For Consistency)
Replace backend date serialization patterns:
```javascript
// Already safe, but use utility:
new Date().toISOString() → getTodayISO() when datestring needed
new Date().toISOString() → window.formatDate(new Date(), 'ISO')
```

---

## Implementation Approach

### Step 1: Ensure Utilities Loaded
✅ **Already deployed** in all apps:
- `shared/js/polyfills.js` (all apps inherit)
- `Payroll_App/js/polyfills.js` (local copy)
- Each app's polyfills.js

### Step 2: Identify and Replace Display Formatting
Focus on: `toLocaleDateString()`, `toLocaleString()`, `toLocaleTimeString()`

**Replacement mapping:**
| Pattern | Replace With | Notes |
|---------|--------------|-------|
| `new Date(x).toLocaleDateString()` | `formatDate(parseStandardDate(x), 'ZA')` | ZA format: DD/MM/YYYY |
| `new Date(x).toLocaleString()` | `formatDateTime(parseStandardDate(x))` | Includes time |
| `new Date(x).toLocaleTimeString(...)` | `formatDate(..., 'ZA').split('/').pop() + ' ' + hours:mins` | Time only |
| `new Date().toISOString().slice(0,10)` | `formatDate(new Date(), 'ISO')` | For filenames/storage |
| `new Date().toLocaleDateString()` | `formatDate(new Date(), 'ZA')` | Current date display |

### Step 3: Test & Validate
- Verify date displays in Chrome, Safari, Firefox, Edge
- Test timezone edge cases (March DST transitions, year boundaries)
- Verify payroll dates appear correctly

### Step 4: Commit & Document
- Single commit per app/section
- Document which patterns were replaced
- Link to DATA_PERSISTENCE_POLICY.md and PHASE4_DATA_STORAGE_AUDIT.md

---

## Files to Update (Execution Order)

**Batch 1 - Payroll Core (Highest Impact):**
1. Payroll_App/employee-detail.html (10 instances)
2. Payroll_App/reports.html (5 instances)
3. Payroll_App/company-selection.html (2 instances)
4. Payroll_App/super-admin-dashboard.html (3 instances)
5. Payroll_App/historical-import.html (2 instances)

**Batch 2 - Coaching & Streaming:**
6. Coaching app/js/journey-helpers.js (8 instances)
7. Coaching app/js/admin-panel.js (1 instance)

**Batch 3 - Ecosystem:**
8. accounting-ecosystem/frontend-ecosystem/dashboard.html (1 instance)
9. accounting-ecosystem/frontend-ecosystem/admin.html (1 instance)

**Batch 4 - SEAN TypeScript:**
10. sean-webapp/app/allocations/page.tsx (2 instances)

---

## Utilities Reference

All utilities available globally after polyfills load:

```javascript
// Parse dates safely (handles ISO, DD/MM/YYYY, DD-MM-YYYY, DD/MM/YY, Excel)
window.parseStandardDate(dateString)
→ Returns: Date object or null

// Format dates with locale awareness
window.formatDate(date, format)
→ Formats: 'ISO' (YYYY-MM-DD), 'ZA' (DD/MM/YYYY), 'US' (MM/DD/YYYY), 'UK' (DD-MM-YYYY)

// Format with time
window.formatDateTime(date)
→ Returns: DD/MM/YYYY HH:MM

// Get today in ISO format
window.getTodayISO()
→ Returns: YYYY-MM-DD string
```

---

## Validation Checklist

- [ ] All 50+ toLocaleDateString() calls replaced
- [ ] All 20+ toLocaleString() calls replaced  
- [ ] All new Date(string).toISOString().slice(0,10) patterns replaced
- [ ] Test in Chrome (Windows/Mac/Android)
- [ ] Test in Safari (Mac/iOS)
- [ ] Test in Firefox (Windows/Mac/Linux)
- [ ] Test in Edge
- [ ] Verify payroll dates display correctly
- [ ] Verify accounting period dates display correctly
- [ ] Verify timestamps in logs/reports display correctly
- [ ] Check month boundary dates (Feb 28/29, etc)
- [ ] Check year boundary dates (Dec 31/Jan 1)
- [ ] Verify DST transition dates (March/October/November)
- [ ] All commits pushed to main with descriptive messages

---

## Status: READY FOR IMPLEMENTATION
