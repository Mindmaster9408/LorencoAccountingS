# 09 — Rekonsiliasie en SARS (EMP201, EMP501, IRP5, UIF)

> Status: **KONSEP** · Skerm: *PAYE Reconciliation* (`paye-reconciliation.html`) · Backend: `routes/recon.js`

## Doel

Die syfers wat aan SARS verklaar en betaal word, kom presies uit die geslote payslips, en die stelsel wys elke verskil tussen *bereken*, *verklaar* (EMP201) en *betaal* (bank).

## Reëls

| # | Reël | Status |
|---|---|---|
| RS-01 | Bron van waarheid = geslote snapshots; ingevoerde historiese maande slegs waar daar geen snapshot vir daardie werknemer + maand is nie. | ✅ opsomming en EMP501 (Fase 7) |
| RS-01a | **BEVESTIG deur Ruan 2026-10-12:** Alle werknemers wat in die belastingjaar betaal is, ook dié wat intussen onaktief/beëindig is, word in die rekon, EMP501 en IRP5 vir daardie jaar ingesluit. | ✅ |
| RS-02 | **EMP201 per maand** = PAYE + SDL + UIF (werknemer **+** werkgewer = 2%) − ETI. | ✅ UIF 2% (Fase 7, 2026-10-13); ETI nog nie [roadmap] |
| RS-03 | Vergelyking bereken vs. SARS-verklaar vs. bank, per maand en per belastingtipe; verskil = 0 as alles klop. | ⚠️ Struktuur ✅, maar UIF-verskil altyd ≠ 0 weens RS-02 |
| RS-04 | **EMP501** per werknemer: belasbare inkomste per IRP5-bronkode, PAYE, UIF (werknemer + werkgewer), SDL, mediese krediet, ETI. | ⚠️ Werkgewer-UIF ✅ (Fase 7); geen bronkode-verdeling of ETI nog nie |
| RS-05 | SDL vir ingevoerde historiese maande word ingesluit (of bereken uit bruto as dit nie ingevoer is nie). | ✅ Ingesluit wanneer dit ingevoer is (Fase 7). Alle huidige ingevoerde data is gesluite snapshots met eie SDL. |
| RS-06 | SARS- en bankwaardes wat die gebruiker insleutel, en die "afgehandel"-status per jaar, word net in die DB gestoor. | ✅ Fase 7 — KV verwyder, stoorfoute word gewys |
| RS-07 | IRP5/IT3(a)-sertifikate en die e@syFile-lêer (EMP501) word gegenereer uit die snapshots. | 🆕 roadmap P2 |
| RS-08 | UIF-19 / uFiling-lêer per maand. | 🆕 roadmap P2 |
| RS-09 | ETI word per werknemer per maand bereken en van PAYE in die EMP201 afgetrek. | 🆕 roadmap P5 (tabel bestaan, nie gekoppel nie) |

## ❓ Vrae vir Ruan

1. Moet die rekon-skerm self ook die **EMP201-totaal** (wat betaal moet word) prominent wys, sodat die gebruiker dit net oortik op eFiling?
2. ETI: hoeveel van jou kliënte eis ETI? (Bepaal hoe vinnig RS-09 moet kom.)
