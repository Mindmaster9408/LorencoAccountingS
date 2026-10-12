# 12 — Historiese invoer

> Status: **BEVESTIG deur Ruan 2026-10-12**
> Skerm: `historical-import.html` · Skripte: `backend/scripts/import_historical_payroll_*.js` (Turkstra, Pennygrow, SimplePay)

## Doel (in Ruan se woorde)

> "As ek data import, dan moet hy die data vat soos dit is en so gebruik, en dan daarvandaan uitwerk. Elke maand word gesien as reeds ingedien en afgehandel — hy sien PAYE is klaar ingedien. En ek wil ook 'n payroll-item kan byvoeg, want daar is dalk iets op die payslip wat ek op die payslip moet hê. Onthou, dit kom van 'n ander stelsel af."

## My verstaan

1. **Soos dit is:** die ingevoerde syfers (bruto, belasbaar, PAYE, UIF, SDL, aftrekkings, netto) word presies gestoor soos die vorige stelsel dit gehad het. Paytime bereken dit **nooit** oor nie.
2. **Daarvandaan uitwerk:** die eerste maand wat Paytime self bereken, bou voort op die ingevoerde maande. Die YTD-PAYE sien die ingevoerde inkomste en PAYE as reeds verdien en reeds afgetrek.
3. **Reeds ingedien en afgehandel:** elke ingevoerde maand is gesluit (gefinaliseer) en word in die PAYE-rekon gesien as **reeds aan SARS verklaar en betaal**. Daar verskyn dus geen "verskil" vir daardie maande nie.
4. **Payroll-items byvoeg:** die gebruiker kan items (bv. "Reistoelae", "Pensioen", "Lening") op 'n ingevoerde maand se payslip sit, sodat die payslip lyk soos die een uit die ou stelsel, en sodat elke bedrag sy IRP5-kode vir die EMP501 kry.

## Reëls

| # | Reël | Status |
|---|---|---|
| HI-01 | Ingevoerde maande word as **gesluite snapshots** gestoor, gemerk met hul bron (bv. `simplepay_import`), en nooit deur die enjin herbereken nie. | ⚠️ Die invoerskripte doen dit ✅. Die invoer-**skerm** skryf egter na `payroll_historical` + KV, nie na snapshots nie ❌ |
| HI-02 | Daar is **een** invoerpad vir alle bronne. Die skerm doen wat die skripte doen, sodat 'n gebruiker nie 'n ontwikkelaar nodig het om te kan invoer nie. | ❌ Twee paaie wat verskillend werk |
| HI-03 | Die volgende maande se PAYE (YTD) bou voort op die ingevoerde maande se belasbare inkomste en PAYE. | ⚠️ ✅ vir skrip-invoer (gesluite snapshots tel in YTD). ❌ vir skerm-invoer (`payroll_historical` word deur YTD geïgnoreer) |
| HI-04 | 'n Ingevoerde maand word in die PAYE-rekon outomaties as **"reeds verklaar en betaal"** gemerk: SARS-verklaar = bank = die EMP201-syfers wat uit die ingevoerde payslips saamgestel is; verskil = 0; status "afgehandel". **Die gebruiker sleutel nie EMP201-bedrae vir ingevoerde maande in nie** (Ruan, 2026-10-12). | ❌ Rekon wys die ingevoerde maande as "bereken" met leë SARS/bank-kolomme |
| HI-04a | **Kontrole deur Ruan:** ná die invoer vergelyk Ruan Paytime se EMP201 per maand (PAYE, UIF werknemer + werkgewer, SDL, ETI) met die ou stelsel se EMP201 (bv. SimplePay). Dit moet **tot op die sent** ooreenstem. Daarom moet elke ingevoerde payslip sy eie PAYE, werknemer-UIF, **werkgewer-UIF**, SDL en ETI dra, en die EMP201 vir ingevoerde maande word net uit hierdie ingevoerde bedrae saamgestel — nooit herbereken nie. | ⚠️ Skripte stoor werkgewer-UIF en SDL ✅; ETI nie; rekon tel tans net 1% UIF [W7] — moet eers reggestel word |
| HI-05 | Ingevoerde maande kan nie in Execute Payroll weer gehardloop of gewysig word nie. Regstellings net via 'n doelbewuste "ongedaan maak van die invoer" (met rede en ouditspoor). | ⚠️ Gesluit ✅; ongedaan-maak gebruik 'n KV-log en tydstempel-heuristiek |
| HI-06 | Die invoer behou **elke lyn** van die ou payslip (elke toelae, aftrekking en werkgewerbydrae apart, met beskrywing en bedrag), nie net die totale nie. | ❌ Skripte hou basies + bonus apart, maar tel alle aftrekkings saam in een totaal; skerm stoor net totale |
| HI-07 | Tydens die invoer word elke kolom van die ou stelsel aan 'n Paytime-payroll-item gekoppel (bestaande of nuut geskep), met sy IRP5-kode. | ❌ |
| HI-08 | **Item byvoeg ná invoer — BEVESTIG (opsie a):** op 'n ingevoerde maand kan die gebruiker 'n payroll-item met 'n bedrag byvoeg. Dit **verdeel net** die ingevoerde bedrae; die totale (bruto, PAYE, UIF, SDL, aftrekkings, netto) bly presies soos ingevoer, want dit is reeds by SARS ingedien. Totdat die lyne optel tot die ingevoerde totaal, wys die payslip 'n lyn **"Nie toegeken nie: R x"** (verdienste en aftrekkings apart). Elke bygevoegde item dra sy IRP5-kode na die EMP501. Byvoeging word geoudit. | ❌ Bestaan nie |
| HI-08a | Die "Nie toegeken nie"-bedrag kan nooit negatief word nie: die stelsel weier 'n item wat die lyne bo die ingevoerde totaal sou bring. | ❌ |
| HI-09 | Elke invoer word gekontroleer: bruto − PAYE − UIF − aftrekkings = netto (binne R0,01). Afwykings word in 'n verslag gelys, en die gebruiker besluit of dit ingevoer word. | ⚠️ |
| HI-10 | Ontbrekende verpligte velde → plekhouer + verslag (bestaande beleid). | ✅ |
| HI-11 | Ingevoerde maande verskyn in die EMP501/IRP5 met hul IRP5-kodes, net soos Paytime-maande, ook vir werknemers wat intussen onaktief is (sien WN-09a). | ⚠️ Totale ✅; geen IRP5-kode-verdeling nie |
| HI-12 | Geen invoerdata in KV of blaaierberging nie. | ❌ Skerm skryf nog na KV |
| HI-13 | **Invoerformate (vir eers): Excel en PDF-payslips** (Ruan, 2026-10-12). Excel: kolomme word aan Paytime-items gekoppel (HI-07). PDF: die stelsel lees elke payslip-PDF uit (werknemer, maand, elke lyn en bedrag), wys 'n voorskou, en die gebruiker bevestig voordat iets gestoor word. | ⚠️ Excel/CSV gedeeltelik; PDF bestaan nie |
| HI-14 | PDF-lees is per bronformaat (bv. SimplePay se payslip-uitleg). As 'n PDF nie betroubaar gelees kan word nie, word dit uitgelig vir handmatige invoer — die stelsel raai nooit 'n bedrag nie. | 🆕 |

## Beantwoorde vrae (2026-10-12)

1. Item byvoeg op 'n ingevoerde maand → **(a)** verdeel net, totale bly soos ingevoer (HI-08).
2. Bronformate → **Excel en PDF-payslips** vir eers (HI-13).
3. EMP201 van ingevoerde maande → **nie handmatig insleutel nie**; Ruan vergelyk self Paytime se EMP201 met die ou stelsel s'n, en dit moet ooreenstem (HI-04, HI-04a).

4. PDF-bronne → **SimplePay en ander stelsels**; Ruan bring die ander bronne in soos ons aangaan. Elke uitleg word apart geleer met voorbeeld-PDF's in die toetsmaatskappy.
