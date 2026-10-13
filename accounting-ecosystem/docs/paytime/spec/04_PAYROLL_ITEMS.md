# 04 — Payroll-items (verdienste en aftrekkings)

> Status: **KONSEP** · Raak: belasbare inkomste, UIF-basis, PAYE-projeksie, IRP5-kodes → EMP501

## Doel

Elke item (salaris, toelae, bonus, kommissie, pensioen, mediese fonds, ens.) dra sy eie belastinggedrag, sodat die enjin dit outomaties reg hanteer — maak nie saak of dit 'n herhalende of 'n eenmalige inset is nie.

## Item-eienskappe (wat elke item moet hê)

| Eienskap | Betekenis | Voorbeeld |
|---|---|---|
| Tipe | verdienste / aftrekking / werkgewerbydrae / byvoordeel | Reistoelae = verdienste |
| Belasbaar | ja/nee | Terugbetaalde uitgawes = nee |
| Belasbare % | deel wat belas word | Reistoelae 80% |
| UIF-van-toepassing | ja/nee | |
| Belastinghantering (aftrekkings) | pre-tax (verminder belasbare inkomste) / net-only | Pensioen = pre-tax |
| PAYE-projeksie | vas-herhalend / wisselend / eenmalig | Bonus = eenmalig |
| IRP5-kode | 4-syfer SARS-bronkode | Kommissie 3606 |

## Reëls

| # | Reël | Status |
|---|---|---|
| IT-01 | Al die eienskappe hierbo geld vir **herhalende** items én **eenmalige periode-insette** van dieselfde item. | ⚠️ Eenmalige insette verloor `is_taxable` en `tax_treatment` [B1, B2] |
| IT-02 | Items word deur 'n vaste ID gekoppel, nie deur die naam nie (hernoem mag nie die koppeling breek nie). | ❌ Koppeling via kleinletter-naam |
| IT-03 | 'n Verandering aan 'n item se instellings geld vanaf die volgende ongeslote periode; geslote periodes bly onaangeraak. | ✅ (snapshots is bevries) |
| IT-04 | IRP5-kode word gevalideer teen SARS se lys bronkodes en moet by die itemtipe pas (verdienste-kode vir verdienste, ens.). | ⚠️ Net formaat (4–6 syfers) |
| IT-05 | Geen item kan in 'n payroll gebruik word sonder 'n IRP5-kode nie (waarskuwing in die run; blok by EMP501). | 🆕 |
| IT-06 | Pre-tax aftrekkings vir aftreefondse word beperk tot 27.5% van remunerasie / R350 000 per jaar (art. 11F). | 🆕 |
| IT-07 | Byvoordele (maatskappymotor, werkgewer se mediese bydrae, werkgewer se aftreefondsbydrae) word as belasbare nie-kontant inkomste hanteer (Sewende Bylae). | 🆕 |
| IT-08 | Persentasie-items (bv. 10% van basies) word teen die (pro-rata) basiese salaris bereken. | ✅ |
| IT-09 | Item-instellings word slegs in die DB gestoor (`payroll_items_master`), nie KV nie. | ⚠️ KV-terugval bestaan nog |

## Hoe dit tans werk (nagegaan 2026-10-12)

**Skerm *Payroll Items*** (`payroll-items.html`): 'n item het 'n kode, naam, **tipe** (income / allowance / deduction / employer_contribution), IRP5-kode (verpligtend op die skerm), **kategorie** (vaste bedrag / persentasie / lening gegee / lening terugbetaal / uur-gebaseer), standaardbedrag, belasbaar ja/nee, UIF ja/nee, belasbare %, belastinghantering (net vir aftrekkings), PAYE-projeksietipe (net vir verdienste), **"wys in"** (Regular / Once-off / Albei) en **maandgedrag** (Fixed — dieselfde elke maand / Variable — verander elke maand).

**Twee tabelle:** die skerm stoor in `payroll_items_master` (met die IRP5-kode). Wanneer 'n item aan 'n werknemer gekoppel word, word 'n tweede rekord in `payroll_items` geskep of gevind — **gekoppel net deur die naam** — en die werknemer se rekord (`employee_payroll_items`) wys daarna.

| # | Bevinding | Status |
|---|---|---|
| IT-10 | Tipe **employer_contribution** word by toewysing as "earning" (verdienste) gestoor. Die enjin tel dit dus by bruto, belasbare inkomste **en netto** — die werknemer kry die werkgewer se bydrae as kontant uitbetaal. | ✅ Reggestel 2026-10-13 (IT10_EMPLOYER_CONTRIBUTIONS_CHANGE_IMPACT_NOTE.md): nooit in bruto/netto nie; belasbare deel by belasbare inkomste + SDL, nie UIF nie; lyn onder werkgewer. Geen lewendige items van hierdie tipe nie |
| IT-11 | Kategorieë **lening gegee / lening terugbetaal** hou geen balans by nie; 'n leningterugbetaling stop nooit vanself wanneer die lening afbetaal is nie. | ❌ Nuut gevind |
| IT-12 | Kategorie **uur-gebaseer** het geen ure × tarief-berekening nie; dit word as 'n gewone bedrag hanteer. | ❌ Nuut gevind |
| IT-13 | Twee itemtabelle wat net deur die naam gekoppel is: hernoem 'n item, en die werknemers se bestaande toewysings verloor hul instellings (UIF, %, belasbaar) en IRP5-kode. | ❌ (sien IT-02) |

## Beantwoord deur Ruan (2026-10-12)

| # | Besluit |
|---|---|
| IT-10 | **Werkgewerbydraes (opsie a):** word **nooit** aan die werknemer uitbetaal nie. Dit verskyn op die payslip onder "Werkgewerbydraes". Waar SARS dit as 'n belasbare byvoordeel sien (bv. werkgewer se pensioen- of mediese bydrae), word dit by belasbare inkomste getel maar **nie** by netto nie. |
| IT-11 | **Lenings:** Paytime hou die leningsbalans by (gegee, terugbetaal, uitstaande). Die terugbetaling stop vanself wanneer die balans 0 is; die laaste paaiement word verminder tot die uitstaande balans. Die **werkgewer kies** per maatskappy (of per lening) of die balans op die payslip gewys word. |
| IT-12 | **Uur-gebaseerde items — twee opsies per item:** **(1) Vermenigvuldiger** van die werknemer se eie uurtarief (bv. oortyd × 1.5, Sondag × 2, of enige ander faktor), of **(2) 'n spesifieke rand-uurtarief** wat die gebruiker insleutel. Voorbeeld van (2): 'n werker se eie tarief is R17,50/uur, maar hy doen 'n ander werker se werk en word vir daardie ure teen R20,50/uur betaal. Bedrag = ure × tarief. Die tarief wat gebruik is, word in die snapshot bevries, sodat 'n latere tariefverandering nie 'n ou payslip verander nie. |
| IT-14 | **Reistoelae (BEVESTIG deur Ruan 2026-10-12):** PAYE **en UIF** word slegs op die belasbare 80% bereken. Nagegaan 2026-10-12 sonder kode-verandering: ✅ werk korrek vir regular en current inputs (goue scenario's S12a/S12b: R10 000 + R5 000 → UIF-basis R14 000, UIF R140). |
| IT-15 | **SDL op reistoelae:** SDL behoort ook net op die 80% te wees (die deel wat by "remuneration" ingesluit word). ❌ Tans word SDL op die volle bedrag bereken (S12a: R150 in plaas van R140). Word saam met Fase 2 reggestel. |
| IT-12a | Oortyd, multi-rate (PI-05) en uur-gebaseerde items gebruik **dieselfde** onderliggende berekening (ure × [eie tarief × faktor] of ure × [vaste rand-tarief]), sodat hulle nooit verskillende antwoorde vir dieselfde ure kan gee nie. |

## ❓ Oop vrae

1. Byvoordele (IT-07) en die 27.5%-limiet (IT-06): nou bou, of eers ná die foute reggemaak is?
2. Item **sonder** IRP5-kode: blokkeer die payroll, of net waarsku tot by jaareinde?
3. ~~Uur-gebaseerde tarief~~ → **BEANTWOORD 2026-10-12:** albei opsies — vermenigvuldiger van eie tarief, of 'n spesifieke rand-tarief (IT-12).
