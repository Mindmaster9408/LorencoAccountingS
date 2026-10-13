# 10 — Verslae, bank- en rekeningkunde-uitvoere

> Status: **KONSEP** · Skerms: *Reports* (`reports.html`), bankuitvoer op die Payslips-blad · ⚠️ Hierdie deel is in die oudit net gedeeltelik nagegaan.

## Doel

Bestuur kan payroll-koste ontleed, die bank kan betaal word uit 'n lêer, en die payroll beland outomaties in die rekeningkunde (Ledger Leo) — alles uit die geslote snapshots.

## Reëls

| # | Reël | Status |
|---|---|---|
| VU-01 | Alle verslae lees uit die backend (snapshots + ingevoerde historiese data), nooit uit KV/blaaier nie. | ✅ Fase 9/11: syfer- en ouditverslae uit die backend |
| VU-02 | Standaardverslae: payroll-register per maand, koste per departement, jaaranalise per werknemer, items per kode, oortyd-verslag. | ⚠️ `annual-analysis` bestaan op backend |
| VU-03 | Banklêer (EFT) word gegenereer uit die geslote snapshots se netto bedrae + werknemer-bankbesonderhede; totaal = som van netto. | ✅ Fase 9: uit die gesluite snapshots (netto) + bankbesonderhede in die DB |
| VU-04 | **Payroll-joernaal na Ledger Leo** per gefinaliseerde run: salarisuitgawe, werkgewerkoste (UIF, SDL), PAYE/UIF/SDL-laste, netto-betaalbaar. Omkeer van 'n run keer die joernaal om. | ✅ Konsep-joernaal by finalisering + omkeer; Leo se Bank-blad herken salaris- en EMP201-betalings (voorstel, rekenmeester bevestig) — LEO_PAYROLL_JOURNAL_CHANGE_IMPACT_NOTE.md |
| VU-05 | Uitvoere na Xero/ander pakkette is opsioneel en lees dieselfde snapshots. | ⚠️ Knoppie bestaan, nie volledig nie |

## Beantwoord deur Ruan (2026-10-12)

| # | Besluit |
|---|---|
| VU-04 | **Ja — payroll-joernaal na Ledger Leo, as KONSEP.** By finalisering skep Paytime die joernaal as 'n konsep in Ledger Leo; die **rekenmeester** gaan dit na en pos dit. Paytime pos nooit self nie. As 'n run omgekeer word voordat die konsep gepos is, word die konsep gekanselleer; as dit reeds gepos is, word 'n omkeer-konsep geskep. Daarby trek Ledger Leo die **betalings aan werknemers** uit die bank terug en pas dit teen die netto bedrae van die gefinaliseerde run, sodat die salarisrekening en die PAYE/UIF/SDL-laste gerekonsilieer kan word. |

## Banklêers — Claude se voorstel (Ruan het gevra)

Daar bestaan reeds kode vir **ABSA, FNB, Standard Bank en Nedbank** (`js/banking-formats.js`), maar dit lees uit die ou KV-data en die frontend-enjin.

| # | Reël | Status |
|---|---|---|
| VU-06 | **Een algemene CSV-lêer** wat enige bank kan inlees: naam, rekeningnommer, takkode, rekeningtipe, bedrag, verwysing. Dit werk altyd, ook vir banke sonder 'n eie formaat. | ✅ Fase 9: algemene CSV (naam, rekening, tak, tipe, bedrag, verwysing) |
| VU-07 | **Bank-spesifieke formate** vir die vyf grootste SA-banke: FNB, ABSA, Standard Bank, Nedbank, **Capitec Business**. Die vier bestaandes word herbou om uit die gesluite payslips te lees; Capitec word bygevoeg. | ⚠️ Fase 9: FNB/ABSA/Standard/Nedbank lees nou die gesluite payslips; Capitec Business nog nie (voorbeeldlêer nodig) |
| VU-08 | Die maatskappy se bank word een keer in *Company Details* gekies; daarna kies die stelsel self die regte formaat — die gebruiker druk net "Banklêer". | 🆕 |
| VU-09 | Kontrole voor die lêer gemaak word: elke werknemer wat per EFT betaal word, het geldige bankbesonderhede; die lêer se totaal = die som van die netto bedrae. As iets ontbreek, word dit gelys, nie stilweg uitgelaat nie. | ✅ Fase 9: ontbrekende bankbesonderhede gelys en lêer geweier; totaal = som van netto |
| VU-10 | Die banklêer en die Ledger Leo-terugtrek (VU-04) gebruik dieselfde verwysing per werknemer (bv. `SAL 2026-10 EMP001`), sodat die rekonsiliasie outomaties pas. | ⚠️ Fase 9: CSV-verwysing `SAL YYYY-MM KODE`; Leo-kant volg met VU-04 |
| VU-11 | Ander banke (bv. Investec, TymeBank, African Bank) word bygevoeg wanneer 'n kliënt dit nodig het. | — |

## ❓ Vrae vir Ruan

1. ~~Banklêer-voorstel~~ → **BEVESTIG deur Ruan 2026-10-12:** algemene CSV + FNB, ABSA, Standard Bank, Nedbank, Capitec Business (VU-06 tot VU-11).
2. ~~Payroll-joernaal~~ → **BEANTWOORD 2026-10-12:** as konsep; die rekenmeester pos (VU-04).
