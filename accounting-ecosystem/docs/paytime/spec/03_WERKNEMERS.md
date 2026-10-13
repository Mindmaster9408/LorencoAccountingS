# 03 — Werknemers (meesterdata)

> Status: **KONSEP** · Raak: invoer-bou (ouderdom, pro-rata, UIF/SDL-vrystellings), EMP501/IRP5, bankuitvoere

## Doel

Elke werknemer het volledige, geldige data wat SARS en die UIF vereis, sodat payroll en jaareinde-indienings nooit misluk weens ontbrekende inligting nie.

## Reëls

| # | Reël | Status |
|---|---|---|
| WN-01 | Verpligte velde: naam, van, SA ID-nommer **of** paspoortnommer (+ land), aanstellingsdatum, betaalfrekwensie, basiese salaris of uurtarief. | ⚠️ Fase 10: ID/paspoort + belastingnommer verpleg by skep; aanstellingsdatum/frekwensie nog nie |
| WN-02 | **BEVESTIG 2026-10-12 (opsie b):** SARS-belastingnommer is verpligtend (10 syfers, modulus-10-kontrole). Uitsondering: 'n merkie "nog nie by SARS geregistreer nie" laat die werknemer toe sonder nommer, met 'n waarskuwing op elke run; die EMP501/IRP5 word vir daardie werknemer **geblokkeer** totdat die nommer ingevul is. | ✅ Fase 10: verpligtend + modulus-10; "nog nie by SARS geregistreer nie" (migrasie 030), waarskuwing per run, IRP5 geblokkeer [V6 reg] |
| WN-03 | ID-nommer word gevalideer (13 syfers, Luhn, geboortedatum geldig) — op die backend, nie net in die blaaier nie. | ✅ Fase 10: op die backend (13 syfers, Luhn, geboortedatum) |
| WN-04 | Geen duplikaat-werknemers: dieselfde ID-nommer kan nie twee keer aktief in dieselfde maatskappy wees nie. | ✅ Fase 10: duplikaat-ID in dieselfde maatskappy geweier |
| WN-05 | Ouderdom vir kortings word bereken op die laaste dag van die belastingjaar (uit geboortedatum, anders ID). | ✅ |
| WN-06 | **BEVESTIG 2026-10-12: direkteure betaal UIF.** Die direkteur-vlag bly bestaan (vir verslae en vertroulikheid, WN-14), maar maak UIF nie meer 0 nie. | ✅ Fase 2 |
| WN-07 | UIF-vrystelling per werknemer (bv. < 24 uur/maand) word in die berekening toegepas. | ✅ Fase 2 [B9 reg] |
| WN-08 | **BEVESTIG 2026-10-12:** kontrakteurs (`is_contractor`) word deur Paytime hanteer en op die normale belastingskale belas (PAYE). Kontrakteurs betaal **geen UIF en geen SDL** nie. | ✅ Fase 2: PAYE op tabelle, geen UIF/SDL |
| WN-09 | Beëindiging stel `is_active = false` + beëindigingsdatum; die laaste maand word pro-rata betaal; daarna kan die werknemer nie meer in 'n run ingesluit word nie. | ✅ |
| WN-09a | **BEVESTIG deur Ruan 2026-10-12:** 'n Onaktiewe (beëindigde) werknemer se payroll-data bly deel van die belastingjaar en word ingesluit in die PAYE-rekon, EMP501 en IRP5, al verskyn hy nie meer in die aktiewe lys nie. 'n Werknemer word nooit hard uitgevee nie, net op onaktief gestel. | ✅ "Delete" is 'n sagte deaktivering; rekon en EMP501 sluit onaktiewe werknemers in |
| WN-09b | Om 'n werknemer te deaktiveer of te "verwyder" mag nooit 'n bestaande beëindigingsdatum oorskryf nie. Die beëindigingsdatum is die einde van die diensperiode op die IRP5. | ❌ "Delete" stel die beëindigingsdatum altyd op vandag, ook as die werknemer reeds met 'n ander datum beëindig is (`shared/routes/employees.js:268`, `payroll/routes/employees.js:409`) |
| WN-10 | **BEVESTIG 2026-10-12 (Claude se voorstel aanvaar):** 'n werknemer wie se aanstellingsdatum **ná** die periode is, word in daardie periode se run **geblokkeer**, met 'n duidelike boodskap: *"[Naam] begin eers op [datum]. Kies 'n latere periode, of verander die aanstellingsdatum as dit verkeerd is."* Rede: om iemand te betaal voordat hy begin het, is byna altyd 'n tikfout in die datum; die regstelling is om die datum reg te maak, nie om die betaling deur te druk nie. | ✅ Fase 5: geblokkeer met die ooreengekome boodskap (run + enkel-payslip) |
| WN-11 | Salarisveranderings het 'n effektiewe datum en 'n geskiedenis (wie, wanneer, ou/nuwe bedrag). | 🆕 Tans oorskryf dit net |
| WN-12 | Bankbesonderhede is verpligtend vir EFT-betaalde werknemers. | ❓ |
| WN-13 | Persoonlike inligting word nooit in blaaierberging gekas nie (POPIA). | ✅ Fase 11: geen werknemer-/salariskas in blaaierberging nie |
| WN-14 | **Vertroulike werknemers — BEVESTIG deur Ruan 2026-10-12.** Die eienaar kan sekere werknemers (bv. direkteure, of homself) as **vertroulik** merk. 'n Payroll-gebruiker sonder toegang tot vertroulike werknemers kan al die ander personeel se payroll doen, maar kan die vertroulike werknemers **glad nie sien nie**: nie in lyste, payslips, verslae, rekon-uiteensettings of banklêers nie. Voorbeeld: Ruan se werker doen al die personeel se salarisse, maar kan Ruan se salaris nie sien nie. | ⚠️ Basis bestaan (`classification` public/confidential + `paytimeAccess`); moet in alle verslae, totale en uitvoere nagegaan word |
| WN-15 | **BEVESTIG deur Ruan 2026-10-12 (opsie a):** 'n gebruiker sonder vertroulike toegang sien **net die totale van die werknemers wat hy mag sien** — nooit die volle maatskappytotaal nie (dit sou die vertroulike salarisse laat aflei). Die maand se finalisering, die volle EMP201, die volledige banklêer en die Ledger Leo-joernaal word slegs deur iemand **met volle toegang** gedoen. | 🆕 |

## Beantwoorde vrae (2026-10-12)

1. Belastingnommer → **verpligtend met 'n "nog nie geregistreer"-uitsondering** wat die EMP501 blokkeer (WN-02).
2. Direkteure → **betaal UIF** (WN-06).
3. Kontrakteurs → **word op die belastingskale belas**; ons bou dit in (WN-08).
4. Aangestel ná die periode → **blokkeer** met 'n duidelike boodskap (WN-10).

## ❓ Oop vrae

1. ~~Vertroulik en totale~~ → **BEANTWOORD 2026-10-12:** opsie (a) (WN-15).
2. ~~Kontrakteurs UIF/SDL~~ → **BEANTWOORD 2026-10-12:** nee, net PAYE (WN-08).
