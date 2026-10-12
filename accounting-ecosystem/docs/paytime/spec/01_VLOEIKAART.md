# 01 — Vloeikaart: hoe alles aan mekaar koppel

> Status: **KONSEP** · Doel: wys watter deel van watter ander deel afhang, sodat 'n regstelling op een plek nie 'n ander plek breek nie.

## 1. Die hoofvloei (soos dit MOET werk)

```
 [02 Belastingtabelle]──────────────┐
  (per belastingjaar, in DB)         │
                                     ▼
 [03 Werknemer]──┐            ┌─────────────────────┐
 [04 Items]──────┼──────────► │ PayrollDataService  │  haal ALLES uit die DB,
 [05 Insette]────┘            │ (bou die invoer)    │  faal hard as iets ontbreek
                              └─────────┬───────────┘
 [07 Vorige geslote maande] ──YTD──────►│
                                        ▼
                              ┌─────────────────────┐
                              │ 06 ENJIN (backend)  │  enigste plek waar
                              └─────────┬───────────┘  belasting bereken word
                                        ▼
                              ┌─────────────────────┐
                              │ Snapshot (draft)    │  invoer + uitset + tabelle
                              └─────────┬───────────┘  + metode, alles bevries
                                        ▼  Finaliseer (07)
                              ┌─────────────────────┐
                              │ Snapshot (GESLOTE)  │  onveranderlik
                              └──┬──────┬──────┬────┘
                                 │      │      │
                ┌────────────────┘      │      └─────────────────┐
                ▼                       ▼                        ▼
       [08 Payslip / PDF]   [09 Rekon / EMP201 / EMP501]   [10 Verslae, bank,
        (uit snapshot)        (uit snapshots)                 Ledger Leo-joernaal]
                                        │
                                        └──► volgende maand se YTD (terug na bo)
```

**Die belangrikste insig:** die geslote snapshot is die enigste bron vir alles ná finalisering. Payslip, rekon, EMP501, verslae, bank en die volgende maand se PAYE lees almal daaruit. As die snapshot volledig en korrek is, is alles stroomaf korrek.

## 2. Afhanklikheidstabel — "as ek X verander, wat kan breek?"

| As jy verander… | …raak dit direk | …en stroomaf | Moet altyd hertoets |
|---|---|---|---|
| Belastingtabelle (02) | Enjin se PAYE | Snapshots → payslip, rekon, EMP501, YTD van volgende maande | PAYE oor alle skale, ouderdomme, mediese lede |
| Werknemer-velde (03) | Invoer-bou (ouderdom, pro-rata, UIF-vrystelling) | Enjin → alles | Ouderdom 65/75, begin/einde in maand, direkteur |
| Item-instellings (04) | Belasbaar/UIF/projeksie per item | Enjin → alles; IRP5-kodes → EMP501 | 80/20 reistoelae, belastingvrye items, pre-tax |
| Periode-insette (05) | Invoer-bou | Enjin → alles | Bonus, oortyd, short time, multi-rate |
| Enjin (06) | Elke syfer | Alles | Volle goue toetsstel (sien regstelplan) |
| Finalisering/YTD (07) | Watter maande in YTD tel | Volgende maande se PAYE, rekon | Maand-volgorde, omkeer, aanvullende runs |
| Snapshot-formaat | Wat gestoor word | Payslip-herdruk, rekon, EMP501, verslae | Ou snapshots moet steeds lees (net byvoegings) |
| Payslip (08) | Net vertoon | Niks (mag niks bereken nie) | Herdruk = presies dieselfde as oorspronklik |
| Rekon (09) | Net lees | EMP201/EMP501-indienings | Totale = som van snapshots, UIF 2% |

## 3. Waar die vloei tans breek (uit die oudit)

| Plek | Wat gebeur | Verwysing |
|---|---|---|
| 02 → Enjin | 2027-tabelle verouderd; een globale tabel vir alle jare | K1, W2, W3 |
| 05 → Invoer-bou | Multi-rate word R0; eenmalige items se belasbaarheid/tax_treatment verlore; foute word stil ingesluk | K4, B1, B2 |
| 05 Bywoning → Invoer | "Apply to Payroll" skryf na KV, backend lees dit nooit | V1 |
| 07 → YTD | Geen maand-volgorde; begin-in-die-jaar werknemers ≈ R0 PAYE; bonusse geannualiseer | K2, K3, V2 |
| Snapshot | Watter tabelle/metode gebruik is, word nie gestoor nie | B7 |
| Snapshot → 08 | Herdruk gebruik lewendige items, nie die bevrore lyne nie | B3 |
| Snapshot → 09 | UIF net 1%; werkgewer-UIF = 0 in EMP501 | W7 |
| "Payslips"-blad | Hele parallelle stelsel op KV + frontend-enjin, los van snapshots | K6 |

## 4. Reël vir alle toekomstige werk

Elke verandering moet in hierdie tabel kan aandui watter ry dit raak, en die "moet altyd hertoets"-kolom vir daardie ry moet groen wees voordat dit gepush word.
