# 05 — Insette per periode

> Status: **KONSEP** · Raak: invoer-bou → enjin → alles stroomaf

## Doel

Alles wat net vir één maand geld — bonus, eenmalige toelae/aftrekking, oortyd, short time, ure teen 'n ander tarief, en bywoning — word in die DB gestoor en bereik die berekening presies soos ingesleutel.

## Reëls

| # | Reël | Status |
|---|---|---|
| PI-01 | Eenmalige insette erf al die eienskappe van hul item (belasbaar, %, UIF, pre-tax, projeksie). Onbekende/vrye-teks-inset = belasbaar, eenmalig, UIF ja, net-only. | ⚠️ `is_taxable`/`tax_treatment` verlore [B1, B2] |
| PI-02 | Oortyd = ure × uurtarief × vermenigvuldiger (1.5 normaal, 2.0 Sondag/openbare vakansiedag). | ✅ |
| PI-03 | Uurtarief = maandsalaris ÷ (weeklikse ure × 4.33); sonder rooster: ÷ 173.33. | ✅ (afronding van uurtarief gee sente-verskille in toetse) |
| PI-04 | Short time = ure × uurtarief, verminder die basiese salaris (en UIF-basis). | ✅ |
| PI-05 | "Multi-rate" = ure × **rand-uurtarief** wat die gebruiker insleutel; tel by bruto, PAYE, UIF. | ❌ Word R0 in die backend, maar wys op die payslip [K4] |
| PI-06 | Insette vir 'n **geslote** periode kan nie bygevoeg/gewysig/verwyder word nie — ook nie via die API nie. | ⚠️ Net die skerm keer dit, nie die backend nie [B3] |
| PI-07 | As enige inset nie gelaai kan word nie, faal die berekening met 'n duidelike fout. | ✅ 2026-10-13 (PI07_LOAD_ERRORS_CHANGE_IMPACT_NOTE.md): laaifout → duidelike fout (run: per werknemer; calculate: 503) [B4 reg] |
| PI-08 | **Bywoning → payroll:** "Apply to Payroll" skep oortyd- en short-time-inskrywings in die DB, gemerk as "uit bywoning", wat die gebruiker kan sien en verwyder. | ✅ Fase 8: voorstel → goedkeur per werknemer → oortyd/short time in die DB, gemerk "from attendance" [V1 reg] |
| PI-09 | Bywoning-oortyd volg BCEA: oortyd is ure bo die werknemer se rooster (maks 45 gewone ure/week), nie bloot "> 8 uur op 'n dag" nie. Betaalde verlof tel nie as afwesigheid nie. | ✅ Fase 8: oortyd bo rooster + 45h/week, Sondag 2×, openbare vakansiedag +1×, verlof/vakansiedae nie afwesig nie |
| PI-10 | Elke inset-verandering word geoudit (wie, wanneer, ou/nuwe waarde). | ⚠️ |

## Regular teenoor Current — hoe dit tans werk (nagegaan 2026-10-12)

| | **Regular inputs** (op die payslip-skerm) | **Current inputs** |
|---|---|---|
| Betekenis | Herhalend — elke maand op die payslip | Net vir hierdie een maand |
| Gestoor in | `employee_payroll_items` (gekoppel aan 'n item) | `payroll_period_inputs` (per periode, **sonder** koppeling aan 'n item — net beskrywing en bedrag) |
| Belasting | Herhalend (geannualiseer) | Eenmalig (ONCE_OFF, tensy die item anders gestel is) |
| Item-instellings | Belasbaar, %, UIF, pre-tax word van die item gelees ✅ | Net UIF en % word gelees; belasbaar en pre-tax gaan verlore ❌ [B1, B2] |

| # | Bevinding | Status |
|---|---|---|
| PI-11 | **"Variable"-regular items** (bv. kommissie): die bedrag wat vir hierdie maand ingesleutel word, word op die werknemer se item self gestoor. Dit geld dus **ook vir volgende maand en daarna**, totdat iemand dit verander. Volgende maand se kommissie is dus outomaties weer verlede maand se bedrag. | ⚠️ Nuut gevind — sien vraag 4 |
| PI-12 | Stoor van current inputs vee eers **al** die maand se insette uit en voeg dan die nuwe lys in. As die invoeging misluk, is al die maand se current inputs weg. | ❌ Nuut gevind |
| PI-13 | As 'n regular item nie in die databasis gestoor kon word nie, wys die skerm dit tog op die payslip (net plaaslik gestoor) — die berekening op die backend sien dit nie. | ❌ Nuut gevind |

## Beantwoord deur Ruan (2026-10-12)

| # | Besluit |
|---|---|
| PI-05 | **Multi-rate (opsie a):** die gebruiker sleutel 'n **rand-uurtarief** in; bedrag = ure × daardie tarief. |
| PI-08 | **Bywoning (opsie b):** oortyd en afwesighede uit bywoning word as **voorstel** gewys wat die payroll-persoon goedkeur voordat dit op die payslip kom. Dit geld **slegs** vir maatskappye wat die bywoningsdeel gebruik; ander maatskappye sien niks daarvan nie. |
| PI-11 | **Variable-items (opsie a):** die bedrag gaan **elke periode terug na R0**. Die gebruiker sleutel elke periode die nuwe bedrag in; 'n bedrag van verlede maand word nooit outomaties weer betaal nie. |

## ❓ Oop vraag

1. Openbare vakansiedae: moet die stelsel SA se vakansiedae ken en Sondag-/vakansiedagtariewe outomaties voorstel?
