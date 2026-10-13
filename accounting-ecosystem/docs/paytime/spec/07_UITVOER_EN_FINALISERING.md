# 07 — Payroll uitvoer, finaliseer, omkeer, ontsluit

> Status: **KONSEP** · Skerm: *Execute Payroll* (`payroll-execution.html`) · Backend: `routes/payruns.js`, `routes/unlock.js`

## Doel

Die maandelikse lewensiklus van 'n payroll is beheerd, in volgorde, en ouditeerbaar: **bereken (draft) → nagaan → finaliseer (sluit) → betaal**, met 'n veilige pad om foute reg te stel.

## Reëls

| # | Reël | Status |
|---|---|---|
| UF-01 | **Run** bereken alle gekose werknemers op die backend en stoor 'n draft-snapshot per werknemer. 'n Herhaalde run vervang die draft. | ✅ |
| UF-02 | Werknemers wat nie in die periode aktief was nie (aangestel ná die periode / beëindig vóór die periode) word uitgesluit. | ⚠️ Aanstelling ná periode word ingesluit [V4] |
| UF-03 | **Voor finalisering** wys die stelsel 'n nagaan-verslag: verskil per werknemer teenoor verlede maand, ontbrekende belastingnommers, negatiewe netto, items sonder IRP5-kode. | 🆕 |
| UF-04 | **Volgorde:** 'n maand kan net gefinaliseer word as die vorige maand in dieselfde belastingjaar gefinaliseer is (of die werknemer toe nie in diens was nie). | ✅ Fase 3b: per-maatskappy streng volgorde (migrasie 026); ander kry 'n bevestiging |
| UF-05 | **Finaliseer** sluit al die run se snapshots (`is_locked = true`) — enigste finaliseringspad. | ✅ |
| UF-06 | 'n Ou draft-run wat deur 'n nuwer run vervang is, word as "vervang" gemerk en kan nie meer gefinaliseer word nie. | ✅ Fase 6: ou draft-runs sonder oop payslips → "superseded", kan nie gefinaliseer word nie (migrasie 028) |
| UF-07 | Aanvullende run vir 'n vergete werknemer in 'n reeds gefinaliseerde maand is toegelaat. | ✅ |
| UF-08 | **Omkeer** van 'n gefinaliseerde run vereis 'n rede, behou die ou snapshots (as "reversed"), en laat 'n nuwe run toe. | ✅ |
| UF-09 | As 'n maand omgekeer word terwyl latere maande reeds gesluit is, waarsku die stelsel dat daardie latere maande se PAYE op ou syfers gebaseer is, en bied aan om dit ook om te keer. | 🆕 |
| UF-10 | **Ontsluit van 'n individuele payslip** (buite 'n gefinaliseerde run): goedkeurder moet 'n bestuurder **in dieselfde maatskappy** wees, mag nie die versoeker self wees nie, pogings word beperk, en as enige kontrole faal, word ontsluiting geweier. | ❌ [B6] |
| UF-11 | Pligskeiding: die persoon wat die run voorberei, is nie die een wat finaliseer nie (opsioneel per maatskappy). | 🆕 |
| UF-12 | Elke run, finalisering, omkeer en ontsluiting word geoudit. | ✅ |
| UF-13 | 'n Run is "alles of niks" per werknemer: 'n fout by een werknemer word gerapporteer, nie stilweg met halwe data bereken nie. | ⚠️ Per-werknemer foute word gerapporteer; insetfoute word egter ingesluk [B4] |

## Beantwoord deur Ruan (2026-10-12)

| # | Besluit |
|---|---|
| UF-04 | **Volgorde — BEVESTIG 2026-10-12 (verfyn):** Jy mag enige maand oopmaak en bekyk. **"Calculate payslip" en Execute Payroll werk nie** vir 'n werknemer wie se **vorige maand** nog nie afgehandel is nie (gefinaliseer of ingevoer) — want PAYE gebruik die vorige maande. Uitsondering: die werknemer se eerste maand in Paytime dié belastingjaar, en maande voor sy aanstelling. Dit geld **per maatskappy** (`companies.payroll_strict_period_order`, migrasie 026): AAN vir nuwe maatskappye en Pennygrow; AF vir maatskappye met gapings (Turkstra, Bakmeester, Lorenco Accounting, le Grange, Lorenco Ecosystum, The Infinite Legacy, TEST) totdat hul maande ingevoer is (Fase 12) — dan skakel 'n super user dit aan. Vir AF-maatskappye: bereken werk; finalisering met oop vorige maande vra bevestiging (geoudit). **Altyd** geblokkeer: finaliseer as 'n **latere** maand reeds gefinaliseer is. ✅ Gebou 2026-10-12 (Fase 3b). |
| UF-10 | **Individuele ontsluiting bly**, met die strenger kontroles in UF-10 (dieselfde maatskappy, nie self-goedkeuring nie, beperkte pogings, faal-geslote). |
| UF-11 | **Pligskeiding volg die toegangsvlakke wat die eienaar stel.** 'n Gebruiker met 'n vlak wat alles mag doen, mag self voorberei en finaliseer. 'n Gebruiker met 'n laer vlak mag net doen wat sy vlak toelaat (bv. voorberei, maar nie finaliseer nie). Daar is geen ekstra verpligte tweede persoon nie. |
| UF-14 | **Vertroulike werknemers** (sien WN-14): 'n gebruiker sonder vertroulike toegang kan nie die run vir vertroulike werknemers sien of hardloop nie. |
