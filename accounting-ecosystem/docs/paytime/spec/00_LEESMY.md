# Paytime — Spesifikasie: hoe die program MOET werk

> Begin: 2026-10-12 · Eienaar: Ruan · Status van die gids: **KONSEP — wag op Ruan se bevestiging**

## Waarvoor is hierdie gids?

Die ander dokumente in `docs/paytime/` beskryf wat die kode **tans doen**. Hierdie gids beskryf wat die program **moet doen** — dit is die maatstaf waarteen elke regstelling en elke nuwe funksie gemeet word.

As die kode en hierdie gids verskil, is die **kode verkeerd** (of die gids moet eers deur Ruan verander word). Geen ontwikkelaar (of Claude) mag gedrag verander wat hier as **BEVESTIG** gemerk is sonder dat Ruan die gids eers aanpas nie.

## Hoe om dit te gebruik (vir Ruan)

1. Lees elke afdeling. Elke reël het 'n nommer (bv. `ENJ-07`) en 'n status.
2. Waar jy nie saamstem nie: skryf jou regstelling direk in die lêer, of sê dit in die gesprek en Claude werk dit by.
3. Beantwoord die **❓ Vrae vir Ruan** onderaan elke afdeling.
4. Wanneer 'n afdeling reg is, verander die status bo-aan na **BEVESTIG** met die datum.
5. Eers dan word die ooreenstemmende fase in die [regstelplan](../REGSTELPLAN_2026-10.md) uitgevoer.

## Statusmerke per reël

| Merk | Betekenis |
|---|---|
| ✅ | Die kode doen dit reeds korrek |
| ⚠️ | Die kode doen dit gedeeltelik of anders |
| ❌ | Die kode doen dit nie / doen dit verkeerd |
| ❓ | Ruan moet besluit voordat dit gebou/reggemaak word |
| 🆕 | Bestaan nog nie — nuwe funksie |

Verwysings soos `[K4]` of `[W7]` wys na die bevindings in die oudit van 2026-10-12 (sien [regstelplan](../REGSTELPLAN_2026-10.md), Bylae A).

## Afdelings

| # | Afdeling | Lêer | Status |
|---|---|---|---|
| 01 | Vloeikaart — hoe alles aan mekaar koppel | [01_VLOEIKAART.md](01_VLOEIKAART.md) | KONSEP |
| 02 | Belastingtabelle en wetgewing | [02_BELASTINGTABELLE.md](02_BELASTINGTABELLE.md) | KONSEP |
| 03 | Werknemers (meesterdata) | [03_WERKNEMERS.md](03_WERKNEMERS.md) | KONSEP |
| 04 | Payroll-items (verdienste/aftrekkings, IRP5) | [04_PAYROLL_ITEMS.md](04_PAYROLL_ITEMS.md) | KONSEP |
| 05 | Insette per periode (eenmalig, oortyd, short time, multi-rate, bywoning) | [05_PERIODE_INSETTE.md](05_PERIODE_INSETTE.md) | KONSEP |
| 06 | Berekeningsenjin (PAYE, UIF, SDL, pro-rata, vrywillige belasting) | [06_BEREKENINGSENJIN.md](06_BEREKENINGSENJIN.md) | KONSEP — afdeling E (Voluntary PAYE) **BEVESTIG** 2026-10-12 |
| 07 | Payroll uitvoer, finaliseer, omkeer, ontsluit | [07_UITVOER_EN_FINALISERING.md](07_UITVOER_EN_FINALISERING.md) | KONSEP |
| 08 | Payslips (skerm, PDF, herdruk) | [08_PAYSLIPS.md](08_PAYSLIPS.md) | KONSEP |
| 09 | Rekonsiliasie en SARS (EMP201, EMP501, IRP5, UIF) | [09_REKONSILIASIE_EN_SARS.md](09_REKONSILIASIE_EN_SARS.md) | KONSEP |
| 10 | Verslae, bank- en rekeningkunde-uitvoere | [10_VERSLAE_EN_UITVOERE.md](10_VERSLAE_EN_UITVOERE.md) | KONSEP |
| 11 | Net-to-Gross | [11_NET_TO_GROSS.md](11_NET_TO_GROSS.md) | KONSEP |
| 12 | Historiese invoer | [12_HISTORIESE_INVOER.md](12_HISTORIESE_INVOER.md) | **BEVESTIG** 2026-10-12 (een oop vraag oor PDF-bronne) |
| 13 | Toegang, sekuriteit en databerging | [13_TOEGANG_EN_SEKURITEIT.md](13_TOEGANG_EN_SEKURITEIT.md) | KONSEP |
| 14 | Sean-integrasie | [14_SEAN.md](14_SEAN.md) | KONSEP |

## Vaste beginsels (geld vir alle afdelings)

1. **Een enjin.** Alle belasting- en payroll-berekeninge gebeur slegs in `backend/core/payroll-engine.js`. Die frontend vertoon net.
2. **Databasis is die waarheid.** Geen besigheidsdata in `localStorage`, `sessionStorage` of die KV-brug nie (CLAUDE.md Part D).
3. **Gefinaliseer = onveranderlik.** 'n Geslote payslip word nooit herbereken of gewysig nie; regstellings gaan net deur omkeer → herbereken → herfinaliseer.
4. **SARS se reëls wen.** Waar 'n besigheidsvoorkeur met die Inkomstebelastingwet / Vierde Bylae / UIF-wet bots, volg die program die wet en waarsku die gebruiker.
5. **Niks stil nie.** As data ontbreek of 'n oproep faal, stop die berekening met 'n duidelike fout — dit lewer nooit 'n "half" payslip nie.
6. **Toets by die toetsmaatskappy.** Alle toetse in *Infinite Legacy — TEST* (company 51), nooit in regte kliëntdata nie (CLAUDE.md Part H).
