# Paytime — Fase 0 resultate (2026-10-12)

> Basis: [REGSTELPLAN_2026-10.md](REGSTELPLAN_2026-10.md) Fase 0 · Gemagtig deur Ruan 2026-10-12
> Geen produksie-gedrag is verander nie. Produksie is net gelees.

## 0.1 Produksie-instellings (lees-alleen)

| Item | Bevinding |
|---|---|
| **PAYE-metode wat in produksie loop** | `projection_type_ytd` (afgelei uit die snapshots: Pennygrow, Lorenco Ecosystum, toetsmaatskappy). Zeabur het dus `PAYE_YTD_METHOD=projection_type`. |
| **Globale `tax_config`** | 2026/27-jaar, skale en kortings **grotendeels reg vir 2027** (245 100 … 1 878 600; R17 820 / R9 765 / R3 249). **Twee foute:** (1) skaal 4 se basis is **125 559** (SARS: 125 599) — R40/jaar te min belasting vir belasbare inkomste R530 201–R695 800; (2) mediese krediete is nog **364 / 364 / 246** (SARS 2027: 376 / 376 / 254) — R12–R36/maand te veel PAYE vir elke werknemer met mediese fonds. |
| Maatskappy-spesifieke `tax_config` | 8 maatskappye het eie rye (meeste met ou 2026-tabelle; maatskappy 4 nog "2025/2026"). Die backend ignoreer hulle (globaal wen), maar die frontend-blaaie wat nog die frontend-enjin gebruik, lees dit. |
| Migrasies | Alle nagegaande kolomme bestaan (`payroll_period_inputs.is_taxable`, `payroll_snapshots.source`, omkeer-kolomme, `taxable_percentage`, `uif_exempt`, `voluntary_tax_config`, `is_contractor`, `classification`). |
| Multi-rate in gebruik | 1 inskrywing — Lorenco Ecosystum (40) → word tans R0 betaal [K4]. |
| Direkteure | 1 aktief — Turkstra Bakkery → kry tans UIF = 0; volgens WN-06 moet hy UIF betaal. |
| UIF-vrystelling | 1 — AGS van SA Baillie Park → word geïgnoreer; betaal tans UIF [B9]. |
| Werkgewerbydrae-items | 0 → IT-10 raak tans niemand nie. |
| Lening-items | 2 — Turkstra Bakkery (geen balans word bygehou nie). |
| Aktiewe werknemers sonder belastingnommer | 1. |
| Vertroulike werknemers | 0 (nog nie in gebruik nie). |
| Voluntary PAYE | 3 × Bonus Spread (Bakmeester, R216,66/maand Mrt 2026–Feb 2027, R10 000 bonus — bedrag is korrek, voor die ×12-fout bereken); 3 × Fixed (A en E le Grange Trust ×2, Lorenco Ecosystum ×1). **Geen** "Reduce"- of "Variable"-inskrywings nie → VPA-20 raak niemand nie. |

## 0.2 Goue toetsstel

- Lêers: `backend/tests/golden/` — `fake-supabase.js`, `scenarios.js` (47 scenario's), `run-golden.js`, `golden.test.js`, `baseline.json`.
- Loop deur die **werklike** produksiepad (PayrollDataService → PayrollCalculationService) met 'n in-geheue databasis; elke maand word gesluit voor die volgende.
- Gebruik produksie se metode (`projection_type`) en produksie se globale belastingtabel (met die twee foute hierbo) — die basislyn wys dus presies wat produksie vandag bereken, ook die foute.
- `npm test` faal by **enige** verskil teenoor die basislyn. Basislyn word slegs herskep (`node tests/golden/run-golden.js --update`) nadat 'n fase se verwagte veranderinge bevestig is.

## 0.3 Toetse

- `payroll-overtime-shorttime.test.js` wys nou na die backend-enjin en gebruik die enjin se afgeronde uurtarief → 26/26 slaag (was 23/26).
- Alle nie-databasis payroll-toetse: **15/15 enjin + 125/125 Jest** slaag.

## Nuwe bevindings uit Fase 0

| Kode | Bevinding | Bewys |
|---|---|---|
| **P1** | **`projection_type_ytd` (produksie se metode) belas eenmalige inkomste twee keer.** Die bonus word in sy maand korrek belas, maar die volgende maande se projeksie tel dit weer as "wisselende inkomste" (via `prior_once_off_taxable_gross`) en as deel van vorige belasbare inkomste. | M01: Jan R4 951 / Feb R4 479 in plaas van R2 115 → R5 200 te veel oor die jaar. M03: R15 481 PAYE op 'n R20 000-salaris die maand ná 'n R100 000-bonus. |
| **P2** | **`projection_type_ytd` gee vrywillige ekstra PAYE die volgende maand terug** (`prior_total_paye_paid` sluit vrywillige bedrae in) — teen VPA-10. 'n "Fixed"-ekstra word dus elke maand ongedaan gemaak. | M06: Okt-statutêre PAYE val van R2 115 na R73. |
| **P3** | Globale tabel: skaal-4-basis tikfout (125 559) en ou mediese krediete (364/364/246). | 0.1 hierbo |
| K2 | Begin-in-die-jaar: alle drie bestaande metodes is verkeerd (projection_type: R1 125/maand; average/cumulative: R0, R0 …) teenoor die tabelbedrag R4 681. | M02, M08 |
| K1 (hersien) | Backend-berekeninge gebruik reeds grotendeels die 2027-tabelle (via globale KV). Die kode se eie standaardtabelle en die frontend-blaaie is nog verouderd. | S70, 0.1 |

### Regte werknemer tans geraak deur P1

**Pennygrow, werknemer 260:** R10 000-bonus in Augustus (korrek belas, gesluit). Die **September-draft** wys PAYE **R1 060,41**; onder `cumulative` sou dit **R546,12** wees (dieselfde as sy vorige maande). Verskil **R514,29 te veel**, en dit sou elke maand tot Februarie voortgaan. September is nog nie gefinaliseer nie.

### Vergelyking van die drie bestaande metodes (goue scenario's)

| Scenario | projection_type (produksie) | cumulative | average_taxable |
|---|---|---|---|
| M01 jaar-PAYE (korrek = R30 171,74) | R35 371,74 ❌ | **R30 171,74** ✅ | R30 171,74 ✅ (maar Des/Jan/Feb skuif) |
| M03 Mei ná R100k-bonus | R15 481 ❌ | **R2 115** ✅ | R0 ❌ |
| M02 begin Okt, maand 2 | R1 125 ❌ | R0 ❌ | R0 ❌ |

**Gevolgtrekking:** van die bestaande metodes is `cumulative` die naaste aan reg; dit hanteer bonusse presies. Die probleem met mense wat middel in die jaar begin (K2) bly in al drie metodes, en word in Fase 3 opgelos.
