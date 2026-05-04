'use strict';

/**
 * vita.template.js — VITA Report Markdown Template (Full Premium Edition)
 *
 * All {{PLACEHOLDER}} variables are replaced by vita.engine.js.
 * Edit this file to change report structure without touching engine logic.
 *
 * Variable index:
 *   {{CLIENT_NAME_LINE}}       — "**Kliënt:** Name\n" or "" if anonymous
 *   {{RANKED_CODE}}            — full VITA code string (em-dash separated)
 *   {{VITA_DATE}}              — formatted date (af-ZA locale)
 *   {{INTRODUCTION}}           — what VITA is and what the code means
 *   {{CODE_EXPLANATION}}       — derived explanation of top-3 combination
 *   {{PRIMARY_LABEL}}          — 1st dimension label
 *   {{PRIMARY_VALUES}}         — comma-separated core values
 *   {{PRIMARY_BEHAVIOUR}}      — behaviour description
 *   {{PRIMARY_STRENGTHS}}      — bullet list
 *   {{PRIMARY_WEAKNESSES}}     — bullet list
 *   {{SECONDARY_LABEL}}        — 2nd dimension label
 *   {{SECONDARY_VALUES}}       — 2nd dimension values
 *   {{SECONDARY_BEHAVIOUR}}    — 2nd dimension behaviour
 *   {{SECONDARY_STRENGTHS}}    — bullet list
 *   {{SECONDARY_WEAKNESSES}}   — bullet list
 *   {{THIRD_LABEL}}            — 3rd dimension label
 *   {{THIRD_VALUES}}           — 3rd dimension values
 *   {{THIRD_BEHAVIOUR}}        — 3rd dimension behaviour
 *   {{THIRD_STRENGTHS}}        — bullet list
 *   {{STRESS_LABEL}}           — 4th dimension label
 *   {{STRESS_TEXT}}            — stress context paragraph
 *   {{GROWTH_LABEL}}           — 5th dimension label
 *   {{GROWTH_TEXT}}            — growth advice paragraph
 *   {{SHADOW_LABEL}}           — 6th dimension label
 *   {{SHADOW_WEAKNESSES}}      — bullet list (blind spots)
 *   {{STRENGTHS_SUMMARY}}      — top-3 combined strengths
 *   {{TRIGGERS}}               — what energizes (top-2 derived)
 *   {{TRIPWIRES}}              — what drains (primary + shadow derived)
 *   {{COMMUNICATION_STYLE}}    — derived from primary driver
 *   {{COMM_TIPS}}              — how to communicate with each type
 *   {{RELATIONSHIP_STYLE}}     — derived from love/emotion positions
 *   {{WORK_ENVIRONMENT}}       — ideal work context
 *   {{ENERGY_GIVERS}}          — bullet list
 *   {{ENERGY_DRAINERS}}        — bullet list
 *   {{PROFILE_PATTERN}}        — named pattern + description
 *   {{VISION_INTERPRETATION}}  — derived from Insig/Inisiatief positions
 *   {{REFLECTION_QUESTIONS}}   — 5 ranked reflection prompts
 *   {{NEXT_STEP}}              — coaching call to action
 *   {{GENERATED_AT}}           — ISO timestamp
 */

const VITA_TEMPLATE = `# VITA Profiel Verslag

{{CLIENT_NAME_LINE}}**VITA Kode:** {{RANKED_CODE}}
**Datum:** {{VITA_DATE}}

---

## Inleiding

{{INTRODUCTION}}

---

## Jou VITA Kode

{{CODE_EXPLANATION}}

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

Jou ondersteunende krag is **{{SECONDARY_LABEL}}**. Dit werk hand-aan-hand met jou primêre dryfkrag om jou gedrag en besluitneming te vorm.

**Kern-waardes:** {{SECONDARY_VALUES}}

**Gedragspatroon:**
{{SECONDARY_BEHAVIOUR}}

**Sterkpunte:**
{{SECONDARY_STRENGTHS}}

**Uitdagings:**
{{SECONDARY_WEAKNESSES}}

---

## 3. Derde Dimensie / Verborge Potensiaal — {{THIRD_LABEL}}

Jou derde krag **{{THIRD_LABEL}}** aktiveer in spesifieke kontekste waar jou eerste twee dryfkragte alleen nie genoeg is nie. Dit is dikwels \'n bron van onontginde potensiaal.

**Kern-waardes:** {{THIRD_VALUES}}

**Gedragspatroon:**
{{THIRD_BEHAVIOUR}}

**Sterkpunte:**
{{THIRD_STRENGTHS}}

---

## 4. Stres-dimensie — {{STRESS_LABEL}}

{{STRESS_TEXT}}

---

## 5. Groei-area — {{GROWTH_LABEL}}

{{GROWTH_TEXT}}

---

## 6. Skadu / Laagste Dimensie — {{SHADOW_LABEL}}

Jou skadu-dimensie **{{SHADOW_LABEL}}** is die minste aktiewe deel van jou profiel. Dit verteenwoordig moontlike blinde kolle en beperkings wat onbewustelik jou groei beïnvloed.

**Potensiële blinde kolle:**
{{SHADOW_WEAKNESSES}}

---

## 7. Sterkpunte Opsomming

Jou top-3 dryfkragte lewer saam die volgende sterkpunte:

{{STRENGTHS_SUMMARY}}

---

## 8. Triggers — Wat Gee Jou Energie

Hierdie is die omstandighede, aktiwiteite en situasies wat jou laai en motiveer:

{{TRIGGERS}}

---

## 9. Tripwires — Wat Dreineer Jou

Hierdie is die omstandighede wat jou energie roof en jou minder effektief maak:

{{TRIPWIRES}}

---

## 10. Kommunikasiestyl

{{COMMUNICATION_STYLE}}

---

## 11. Kommunikasiewenke per Dimensie

Hoe om effektief te kommunikeer met mense wie se primêre dryfkrag verskil van joune:

{{COMM_TIPS}}

---

## 12. Verhoudingsinsig

{{RELATIONSHIP_STYLE}}

---

## 13. Werk- en Besigheidsinsig

{{WORK_ENVIRONMENT}}

---

## 14. Energie-patroon

**Gee jou energie:**
{{ENERGY_GIVERS}}

**Dreineer jou energie:**
{{ENERGY_DRAINERS}}

---

## 15. Profiel-patroon

{{PROFILE_PATTERN}}

---

## 16. Visie en Toekoms

{{VISION_INTERPRETATION}}

---

## 17. Refleksie Vrae

Gebruik hierdie vrae as \'n persoonlike refleksie-oefening:

{{REFLECTION_QUESTIONS}}

---

## 18. Volgende Stap

{{NEXT_STEP}}

---

*Gegenereer: {{GENERATED_AT}}*
*Hierdie verslag is \'n refleksie-instrument. Dit lei bewustheid — dit definieer nie identiteit nie.*
`;

module.exports = { VITA_TEMPLATE };
