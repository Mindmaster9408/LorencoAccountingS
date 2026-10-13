# 13 — Toegang, sekuriteit en databerging

> Status: **KONSEP** · Raak: alle roetes, `middleware/auth.js`, `config/permissions.js`, KV-brug

## Reëls

| # | Reël | Status |
|---|---|---|
| TS-01 | Elke DB-navraag is tot die maatskappy (`company_id`) beperk. | ✅ |
| TS-02 | Beperkte Paytime-gebruikers sien net hul toegelate werknemers (ID-lys of "publiek"). | ✅ |
| TS-03 | Super-users het toegang tot alles (CLAUDE.md Part F); Coaching bly onsigbaar. | ✅ |
| TS-04 | Wagwoord-gebaseerde goedkeurings (ontsluit) word beperk (bv. 5 pogings / 15 min), sê nie of 'n e-posadres bestaan nie, en aanvaar slegs bestuurders van dieselfde maatskappy, nie die versoeker self nie. | ✅ Fase 10 (ontsluit) |
| TS-05 | Geen besigheids- of persoonlike data in blaaierberging nie (Part D + POPIA): ook nie as "kas" nie. | ⚠️ Fase 11: cache_ weg (net geheue), salaris/notas/oudit/verduideliking nie meer in KV nie; invoerblad en versteekte items nog oor |
| TS-06 | As 'n API-oproep faal, wys die skerm 'n fout — dit val nooit stil terug op ou gekaste data nie. | ✅ Fase 11: rooi waarskuwing as die bediener nie bereik word nie; geen stil terugval op ou blaaierdata nie |
| TS-07 | KV-skryf (solank dit nog bestaan) moet suksesvol wees of 'n fout wys. | ⚠️ Fase 11: oudit-skryf rapporteer foute; ou KV-brug bly vir die invoerblad |
| TS-09 | **BEVESTIG 2026-10-12:** toegang werk op **vlakke** wat die eienaar per gebruiker stel. Wat 'n gebruiker mag doen (voorberei, finaliseer, omkeer, ontsluit, uitvoer), hang van sy vlak af; 'n vlak met volle regte mag alles. | ⚠️ Rolle bestaan; moet teen hierdie reël nagegaan word |
| TS-10 | **BEVESTIG 2026-10-12:** vertroulike werknemers (bv. direkteure, die eienaar) is heeltemal onsigbaar vir gebruikers sonder vertroulike toegang — in lyste, payslips, verslae, rekon en banklêers (sien WN-14). | ⚠️ Basis bestaan |
| TS-08 | Elke wysiging aan payroll-data is in die ouditlog (wie, wat, wanneer, ou/nuwe waarde). | ⚠️ Gedeeltelik |

## ❓ Vrae vir Ruan

1. Is jy gemaklik dat ons die blaaier-kas heeltemal verwyder (die skerms sal dan net werk as die internet werk)?
