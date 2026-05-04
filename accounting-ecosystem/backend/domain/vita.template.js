'use strict';

/**
 * vita.template.js — VITA Report Markdown Template
 *
 * All {{PLACEHOLDER}} variables are replaced by vita.engine.js.
 * Edit this file to change report structure without touching engine logic.
 *
 * Variable naming convention:
 *   {{RANKED_CODE}}            — full VITA code string (e.g. "INSIG – PRESTASIE – ...")
 *   {{PRIMARY_LABEL}}          — human label of 1st dimension
 *   {{PRIMARY_VALUES}}         — comma-separated core values
 *   {{PRIMARY_BEHAVIOUR}}      — behaviour description paragraph
 *   {{PRIMARY_STRENGTHS}}      — bulleted strengths list
 *   {{PRIMARY_WEAKNESSES}}     — bulleted weaknesses list
 *   {{SECONDARY_LABEL}}        — 2nd dimension label
 *   {{SECONDARY_VALUES}}       — 2nd dimension values
 *   {{SECONDARY_BEHAVIOUR}}    — 2nd dimension behaviour
 *   {{THIRD_LABEL}}            — 3rd dimension label
 *   {{THIRD_VALUES}}           — 3rd dimension values
 *   {{STRESS_LABEL}}           — 4th dimension label (stress coping)
 *   {{GROWTH_LABEL}}           — 5th dimension label (growth opportunity)
 *   {{SHADOW_LABEL}}           — 6th dimension label (least active / shadow)
 *   {{SHADOW_WEAKNESSES}}      — shadow dimension weakness list
 *   {{VISION_INTERPRETATION}}  — derived from INSIG + INISIATIEF positions
 *   {{PROFILE_PATTERN}}        — named pattern from top-3 combination
 *   {{COMMUNICATION_STYLE}}    — derived communication approach
 *   {{RELATIONSHIP_STYLE}}     — derived relationship approach
 *   {{WORK_ENVIRONMENT}}       — ideal work context
 *   {{ENERGY_GIVERS}}          — what fuels this person
 *   {{ENERGY_DRAINERS}}        — what depletes this person
 *   {{GENERATED_AT}}           — ISO timestamp
 */

const VITA_TEMPLATE = `# VITA Profiel Verslag

**VITA Kode:** {{RANKED_CODE}}

---

## 1. Primêre Dryfkrag — {{PRIMARY_LABEL}}

Jou primêre dryfkrag is **{{PRIMARY_LABEL}}**.

**Kern-waardes:** {{PRIMARY_VALUES}}

**Gedragspatroon:**
{{PRIMARY_BEHAVIOUR}}

**Sterkpunte:**
{{PRIMARY_STRENGTHS}}

**Uitdagings:**
{{PRIMARY_WEAKNESSES}}

---

## 2. Ondersteunende Krag — {{SECONDARY_LABEL}}

Jou ondersteunende krag is **{{SECONDARY_LABEL}}**. Dit werk hand-aan-hand met jou primêre dryfkrag om jou gedrag te vorm.

**Kern-waardes:** {{SECONDARY_VALUES}}

**Gedragspatroon:**
{{SECONDARY_BEHAVIOUR}}

---

## 3. Derde Krag — {{THIRD_LABEL}}

Jou derde krag **{{THIRD_LABEL}}** aktiveer in spesifieke kontekste waar jou eerste twee dryfkragte alleen nie genoeg is nie.

**Kern-waardes:** {{THIRD_VALUES}}

---

## 4. Stres-dimensie — {{STRESS_LABEL}}

Onder volgehoue druk of wanneer jou energie uitgeput is, aktiveer jy **{{STRESS_LABEL}}** as \'n onbewuste copingmeganisme. Dit kan mense verras wat jou normaal goed ken.

---

## 5. Groei-area — {{GROWTH_LABEL}}

Jou groei-area is **{{GROWTH_LABEL}}**. Dit verteenwoordig \'n dimensie wat jy bewustelik kan ontwikkel om jou impak en effektiwiteit aansienlik te verhoog.

---

## 6. Skadu — {{SHADOW_LABEL}}

Jou skadu-dimensie is **{{SHADOW_LABEL}}** — die minste aktiewe deel van jou profiel. Dit verteenwoordig moontlike blinde kolle en beperkings wat onbewustelik jou groei beïnvloed.

**Potensiële blinde kolle:**
{{SHADOW_WEAKNESSES}}

---

## 7. Visie en Toekoms

{{VISION_INTERPRETATION}}

---

## 8. Profiel-patroon

{{PROFILE_PATTERN}}

---

## 9. Kommunikasiestyl

{{COMMUNICATION_STYLE}}

---

## 10. Verhoudingstyl

{{RELATIONSHIP_STYLE}}

---

## 11. Ideale Werkomgewing

{{WORK_ENVIRONMENT}}

---

## 12. Energie-gevers en -drainers

**Gee jou energie:**
{{ENERGY_GIVERS}}

**Dreineer jou energie:**
{{ENERGY_DRAINERS}}

---

*Gegenereer: {{GENERATED_AT}}*
*Hierdie verslag is \'n refleksie-instrument. Dit lei bewustheid — dit definieer nie identiteit nie.*
`;

module.exports = { VITA_TEMPLATE };
