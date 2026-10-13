# 08 — Payslips

> Status: **KONSEP** · Skerms: werknemer-detail (`employee-detail.html`), "Payslips" (`payruns.html`) · `js/pdf-branding.js`

## Doel

'n Payslip is 'n wetlike dokument (BCEA art. 33). Dit wys presies wat bereken en betaal is, en 'n herdruk een jaar later is identies aan die oorspronklike.

## Reëls

| # | Reël | Status |
|---|---|---|
| PS-01 | Alle bedrae op die payslip kom van die backend-berekening (draft) of die geslote snapshot (gefinaliseer). Die frontend bereken niks. | ⚠️ Totale ✅, maar lynitems word op die frontend uit lewendige data saamgestel |
| PS-02 | 'n Gefinaliseerde payslip se lynitems (toelaes, aftrekkings, oortyd, ure, tariewe) kom uit die snapshot — nie uit die werknemer se huidige items nie. | ✅ Fase 6: lyne gevries in die snapshot (`payslip_lines`); ou snapshots herbou uit hul gevriesde insette |
| PS-03 | Die som van die lynitems = bruto / aftrekkings / netto op dieselfde payslip. (Outomatiese kontrole; as dit nie klop nie, word die PDF nie gegenereer nie.) | ✅ Fase 6: `payslip_check`; PDF word nie gegenereer as lyne nie klop nie |
| PS-04 | BCEA art. 33-velde: werkgewer naam en adres; werknemer naam, pos, ID/werknemernommer; periode; gewone ure, oortyd-ure en tariewe; elke verdienste en aftrekking met beskrywing; netto bedrag. | ✅ meestal (verifieer ure vir uurwerkers) |
| PS-05 | Payslip wys ook: belasbare inkomste, PAYE, UIF, mediese krediet, werkgewerbydraes (UIF, SDL), YTD-totale. | ⚠️ YTD-totale ontbreek |
| PS-06 | Die "Payslips"-blad (grootmaat-PDF, betaalverdeling, EMP201-voorskou, bankuitvoer) lees uit die geslote snapshots. | ❌ Hele ou stelsel op KV + frontend-enjin [K6] |
| PS-07 | Gegenereerde PDF word gestoor met 'n hash (bewys dat dit nie verander het nie). | 🆕 |
| PS-08 | Werknemers kan hul payslips self (veilig) aflaai of per e-pos ontvang. | 🆕 (e-pos op roadmap) |

## Die Payslips-blad — Claude se voorstel (Ruan het gevra: maak dit maklik vir die gebruiker; doen eerder meer in die agtergrond)

Tans is daar twee plekke wat amper dieselfde ding doen: **Execute Payroll** (die nuwe, korrekte pad) en **Payslips** (die ou pad op KV). Dit verwar die gebruiker en gee verskillende syfers. Voorstel: **een plek met vier duidelike stappe**, en die gebruiker hoef nooit te weet wat agter die skerms gebeur nie.

| Stap | Wat die gebruiker sien | Wat in die agtergrond gebeur |
|---|---|---|
| **1. Voorberei** | Kies die maand → lys werknemers met bruto/PAYE/netto, en geel merkies by enigiets wat aandag nodig het | Stelsel bereken alles outomaties sodra insette verander; kontroleer ontbrekende belastingnommers, negatiewe netto, items sonder IRP5-kode, groot afwykings teenoor verlede maand |
| **2. Nagaan** | Een opsommingsblad: totale, verskille teenoor verlede maand, waarskuwings | Volgorde-kontrole (vorige maand gefinaliseer), Bonus Spread-waarskuwings, vertroulikheid |
| **3. Finaliseer** | Een knoppie "Finaliseer [maand]" | Sluit alle payslips; stoor alles bevrore; skep die payroll-joernaal vir Ledger Leo |
| **4. Betaal en indien** | Knoppies: "Laai alle payslips af (PDF)", "E-pos payslips", "Banklêer", "EMP201-opsomming" | Alles word uit die gesluite payslips gegenereer — nooit herbereken nie |

- Die huidige **Payslips**-blad (`payruns.html`) word uit die kieslys verwyder. Wie die ou skakel oopmaak, word na stap 4 van die regte maand gestuur. (Die kode bly vir eers in die lêer, onaktief, totdat ons seker is niks breek nie.)
- Die werknemer se eie payslip bly op die werknemer-blad sigbaar soos nou.

| # | Reël | Status |
|---|---|---|
| PS-09 | Een plek vir die maandelikse payroll, met die vier stappe hierbo. | ❌ Twee parallelle blaaie |
| PS-10 | Die ou Payslips-blad word onaktief gemaak (uit die kieslys, herlei na stap 4); kode word nie uitgehaal nie. | ❌ |

**BEVESTIG deur Ruan 2026-10-12:** die vier-stap-voorstel (PS-09, PS-10) is aanvaar.

## ❓ Oop vraag

1. Moet die payslip YTD-totale wys (soos Sage/SimplePay)?
