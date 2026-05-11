# BASIS Report Engine — Structure, Scoring & Editable Logic
**Date:** 2026-04-29  
**Status:** Pending Implementation  
**Protocol:** Full Lorenco Master Protocol — audit mandatory before any change

---

## ROLE AND EXECUTION RULES

Use full Lorenco Master Protocol — do NOT skip audit.

---

## CRITICAL CONTEXT

Current state:

- `basis_answers` stored as flat JSON: `{ "BALANS_1": 7, "AKSIE_1": 3, ... }`
- `basis_results` exists but is loosely structured
- `report_generated` stores markdown snapshot
- `report_editable` overlays certain sections

**Missing:**
- No formal definition of what questions belong to what section
- No definition of what each question means
- No defined scoring calculation
- No defined interpretation derivation

This makes the system:
- Inconsistent
- Not extensible
- Not explainable
- Not controllable

---

## OBJECTIVE

Create a **structured, deterministic BASIS ENGINE** that defines:

1. Question structure
2. Section grouping
3. Scoring model
4. Interpretation rules
5. Report build pipeline

**Without breaking:**
- Existing submissions
- Existing report generation
- Existing UI

---

## SCOPE OWNERSHIP

### This Coder Owns
- BASIS engine logic (new module)
- Scoring + interpretation structure
- Safe integration into `basis.routes.js`
- Report generation wrapper

### This Coder Must NOT Modify
- UI rendering files
- Existing `generateBASISReport()` logic directly
- Client storage system
- Unrelated routes

### Shared Interface to Preserve
- `basis_answers` format (flat JSON)
- `report_generated` structure
- `report_editable` merge behaviour

---

## STEP 1 — AUDIT (MANDATORY)

Audit the following before any code changes:

| File | What to Audit |
|------|---------------|
| `js/client-assessment.js` | How answers are structured |
| `js/basis-report-ui.js` | How report is rendered |
| `generateBASISReport()` | Current logic |
| `basis_submissions` table | Data fields |

**Document:**
- How sections are currently inferred
- How scoring is currently done (if at all)
- Where logic is duplicated or missing
- What assumptions exist

---

## STEP 2 — CREATE STRUCTURED CONFIG (CORE FIX)

**Create new file:** `backend/domain/basis.config.js`

This is the **single source of truth**.

```js
export const BASIS_STRUCTURE = {
  sections: {
    BALANS: {
      name: "Balance",
      questions: ["BALANS_1", "BALANS_2", "BALANS_3"],
      meaning: "How stable and balanced the client feels"
    },
    AKSIE: {
      name: "Action",
      questions: ["AKSIE_1", "AKSIE_2"],
      meaning: "Execution and movement toward goals"
    }
  },

  scoring: {
    min: 1,
    max: 10,
    method: "average" // or sum if needed later
  },

  interpretation: {
    high: {
      threshold: 7,
      label: "Strong",
      description: "This area is a strength"
    },
    medium: {
      threshold: 4,
      label: "Moderate",
      description: "This area needs refinement"
    },
    low: {
      threshold: 0,
      label: "Weak",
      description: "This area requires focus"
    }
  }
};
```

---

## STEP 3 — BUILD SCORING ENGINE

**Create new file:** `backend/domain/basis.engine.js`

### Required Functions

#### 1. `calculateSectionScores(answers)`

Returns:

```js
{
  BALANS: { score: 6.5, level: "medium" },
  AKSIE:  { score: 8.2, level: "high"   }
}
```

#### 2. `determineLevel(score)`

Uses thresholds from config.

#### 3. `rankSections(sectionScores)`

Returns sorted array (highest → lowest).

#### 4. `buildResultsObject(answers)`

Returns:

```js
{
  sectionScores,
  ranking,
  generatedAt: new Date().toISOString()
}
```

---

## STEP 4 — SAFE BACKEND INTEGRATION

**Modify:** `backend/routes/basis.routes.js`

When a submission is created or updated:

```js
const results = buildResultsObject(basis_answers);

// UPDATE basis_submissions
// SET basis_results = results
```

---

## STEP 5 — REPORT GENERATION WRAPPER

**Do NOT rewrite `generateBASISReport()`.**

Wrap it:

```js
function buildClientLikeObject(submission) {
  return {
    name:         submission.respondent_name,
    basisAnswers: submission.basis_answers,
    basisResults: submission.basis_results
  };
}

const report = generateBASISReport(clientLikeObject);
```

Store:

```js
report_generated = {
  markdown:    report,
  generatedAt: new Date().toISOString()
};
```

---

## STEP 6 — DO NOT BREAK EDITABLE SYSTEM

Maintain:

```sql
report_editable || new_values
```

Rules:
- Never overwrite system sections
- Only merge allowed editable keys

---

## STEP 7 — TESTS (MANDATORY)

| # | Test Case | Expected Outcome |
|---|-----------|-----------------|
| 1 | Missing answers | No crash |
| 2 | Partial answers | Still calculates |
| 3 | All answers | Correct averages |
| 4 | Ranking | Correct order |
| 5 | Thresholds | High / Medium / Low correct |
| 6 | Old submissions (no results) | Still render |
| 7 | New submission | Results auto-generated |
| 8 | Report render | Unchanged from current |

---

## STEP 8 — CHANGE SAFETY

This implementation:

- ❌ Does NOT change DB schema
- ❌ Does NOT change API contracts
- ❌ Does NOT break UI
- ✅ ONLY ADDS structure + determinism

---

## FINAL OUTCOME

After this task is complete:

- ✅ Questions are structured
- ✅ Meaning is defined
- ✅ Scoring is deterministic
- ✅ Reports are explainable
- ✅ System becomes extensible
- ✅ Future program matching becomes possible

---

## NEXT PHASE (NOT NOW)

After this is stable:

- Program recommendation engine
- Quotation logic
- Auto-coaching insights
