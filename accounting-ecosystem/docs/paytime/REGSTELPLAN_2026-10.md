# Paytime — Stap-vir-stap regstelplan (Oktober 2026)

> Opgestel: 2026-10-12 · Basis: oudit van 2026-10-12 · Status: **WAG OP RUAN** (spesifikasie bevestig + magtiging per fase)
> Paytime is stability-locked (CLAUDE.md Part E): elke fase vereis Ruan se uitdruklike magtiging, 'n Change Impact Note, en die regressiehek hieronder.

---

## 1. Hoe ons seker maak dat een regstelling nie 'n ander breek nie

### 1.1 Die "goue toetsstel" (word in Fase 0 gebou, voor enige regstelling)

'n Vaste stel van ±40 scenario's (werknemers + maande) wat deur die backend-enjin gery word, met die verwagte uitset vasgelê. Dek minstens:

- Elke belastingskaal, ouderdom < 65 / 65 / 75, 0/1/2/4 mediese lede
- Bonus in Maart, April, Desember, Februarie
- Begin middel in die jaar; begin/einde middel in die maand
- Reistoelae 80/20, belastingvrye item, pensioen pre-tax, persentasie-item
- Oortyd 1.5/2.0, short time, multi-rate
- Direkteur, UIF-vrystelling, maatskappy nie SDL-geregistreer
- Vrywillige belasting (vas, een maand, bonus-spreiding), belastingdirektief
- 'n Hele belastingjaar Mrt–Feb vir 3 werknemers (som van PAYE = jaaraanspreeklikheid)

### 1.2 Die reël per stap

Elke stap lys vooraf **watter goue scenario's moet verander en presies hoe**. Ná die regstelling:

- Scenario's wat moes verander → het presies na die verwagte waarde verander ✅
- **Alle ander scenario's → identies aan voorheen** ✅
- Enige onverwagte verskil = stop, ondersoek, nie push nie.

### 1.3 Hek voor elke push (bo-op die bestaande 14 TEST-PAY-toetse)

1. `node core/run-tests.js` + Jest-payroll-toetse groen
2. Goue toetsstel: net die verwagte verskille
3. `npm run lint` (Part G2)
4. Handtoets in **Infinite Legacy — TEST** (company 51) — nooit regte kliënte
5. Geslote snapshots van regte kliënte: steekproef bevestig dat hulle **nie** verander het nie
6. Sessie-handoff-dokument bygewerk

### 1.4 Waarom hierdie volgorde?

Ons gaan van **bo na onder in die vloeikaart** (sien [spec/01_VLOEIKAART.md](spec/01_VLOEIKAART.md)): eers die tabelle, dan wat die enjin binnegaan, dan die enjin self, dan wat gestoor word, en eers dan alles wat die gestoorde data lees. So word elke laag op 'n reeds-korrekte laag gebou, en ons hoef niks twee keer reg te maak nie.

---

## 2. Die fases

### Fase 0 — Voorbereiding (verander geen gedrag nie) — ✅ KLAAR 2026-10-12

Resultate: [FASE0_RESULTATE_2026-10-12.md](FASE0_RESULTATE_2026-10-12.md). Nuwe bevindings P1–P3 hieronder by Bylae A.

### Dringend (ná Fase 0) — stop die dubbele bonusbelasting `[P1, P2, P3]`

| Stap | Wat | Wie |
|---|---|---|
| D.1 | ✅ **KLAAR 2026-10-12.** Ruan het Zeabur `PAYE_YTD_METHOD` na `cumulative` verander en Pennygrow September herhaal. Bevestig in die DB: September-drafts gebruik `cumulative_ytd`; werknemer 260 se PAYE R546,12 (was R1 060,41). Goue scenario's: M01/M03/M04 nou korrek. **Newe-effek:** K2 (begin middel in die jaar) is erger — maand 2 en 3 gee R0 PAYE. Blootgestel: 3 werknemers wie se geslote geskiedenis eers ná Maart begin (The Infinite Legacy emp 1 en emp 6; Turkstra emp 274). Hul volgende maande se PAYE moet met die hand nagegaan word totdat Fase 3 klaar is. | Ruan |
| D.2 | ✅ **KLAAR 2026-10-12** (gemagtig deur Ruan). Alle 17 KV-kopieë van die belastingtabel (globaal + 8 maatskappye, `tax_config` en `tax_years_v2`) op die amptelike SARS-2027-waardes gestel: skaal-4-basis 125 599, mediese krediete 376/376/254, en die maatskappye wat nog 2026-tabelle gehad het. Turkstra (7) was reeds korrek en is nie aangeraak nie. Rugsteun van die ou waardes: scratchpad `d2_backup_2026-10-12.json`. | Claude |
| D.3 | ✅ **KLAAR vir D.2** — goue basislyn bygewerk; net S04 (+R3,33), S09 (−R12), S10 (−R24), S11 (−R40) en M03 (+R4,45) het verander, presies soos verwag. Moet weer gedoen word ná D.1 (metode-verandering). | Claude |

### Fase 0 (oorspronklike stappe)
| Stap | Wat | Besluit nodig? |
|---|---|---|
| 0.1 | Kontroleer in produksie: inhoud van globale `tax_config`, `PAYE_YTD_METHOD`/`PAYE_YTD_ENABLED` op Zeabur, migrasies 022/024/025 gehardloop. | Nee (lees net) |
| 0.2 | Bou die goue toetsstel en lê die **huidige** uitsette vas (ook die verkeerde — sodat ons elke verandering sien). | Nee |
| 0.3 | Herstel die 3 druipende oortyd-toetse (toetse teen die backend-enjin, nie die frontend nie). | Nee |
| 0.4 | Skep 'n snapshot-vergelykingsinstrument (voor/ná per werknemer in company 51). | Nee |

### Fase 1 — Belastingtabelle `[K1, W2, W3, B10]` → spec 02

**✅ Gebou 2026-10-13** ([FASE1_CHANGE_IMPACT_NOTE.md](FASE1_CHANGE_IMPACT_NOTE.md)). Tabel `payroll_tax_tables` (migrasie 027, een ry per jaar, net bevestigde jare word gebruik); `services/taxTables.js` kies die periode se eie jaar; ontbrekende/onbevestigde jaar → 422; Tax Configuration-skerm op die API sonder "aktiewe jaar"; enjin ignoreer 'n oorskrywing van 'n ander jaar (W3); kode-verstekke 2027 + W2 reggestel; min = vorige maks (B10). Toetse: `tests/payroll-tax-tables.test.js` (25), golden per periode. Oop: 1.4 (tabel-hash in snapshot → Fase 6), BT-08 (Februarie-waarskuwing).
| Stap | Wat | Verwagte verandering |
|---|---|---|
| 1.1 | Tabelle per belastingjaar (DB-tabel of jaar-gesleutelde konfigurasie); oorskrywing geld net vir sy eie jaar. | Periodes van vorige jare gebruik weer hul eie tabelle |
| 1.2 | 2027-jaar korrek; 2023- en 2024-jaar kortings en mediese krediete reggestel. | PAYE vanaf Mrt 2026 daal (R73–R356/maand by R15k–R80k) |
| 1.3 | Skaalformule "bo vorige maksimum". | Sente-verskille |
| 1.4 | Snapshot stoor belastingjaar + tabel-ID. | Net byvoeging |
| **Afhanklik van** | Fase 0 · Ruan: vrae 02.1–02.3 | |
| **Risiko** | Elke PAYE-syfer vanaf Mrt 2026 verander → **gefinaliseerde maande bly soos hulle is**; kliënte met te veel afgetrekte PAYE kry dit vanself terug teen Februarie (kumulatief) of by assessering. | |

### Fase 2 — Insette bereik die enjin korrek `[K4, B1, B2, B4, B9]` → spec 05, 03

**✅ Gebou 2026-10-12** — [Change Impact Note](FASE2_CHANGE_IMPACT_NOTE.md): multi-rate betaal, eenmalige insette belasbaar/pre-tax volgens item, UIF-vrystelling werk, direkteure betaal UIF, kontrakteurs geen UIF/SDL, SDL op 80% van reistoelae. Oop: B4 (harde fout as insette nie laai nie), ENJ-21 (pro-rata van vaste toelaes), PI-06/PI-12.
| Stap | Wat |
|---|---|
| 2.1 | Multi-rate: rand-uurtarief word korrek oorgedra (of vermenigvuldiger — volgens Ruan se antwoord 05.2). |
| 2.2 | Eenmalige insette erf `is_taxable`, `tax_treatment`, `%`, UIF van hul item (koppel via item-ID). |
| 2.3 | Enige laaifout van insette = harde fout, geen stil halwe payslip nie. |
| 2.4 | `uif_exempt` en (indien besluit) `is_contractor` word na die enjin gestuur. |
| **Afhanklik van** | Fase 1 |

### Fase 3 — PAYE-metode `[K2, K3, V2, HI-02]` → spec 06 B, 07, 12

**Status 2026-10-12:** Ruan het besluit om Fase 3 vóór Fase 1 te doen (tabelle is reeds in die data reggestel, D.2; K2 raak regte werknemers).
- **3a ✅ plaaslik klaar, nog nie gepush nie** — [Change Impact Note](FASE3_CHANGE_IMPACT_NOTE.md). Kumulatiewe metode annualiseer oor die maande wat die werknemer in die belastingjaar data het (gesluite snapshots, insluitend ingevoerde maande) + die huidige maand; kode-standaard is nou `cumulative`. Goue verskille: net M02 (R0 → R4 680,98 elke maand ✅) en M06 (normale PAYE reg; wys nou duidelik die Bonus Spread-dubbeling vir Fase 4). Hek: 15/15 enjin, 127/127 Jest, 0 lint-foute in payroll-kode. Terloops reggestel: dooie kode in `core/run-tests.js` en 'n `global`-verklaring in die enjin (lint, geen gedragsverandering).
- **3a ✅ gepush** (commit 7fb6bd7).
- **3b ✅ gebou 2026-10-12** — maand-volgorde per maatskappy (migrasie 026), latere-maand-blok, bevestiging vir oop maande, omkeer-waarskuwing. Sien [Change Impact Note](FASE3_CHANGE_IMPACT_NOTE.md). Migrasie 026 ✅ deur Ruan in Supabase gehardloop (2026-10-12), bevestig: 46 maatskappye streng AAN (insluitend Pennygrow), 7 AF (1, 7, 11, 38, 39, 40, 51).
| Stap | Wat |
|---|---|
| 3.1 | Implementeer die gekose metode (voorstel: SARS kumulatief met maande-gewerk en eenmalige inkomste apart). |
| 3.2 | Ingevoerde historiese maande tel in YTD. |
| 3.3 | Maand-volgorde-kontrole by finalisering. |
| 3.4 | Waarskuwing wanneer 'n vroeër maand omgekeer word terwyl latere maande gesluit is. |
| **Afhanklik van** | Fase 1 + 2 · **Ruan: vraag 06.1 (die groot besluit)** |
| **Risiko** | Hoog — dit verander die PAYE van bonus-maande en nuwe werknemers. Goue toetse oor 'n volle jaar is hier verpligtend. |

### Fase 4 — Vrywillige belasting `[K5, W6]` → spec 06 E

**✅ Gebou 2026-10-12** — [Change Impact Note](FASE4_CHANGE_IMPACT_NOTE.md). Ook reggestel: payslip-voorskou en PDF het die netto self bereken en die mediese krediet twee keer afgetrek (netto te hoog vir almal met 'n mediese fonds). Oop: VPA-05 (rede op backend), Bakmeester se bonusmaande.
| 4.1 | Bonus-spreiding: verwyder die ×12 (VPA-11); spreiding binne die belastingjaar, uiterlik Februarie (VPA-12). |
| 4.2 | Variable (Period) en Reduce PAYE **onaktief** via 'n vlag — kode bly (VPA-06). Bestaande inskrywings volgens VPA-20. |
| 4.3 | Target PAYE: statutêr wen + waarskuwing (VPA-04); rede op backend afgedwing (VPA-05). |
| 4.4 | Opsionele begin/einde vir Fixed en Target (VPA-02). |
| 4.5 | Bonus Spread gekoppel aan die bonus; bonusmaand trek nie weer af wat reeds betaal is nie (VPA-13 tot VPA-16, volgens VPA-17). |
| 4.6 | Elke aanpassing as aparte lyn op die skerm, PDF en snapshot; stoor met foutboodskap (VPA-07 tot VPA-09). |
| **Bron** | [spec/06 afdeling E](spec/06_BEREKENINGSENJIN.md) — bevestig deur Ruan 2026-10-12 |
| **Afhanklik van** | Fase 3 (die sakrekenaar gebruik die enjin se bonusbehandeling) |

### Fase 5 — Pro-rata en geskiktheid `[B8, V4]` → spec 06 D, 03, 07

**✅ Gebou 2026-10-13** ([FASE5_CHANGE_IMPACT_NOTE.md](FASE5_CHANGE_IMPACT_NOTE.md)). Faktor onafgerond; basiese salaris + vaste toelaes pro-rata; een geskiktheidsreël (`services/payrollEligibility.js`) vir Execute Payroll en die enkel-payslip: aangestel ná die periode → geblokkeer met boodskap, beëindig vóór → uitgesluit. Toetse: `tests/payroll-fase5.test.js` (15). Oortyd en kort tyd in 'n pro-rata maand teen die normale uurtarief (Ruan 2026-10-13).
| 5.1 | Pro-rata-faktor nie meer afgerond nie. |
| 5.2 | Werknemer aangestel ná die periode: blokkeer/waarsku (vraag 03.4). |
| 5.3 | Toelaes pro-rata of nie (vraag 06.3). |

### Fase 6 — Snapshot en payslip onveranderlik `[B3, B7, K6-deel]` → spec 07, 08

**✅ Gebou 2026-10-13** ([FASE6_CHANGE_IMPACT_NOTE.md](FASE6_CHANGE_IMPACT_NOTE.md)). 6.1 insette van 'n gesluite maand → 423, alles-of-niks stoor (migrasie 028); 6.2 `payslip_lines` + `payslip_check` in die snapshot, tabel + hash in `_meta` (stap 1.4); 6.3 payslip-skerm en PDF lees die lyne, PDF geblokkeer as dit nie klop nie; 6.4 vervangde draft-runs "superseded". Toetse: `tests/payroll-fase6.test.js` (15). Oop: PS-05 YTD op payslip, PS-07 PDF-hash, Fase 9-blad.
| 6.1 | Backend weier insetwysigings vir geslote periodes. |
| 6.2 | Snapshot stoor die volledige payslip-lynitems (bevrore). |
| 6.3 | Payslip-skerm en PDF lees lynitems uit die snapshot; kontrole lynitems = totale. |
| 6.4 | Vervangde draft-runs word as "vervang" gemerk. |
| **Afhanklik van** | Fase 1–5 (die snapshot moet eers die regte inhoud hê) |

### Fase 7 — Rekonsiliasie en SARS-syfers `[W7, RS-05, RS-06]` → spec 09

**✅ Gebou 2026-10-13.** `routes/recon.js`: maand-UIF = werknemer + werkgewer (met `uif_employee`/`uif_employer`), EMP201-totaal reg; EMP501 werkgewer-UIF uit die snapshot (ou snapshots: = werknemer); historiese rye tel nie dubbel met snapshots nie; SDL vir historiese rye. `paye-reconciliation.html`: SARS/bank/afgehandel net uit die DB (KV-kopieë was almal leeg), stoorfoute word gewys, duidelike UIF-etikette. Toetse: `tests/payroll-recon-uif.test.js` (6). Oop: RS-07/08/09 (e@syFile, UIF-19, ETI) — roadmap; HI-04 (ingevoerde maande outomaties as "ingedien") — Fase 12.
| 7.1 | UIF in rekon/EMP201 = werknemer + werkgewer. |
| 7.2 | EMP501: werkgewer-UIF uit snapshot; geen dubbeltelling met historiese data. |
| 7.3 | SDL vir historiese maande. |
| 7.4 | SARS-/bankwaardes en status net in DB. |
| **Afhanklik van** | Fase 6 (lees snapshots) |

### Fase 8 — Bywoning na payroll `[V1]` → spec 05

**✅ Gebou 2026-10-13** ([FASE8_CHANGE_IMPACT_NOTE.md](FASE8_CHANGE_IMPACT_NOTE.md)). Bywoning in die DB (was blaaier/KV), API herstel, BCEA-voorstel (`services/attendanceProposal.js`), goedkeuring per werknemer skryf oortyd/short time met `source = attendance` (migrasie 029), handmatige rye onaangeraak, gefinaliseerde maand geweier. Toetse: `tests/payroll-fase8.test.js` (14).
| 8.1 | "Apply to Payroll" skryf na die DB-tabelle (oortyd/short time), sigbaar en verwyderbaar. |
| 8.2 | BCEA-oortydreël en verlof uitgesluit van afwesigheid. |
| **Afhanklik van** | Fase 2 · Ruan: vraag 05.1 |

### Fase 9 — Een enjin; Payslips-blad, verslae, Net-to-Gross op die backend `[K6, B5, B12]` → spec 08, 10, 11

**✅ Gebou 2026-10-13** ([FASE9_CHANGE_IMPACT_NOTE.md](FASE9_CHANGE_IMPACT_NOTE.md)). 9.1 ou Payslips-blad afgeskakel + banklêer/massa-payslips uit snapshots; 9.2 verslae uit gesluite snapshots; 9.3 Net-to-Gross op die backend (toelaes herhalend); 9.4 frontend-enjin bereken nêrens meer nie behalwe die invoerblad (Fase 12). Oop: Leo-joernaal (VU-04), Capitec-formaat, Sean-preflight.
| 9.1 | Payslips-blad (`payruns.html`): afskaf of herbou op snapshots (vraag 08.1). |
| 9.2 | Reports na backend (roadmap P1-B). |
| 9.3 | Net-to-Gross via backend; toelaes as herhalend. |
| 9.4 | Frontend-enjin verwyder (net vertoon-hulpfunksies bly). |
| **Afhanklik van** | Fase 1–7 (hierdie skerms vertoon net wat die vorige fases korrek maak) |

### Fase 10 — Sekuriteit en verpligte velde `[B6, V6]` → spec 13, 03

**✅ Gebou 2026-10-13** ([FASE10_CHANGE_IMPACT_NOTE.md](FASE10_CHANGE_IMPACT_NOTE.md)). Ontsluit herskryf (maatskappy, self, limiet, faal-geslote, oudit — ouditlog het na 'n nie-bestaande tabel geskryf); belastingnommer weer verpligtend met "nog nie geregistreer nie" (migrasie 030); ID-validering en duplikate op die backend; run-waarskuwings + EMP501-blok; gedeelde oudit-helper hou konteks. Toetse: `tests/payroll-fase10.test.js` (18).
| 10.1 | Ontsluiting: dieselfde maatskappy, nie self-goedkeuring, poging-limiet, faal-geslote. |
| 10.2 | Belastingnommer en ID-validering op die backend (vraag 03.1). |
| 10.3 | Duplikaat-werknemer-kontrole. |

### Fase 11 — Blaaierberging/KV opruim `[B11]` → spec 13
| 11.1 | Verwyder `cache_`-besigheidsdata en stil terugval. |
| 11.2 | Oorblywende KV-sleutels (notas, rekon, versteekte items, ens.) na SQL. |
| 11.3 | KV-terugval vir basiese salaris verwyder (ná datakontrole dat alle salarisse in die DB is). |

### Fase 12 — Sean `[B13]` → spec 14
| 12.1 | Atomiese "vul net in as leeg"-skryf. |

### Daarna — roadmap en nuwe funksies
EMP201/EMP501/IRP5/UIF-19-lêers, ETI, byvoordele + 27.5%-limiet, weekliks/tweeweekliks, payroll-joernaal na Ledger Leo, banklêers, pre-finaliseringskontroles, werknemer-selfdiens. Volgorde word saam met Ruan bepaal ná Fase 12.

---

## 3. Wat Ruan nou moet doen

1. Lees die 14 afdelings in [spec/](spec/00_LEESMY.md) en antwoord die ❓-vrae (veral **06.1 — die PAYE-metode**).
2. Sê watter afdelings korrek is → hulle word **BEVESTIG**.
3. Magtig **Fase 0** (verander niks aan die gedrag nie, net voorbereiding en toetse).

---

## Bylae A — Bevindingskodes (oudit 2026-10-12)

| Kode | Bevinding |
|---|---|
| K1 | 2027-belastingtabelle verouderd |
| K2 | Werknemers wat middel in die jaar begin, kry ≈ R0 PAYE vir maande (standaard YTD-metode) |
| K3 | Standaard YTD-metode annualiseer bonusse |
| K4 | Multi-rate-ure word R0 bereken maar wys op die payslip |
| K5 | Bonus-spreiding-sakrekenaar 12× te hoog |
| K6 | "Payslips"-blad is 'n parallelle stelsel op KV + frontend-enjin |
| W2 | Historiese tabelle 2023/2024-jaar: kortings en mediese krediete een jaar agter |
| W3 | Globale tabel-oorskrywing geld vir alle belastingjare |
| W6 | Vrywillige "reduce"/"target_paye" kan PAYE onder statutêr bring |
| W7 | Rekon/EMP201 UIF net 1%; EMP501 werkgewer-UIF = 0 |
| V1 | Bywoning "Apply to Payroll" bereik nooit die berekening nie |
| V2 | Geen maand-volgorde-kontrole vir YTD/finalisering |
| V4 | Werknemer aangestel ná die periode word vir die volle maand betaal |
| V5 | Vervangde draft-runs bly agter met ou totale |
| V6 | Belastingnommer-vereiste gedeaktiveer sedert 2026-04-20 |
| B1 | Eenmalige insette verloor `is_taxable` |
| B2 | Eenmalige insette verloor `tax_treatment` (pre-tax) |
| B3 | Payslip-herdruk gebruik lewendige items; backend keer nie insetwysigings in geslote periodes nie |
| B4 | Laaifoute van insette word stil ingesluk |
| B5 | Twee enjins wat uiteengegroei het |
| B6 | Ontsluit-sekuriteit (ander maatskappy, self-goedkeuring, geen limiet, faal-oop) |
| B7 | Snapshot stoor nie watter tabelle/belastingjaar gebruik is nie |
| B8 | Pro-rata-faktor afgerond na 2 desimale |
| B9 | Werknemer se UIF-vrystelling word nooit na die enjin gestuur nie |
| B10 | Skaalformule 1 rand verskuif |
| B11 | Besigheids-/persoonlike data in blaaierberging en KV |
| B12 | Net-to-Gross behandel toelaes as eenmalig |
| B13 | Sean-IRP5-skryf nie atomies teen oorskryf beskerm nie |
| P1 | Produksie-metode `projection_type_ytd` belas eenmalige inkomste in die volgende maande weer (Fase 0) |
| P2 | `projection_type_ytd` gee vrywillige ekstra PAYE die volgende maand terug (Fase 0) |
| P3 | Globale belastingtabel: skaal-4-basis tikfout + ou mediese krediete (Fase 0) |
