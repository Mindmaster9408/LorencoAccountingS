# Lorenco Ekostelsel: oudit uit drie hoeke, 27 November 2026

**Omvang:** die hele ekostelsel behalwe Coaching. Dit was 'n leesoudit: geen kode is verander nie en geen data is aangeraak nie.
**Drie hoeke:** (1) kode en sekuriteit, (2) rekenmeester en forensiese ouditeur, (3) entrepreneur met een besigheid of 'n groep.
**Bewysvlak:** elke bevinding is gemerk as **Bevestig** (in die kode gelees) of **Nagaan** (afgelei; moet op die lewendige stelsel bevestig word).

Paytime is op 18 Nov 2026 apart geoudit (`docs/paytime/OUDIT_2026-11-18.md`). H1 en H2 daarvan is reggestel in `c1bfd01`. Die data-items H3, M2, M3 en M4 en die lae items L1 tot L10 staan nog oop en word hier nie herhaal nie.

---

## 1. Opsomming: die 12 grootste risiko's

| # | Hoek | Ernst | Bevinding | Bewys |
|---|---|---|---|---|
| 1 | Rekenmeester | 🔴 | **BTW-verslae en die jaareinde-afsluiting hanteer omgekeerde joernale verkeerd.** Die oorspronklike verdwyn uit die syfers, maar die omkeer tel wel. Die netto fout is die volle bedrag, nie nul nie. | Bevestig |
| 2 | Rekenmeester | 🔴 | **'n POS-void sit nie voorraad terug nie.** Returns en cancel-order doen dit wel. | Bevestig |
| 3 | Forensies | 🔴 | **'n POS-void kan enige tyd gedoen word, ook ná die kasopmaak.** Daar is geen kontrole op die sessiestatus of op tyd nie. Dit is die klassieke afroom-patroon. | Bevestig |
| 4 | Kode | 🔴 | **Die Sean-, Inter-Company- en Payroll-Sean-roetes val terug na maatskappy 1** as die token geen maatskappy het nie, en `requireModule` slaan dan sy kontroles oor. | Bevestig |
| 5 | Kode/forensies | 🔴 | **Geen rate limit of uitsluiting** op login, registrasie en die bestuurder-PIN (4–6 syfers) nie. 'n Kassier kan die bestuurder se PIN raai en self voids en afslag goedkeur. | Bevestig |
| 6 | Entrepreneur | 🔴 | **Geen groepkonsolidasie nie.** Daar is geen groep-W&V of -balansstaat en geen uitskakeling van intermaatskappy-transaksies nie. Insights werk per maatskappy. | Bevestig |
| 7 | Forensies | 🟠 | **Geposte joernale en gesluite payroll-snapshots is nie op databasisvlak onveranderbaar nie.** Net `audit_log` en `pos_audit_events` het triggers. Die backend gebruik die service key, wat RLS omseil. | Bevestig |
| 8 | Kode/bewys | 🟠 | **Bankbylaes en die oorspronklike verskaffer-fakture word op die bediener se plaaslike skyf gestoor.** Op Render is dit tydelik: dit verdwyn by elke deploy, tensy 'n Render Disk gekoppel is. | Bevestig (kode) / Nagaan (Render) |
| 9 | Rekenmeester | 🟠 | **Debiteur- en krediteurstate ignoreer kredietnotas.** Die staat se saldo sal nie by die kontrolerekening uitkom nie. | Bevestig |
| 10 | Rekenmeester | 🟠 | **Rekeningkodes is hardgekodeer** (1100, 1400, 2300 …, 47 plekke). 'n Kliënt met 'n ander rekeningplan kry stilweg BTW R0 en 'n verkeerde kontrolerekon. | Bevestig |
| 11 | Kode | 🟠 | **Gestoorde XSS in Checkout Charlie.** Kliënt- en produkname word sonder escaping in die HTML gesit, en die JWT lê in localStorage, so dit kan gesteel word. | Bevestig |
| 12 | Besigheid | 🟠 | **Kontinuïteit:** geen gedokumenteerde rugsteun- of DR-plan nie, geen staging nie (push na main = produksie), geen toetse in CI nie, en die CI kan alle migrasies weer teen produksie laat loop. | Bevestig |

---

## 2. Hoek 1: kode en sekuriteit

### K1 🔴 Terugval na maatskappy 1 (Sean / Inter-Company / Payroll-Sean)
- `inter-company/routes.js:41`, `sean/routes.js:45,51` en `modules/payroll/routes/sean-integration.js:55` doen almal `req.companyId || req.user?.companyId || 1`.
- `middleware/module-check.js`: as `req.companyId` leeg is, word die maatskappy-module- en app-kontroles oorgeslaan.
- By login kry 'n gebruiker sonder 'n direkte `user_company_access`-ry 'n token met `companyId: null` (`shared/routes/auth.js:197`). Dit sluit praktyklede in wat net via 'n uitnodiging toegang het.
- **Gevolg:** so 'n gebruiker kan Sean-voorstelle lees en skryf, en intermaatskappy-fakture stuur of goedkeur, **as maatskappy 1 (Lorenco Ecosystem)**. Daar is ook geen `requirePermission` op die inter-company-roetes nie.
- `SEAN_DEFAULT_KEY`: as dit gestel is, deel alle maatskappye dieselfde enkripsiesleutel.
- **Regstelling:** sit `requireCompany` op `/api/sean`, `/api/inter-company` en `/api/payroll/sean`, en verwyder elke `|| 1`. Voeg permissies by vir stuur en goedkeur.

### K2 🔴 Geen beskerming teen brute force nie
- `/api/auth/login` en `/api/auth/register` het geen rate limiter nie, en daar is geen `failed_login`- of `locked_until`-logika nie (die enigste limiters is op die publieke Collector-roetes).
- Registrasie is publiek: enigiemand kan 'n rekening en 'n maatskappy skep.
- `modules/pos/routes/managerAuth.js:72` (`/verify`): 'n PIN van 4–6 syfers, sonder uitsluiting. Dit is hoogstens 10 000 pogings, en die kassier is reeds aangemeld.
- **Regstelling:** `express-rate-limit` op die auth-roetes, uitsluiting per rekening, en vir die PIN: 5 foute → 15 minute uitsluiting plus 'n audit-gebeurtenis en 'n waarskuwing aan die eienaar.

### K3 🟠 Supabase-foute word nie gelees nie, so kontroles faal in die verkeerde rigting
- `middleware/auth.js:154-167`: `const { data: user } = …` ignoreer `error`. 'n Kort DB-onderbreking word "Account not found", en daardie uitsluiting word **60 s lank gecache**. Die kommentaar sê die teenoorgestelde ("fail open").
- `modules/accounting/services/journalService.js:181` (`isPeriodLocked`): ignoreer `error`. By 'n DB-fout word die periode as **oop** behandel, en dan kan daar in 'n gesluite periode gepos word.
- **Regstelling:** lees `error` en kies doelbewus watter kant toe die kontrole faal. Vir periodeslotte moet dit altyd *toe* faal.

### K4 🟠 Gestoorde XSS in Checkout Charlie (`frontend-pos/index.html`)
- Waardes word sonder escaping in `innerHTML` gesit: `customer.name` (r. 13568), `item.name` (14939), `product.product_name` (17510, 17918), `c.customer_name` (21653), `c.name` (22039).
- Produkname kom dikwels uit verskaffer-CSV's. Die JWT is in localStorage, so 'n vervalste produknaam kan die token van elke kassier steel.
- Accounting, Practice en Payroll gebruik baie meer escaping. POS het 87 templates teenoor 42 escape-roepe.

### K5 🟠 Lêers op die plaaslike skyf
- `modules/accounting/routes/bank.js:155` (bankbylaes) en `supplierOcrDrafts.js:41` (oorspronklike faktuur-PDF's) skryf na `backend/uploads/`.
- Slips en Collector gebruik reeds Supabase Storage (`shared/services/storage.js`). Hierdie twee moet ook daarheen.
- **Nagaan:** is daar 'n Render Disk aan die diens gekoppel? Indien nie, is alle bestaande bylaes ná die laaste deploy reeds weg.

### K6 🟠 Deploy-pyplyn
- `.github/workflows/apply-migrations.yml` laat **elke** migrasie by elke push na main teen die DB loop, as `SUPABASE_DB_URL` as secret gestel is. Een nie-idempotente migrasie kan data vernietig. **Nagaan** of daardie secret gestel is (volgens die geheue loop migrasies met die hand).
- Geen jest of lint in CI nie; push na main gaan direk lewendig. Inline-skrifte in die HTML word deur geen gereedskap nagegaan nie (die ECO Hub het op 2026-11-19 so leeg geword).

### K7 🟡 Kleiner punte
| # | Bevinding | Plek |
|---|---|---|
| K7a | CORS laat enige `*.zeabur.app`/`*.zeabur.com`-oorsprong toe. Zeabur is afgetree, so verwyder dit. (Impak is beperk omdat bearer-tokens gebruik word.) | `server.js:135` |
| K7b | `/api/kv` (globale KV): enige gebruiker van die maatskappy, ook 'n kassier, kan alle sleutels lees, skryf en uitvee, sonder permissies. `company.html` skryf `seanKnowledge_*` en `integrations_*` daarheen (Part D). | `shared/routes/kv.js`, `frontend-accounting/company.html:1062,1304` |
| K7c | Lojaliteitspunte: `points` word nie gevalideer nie. Met 'n negatiewe redeem kry die kliënt punte by. Dit is ook lees-wysig-skryf sonder slot. | `shared/routes/customers.js:255-300` |
| K7d | `user_app_access`: leeg = alle apps. Dit is teenstrydig met die nuwe uitnodigingsmodel ("leeg = alles is weg"). | `middleware/module-check.js` |
| K7e | API-tokens vir bots verval by verstek nooit nie. Stel 'n verstek in (bv. 90 dae). | `shared/services/apiTokens.js:85` |
| K7f | Foutboodskappe gee `err.message` van Supabase/pg aan die kliënt terug (skema-inligting lek). | verskeie roetes |
| K7g | Onderhoubaarheid: `frontend-pos/index.html` is 22 444 reëls. `practice/` en `commander/` dra dubbele kopieë van dieselfde modules (secretarial ens.), so elke fout moet twee keer reggemaak word. | |

### Wat in orde is (nagegaan)
- Tenant-isolasie: die meeste roetes kyk eers `company_id` na voordat hulle volgens `id` skryf. Ek het geen direkte kruis-maatskappy-lek gevind nie.
- Rolle: `canManageRole` keer dat iemand 'n hoër rol toeken as sy eie.
- Die JWT-geheim word by opstart gevalideer, die sessie word elke 60 s teen die DB herbevestig, en rolveranderings dwing 'n nuwe aanmelding af.
- Bot-tokens word as SHA-256 gestoor, kan herroep word, en elke MCP-oproep word ge-audit.
- POS-pryse word op die bediener bepaal; die kliënt kan nie self afslag gee nie.

---

## 3. Hoek 2: rekenmeester en forensiese ouditeur

### R1 🔴 Omgekeerde joernale: BTW en jaareinde tel die bedrag dubbel

> **STATUS 2026-11-27: REGGESTEL (nog nie gecommit nie, staan op die commit-lys).**
> - Omkerings kry nou die oorspronklike datum en BTW-periode solank daardie periode oop is; anders vandag (`journalService._chooseReversalPlacement`).
> - Alle GL-somme in BTW, jaareinde en diagnostiek tel `posted` + `reversed`.
> - Die jaareinde gebruik een SQL-som: geen afkap by 1000 rye nie, en onaktiewe rekeninge sluit ook af.
> - Toetse: 18 nuwe jest-toetse, E2E 10/10 in maatskappy 51, volle stel 1687 groen.
> - Turkstra-data reggestel: 47 omkerings na Oktober geskuif. Oktober se inset-BTW bly R122 098,84 en November gaan van −R23 626,81 na R0. Rugsteun is in die tabel `zz_backup_audit_r1_20261127`, met 'n ry in `accounting_audit_log` (DATA_FIX).
>
> Die oorspronklike bevinding volg hieronder.
**Hoe dit werk:** `JournalService.reverseJournal` merk die oorspronklike as `status='reversed'` en skep 'n omkeer met `status='posted'` (`journalService.js:724`).
**Die fout:** die volgende navrae tel net `status='posted'`:
- `vatReportService.js:180,196,224,262` (die BTW201-syfers)
- `vatReturnsService.js:481`, `vatCategoryReportService.js`, `vatDetailReportService.js`, `vatReconciliationService.js`
- `yearEnd.js:167` (die saldo's vir die afsluitingsjoernaal)
- `legacy-gl.js`

**Gevolg:** oorspronklik +X word uitgesluit en die omkeer −X word ingesluit, so die totaal is −X. Dit moet 0 wees.
- **BTW:** 'n faktuur wat in 'n vorige periode uitgereik en nou omgekeer is, verminder die huidige periode se uitset-BTW met X, en die vorige periode word ook met X verminder as dit herbereken word. Ingediende opgawes is wel as momentopname vasgelê (`b53d226`), so die fout land in die *volgende* opgawe.
- **Jaareinde:** as albei in dieselfde jaar val, sluit die afsluitingsjoernaal −X na behoue verdienste af in plaas van 0.

`reports.js` is op 2026-09-02 reggestel (dit verreken nou na nul), maar dit is nooit na die BTW-dienste en die jaareinde deurgevoer nie. Dit stem ooreen met die oop punt in die geheue ("9 ander lêers").
**Regstelling:** gebruik `status IN ('posted','reversed')` in elke GL-somnavraag. Dit werk omdat die oorspronklike en die omkeer saam netto nul is. Daarna 'n eenmalige herrekening: watter maatskappye het omgekeerde BTW-joernale, en in watter opgawes?

### R2 🔴 'n POS-void sit nie voorraad terug nie
- `modules/pos/routes/sales.js:1625-1742`: die void verander die status, skryf die audit en keer die rekeninglas om, maar roep nie `restore_stock_for_return` nie. Returns (r. 1907) en cancel-order (r. 2185) roep dit wel.
- **Gevolg:** elke void laat die voorraad te laag. Dit veroorsaak voorraadopname-verskille, verkeerde herbestellings en verkeerde koste van verkope in Stockton.
- Wanneer 'n terugsit by 'n return of cancel misluk, is dit net 'n waarskuwing ("non-fatal"). Daar is geen herstelwerk-ry en geen sigbare uitsondering nie.

### R3 🔴 POS-voids ná die kasopmaak (forensies)
- Die void-roete kyk nie of die verkoop se till-sessie nog `open` is nie en het geen tydsperk nie.
- **Die klassieke skema:** lui die verkoop, gee die kliënt 'n strokie, vat die kontant, en void die verkoop ná die kasopmaak. Die kasopmaak het reeds klopgemaak, en die void vee die verkoop later uit die verkoopsyfers.
- Daar is wel goeie *opsporende* kontroles: `MANAGER_OVERRIDE` en `SALE_VOIDED` gaan na die onveranderbare `pos_audit_events`. Daar is egter geen *voorkomende* kontrole nie.
- **Nagaan:** as die POS→Leo-brug die dag se verkope reeds na die GL gepos het, word die GL nie deur die void reggestel nie. Die brug lees `status='completed'` slegs op die oomblik van pos.
- **Regstelling:** 'n void op 'n geslote of opgemaakte sessie moet 'n "return" word (eie dokument, eie datum, eie GL-impak), nie 'n terugwerkende void nie.
- **Nagaan:** die bediener dwing nie 'n oop till-sessie af wanneer 'n verkoop geskep word nie (`till_session_id || null`). As die frontend dit nie doen nie, kan 'n verkoop buite enige kasopmaak beland.

### R4 🔴 Funksieskeiding: bestuurder-PIN (sien K2)
'n PIN wat geraai kan word, maak elke bestuurder-goedkeuring (void, afslag, return) waardeloos as bewys. Die audit sê "goedgekeur deur Bestuurder X", maar dit was die kassier.

### R5 🟠 Onveranderbaarheid op databasisvlak
- Triggers wat UPDATE en DELETE blokkeer, bestaan net op `audit_log` (mig. 168) en `pos_audit_events` (mig. 028).
- **Geen** sulke trigger op `journals` en `journal_lines` waar `status <> 'draft'` nie, of op `payroll_snapshots` waar `is_locked = true` nie (CLAUDE.md Rule E6 berus net op die app-kode).
- Die backend gebruik `SUPABASE_SERVICE_KEY`, wat alle RLS omseil. Enige kodefout, script of persoon met DB-toegang kan geposte boeke stil verander.
- **Regstelling:** dieselfde patroon as mig. 168. Blokkeer UPDATE en DELETE op geposte joernale en hul lyne, behalwe die een toegelate oorgang `posted → reversed` met `reversed_by_journal_id`. Doen dieselfde vir gesluite snapshots.

### R6 🟠 Balans-toleransie van R0,01
`journalService.js:59` laat 'n joernaal toe wat tot 1c uit balans is (en vergelyk floats). Oor duisende joernale dryf die proefbalans weg. Rond eers albei kante tot sente af en eis dan presiese gelykheid.

### R7 🟠 Die jaareinde sluit nie die periode nie
`yearEnd.js:95`: `lockPeriod = false` is die verstek. Ná die afsluitingsjoernaal kan nog in die afgesluite jaar gepos word. Dan klop behoue verdienste nie meer met die W&V nie. Maak die slot die verstek. 'n Heropening moet 'n doelbewuste, ge-audite aksie wees.

### R8 🟠 State ignoreer kredietnotas
`customer-statements.js:41-55` en `supplier-statements.js` gebruik fakture min betalings. Kredietnotas en GL-aanpassings (afskrywings) word nie ingereken nie, so die kliënt kry 'n staat wat te veel sê hy skuld. Daar is wel 'n kontrolerekening-rekon (`reports.js:1273`), en dié behoort hierdie verskil uit te wys.

### R9 🟠 Hardgekodeerde rekeningkodes
47 plekke gebruik `'1100'`, `'1400'`, `'2300'` ens., insluitend die BTW201 (`vatReportService.js`: insette = 1400, uitset = 2300) en die kontrolerekon. Sodra 'n kliënt 'n ander rekeningplan gebruik (ingevoer uit Sage of Xero), gee die BTW-verslag stilweg nul.
**Regstelling:** stel rolle per maatskappy in (`vat_input_account_id`, `vat_output_account_id`, `ar_control_account_id` …), en waarsku as hulle ontbreek.

### R10 🟡 Faktuurnommering
`customerInvoiceCore.js:643`: die volgende nommer is `COUNT(*) + 1`, en dan word gebruikte nommers oorgeslaan. Nommers kan ook met die hand ingetik of verander word. Daar is geen gaping-verslag nie. Vir 'n forensiese ouditeur is 'n gaping-analise van faktuurnommers 'n standaardtoets, en SARS vereis unieke tax invoices. Gebruik 'n reeks per maatskappy en 'n verslag van uitgevee of gekanselleerde nommers.

### R11 🟡 Ander
| # | Bevinding | Plek |
|---|---|---|
| R11a | Die bankrekon-lys van onafgestemde items word stilweg by 1000 rye afgesny (Supabase-limiet). | `reports.js:475` |
| R11b | BTW-koers val terug na 15% as 'n lyn geen koers het nie. Dit is gevaarlik vir die internasionale uitrol. | `customer-invoices.js` |
| R11c | Bots (MCP) pos na die GL as 'n gewone gebruiker. Die Bot Review- en besluitreëls is goed, maar bevestig dat *geen* skryf-tool Bot Review omseil wanneer die beleid "menslike goedkeuring" sê nie. | `modules/mcp/tools.js` |
| R11d | Paytime: data-items H3 (Turkstra-belastingnommers en bankbesonderhede), M2 (ABSA/FNB-kodes) en M4 (Annual Bonus) staan nog oop. Lees die 18 Nov-verslag. | |

### Wat sterk is vir 'n ouditeur
- Joernale word atomies geskep, gewysig en omgekeer in pg-transaksies, met 'n waarborg teen dubbele omkering (CAS plus 'n unieke indeks).
- BTW-periodeslot plus "out-of-period"-routering; ingediende BTW-opgawes word vasgelê en verskille word oorgedra.
- `audit_log` is append-only op databasisvlak; POS het 'n eie onveranderbare audit-spoor; omkerings vereis 'n rede.
- Daar is 'n forensiese kontrolerekening-rekon (debiteure en krediteure teenoor die subgrootboek).
- Paytime: gesluite snapshots, atomiese finalisering (sedert `c1bfd01`) en 'n golden-test-hek.

---

## 4. Hoek 3: entrepreneur (een besigheid teenoor 'n groep)

### As ek een besigheid het
**Wat goed werk:**
- Een aanmelding, met POS → Leo (konsep-kasfakture), Paytime → Leo-joernaal en bankstaat-invoer met leer.
- Insights gee die eienaar 'n prentjie op een blad.

**Wat my sal pla:**
1. **Te veel apps en name** (Leo, Charlie, Stockton, Paytime, Firmflow, Insights, Slips, Collector, Sean). Daar is geen "begin hier"-pad vir 'n nuwe kliënt nie. Ek moet weet watter app om eerste op te stel en in watter volgorde (rekeningplan, BTW, bank, werknemers).
2. **Vertroue in die syfers:** R1 (BTW) en R2/R3 (voorraad en voids) is presies die soort foute wat 'n eienaar se vertroue breek sodra die rekenmeester dit raaksien.
3. **Afhanklikheid:** Slip-uitlees (laag 3) en die help-bot loop op Ollama op **Ruan se rekenaar**. As daardie rekenaar af is, werk dit nie. Vir 'n betalende kliënt is dit 'n diensvlak-risiko.
4. **Sean se waarde is grootliks afgeskakel** (betaalde ekstra, token nie gestel nie). Die "AI-boekhouer"-belofte is nog nie sigbaar vir die kliënt nie.

### As ek 'n groep het (bv. Turkstra/Pennygrow-tipe)
1. **E1 🔴 Geen konsolidasie nie.** Daar is geen groep-W&V, groep-balansstaat of groep-kontantvloei nie, en geen uitskakeling van intermaatskappy-verkope, -lenings en -dividende nie. Insights werk per maatskappy. Die groepeienaar wissel tussen maatskappye en tel in Excel op. Vir 'n groep is dit **die** ontbrekende funksie.
2. **E2 🟠 Intermaatskappy is drie stelsels, nie een storie nie:**
   - Company Links (verskaffer ↔ kliënt word gespieël en daar is 'n rekonstaat). Dit is die beste een en is lewendig geverifieer.
   - Die Inter-Company-faktuurenjin (`inter-company/`). Dit is agter die `sean`-addon gesluit en het die K1-fout.
   - POS company-transfers (voorraad tussen maatskappye).

   Daar is geen intermaatskappy-leningsrekening wat outomaties aan albei kante klop nie, en geen groepverslag wat wys "maatskappy A sê B skuld R100 000, B sê R95 000" nie.
3. **E3 🟠 Payroll per maatskappy:** 'n werknemer wat vir twee groepmaatskappye werk, is twee rekords. Daar is geen groepkoste- of koptelling-oorsig nie. (Nagaan of dit vir die groepkliënte saak maak.)
4. **E4 🟠 Gebruikerservaring vir die groep:** toegang tot meer as een maatskappy werk (user_company_access). Maar om te wissel moet ek elke keer 'n nuwe token kry, en daar is geen "al my maatskappye"-dashboard met die kontant, debiteure en BTW wat verskuldig is per maatskappy op een blad nie.
5. **E5 🟠 Fakturering vir die groep:** fakturering is per maatskappy per app. Daar is geen groepprys of groepfaktuur nie (en die app-pryse is nog leeg).

### As ek die eienaar van Lorenco is (besigheidsrisiko)
| # | Risiko | Waarom dit saak maak |
|---|---|---|
| B1 | **Geen gedokumenteerde rugsteun- of DR-plan nie** (geen dokument in die repo nie; die Supabase-PITR-status is onbekend) | 'n Rekeningkundige en payroll-platform sonder 'n getoetste herstel is 'n bestaansrisiko. **Nagaan:** watter Supabase-plan, en is PITR aan? |
| B2 | Geen staging nie: alle toetse gebeur in maatskappy 51 *in die produksie-DB*, en push = lewendig | Een slegte migrasie of script raak almal |
| B3 | Bus factor: Ruan plus Claude | Kennis sit in geheue-lêers en handoffs, nie in 'n span nie |
| B4 | Omvangsprei: Commander is 'n volle kopie van Firmflow, sean-webapp is nog nooit ontplooi nie, en daar is baie "concept"-apps | Elke nuwe app vermeerder die onderhoud. Die kernboeke (Leo, Paytime) het nog R1, R5 en R9 oop |
| B5 | Nakoming: POPIA (waar is die data gehuisves? 'n privaatheidsbeleid?), SARS-bewaring (5 jaar; julle mik op 7) en uitvoer vir die kliënt ("kry my data uit") | 'n Kliënt of sy ouditeur sal dit vra voor hulle teken |
| B6 | Lêers op die tydelike skyf (K5) | Bewysstukke verdwyn; dit is 'n ouditbevinding teen die *kliënt* |

---

## 5. Voorgestelde volgorde (wag op Ruan se toestemming per item)

**Week 1: syfers wat verkeerd kan wees, en oop deure**
1. **R1:** omgekeerde joernale in BTW, jaareinde en legacy-gl. Daarna 'n navraag: watter maatskappye word geraak?
2. **K1:** `requireCompany` op Sean, Inter-Company en Payroll-Sean, en verwyder `|| 1`.
3. **K2/R4:** rate limit op login en registrasie, en uitsluiting op die bestuurder-PIN.
4. **K5:** bevestig of daar 'n Render Disk is. Indien nie, skuif bylaes na Supabase Storage.

**Week 2: POS-integriteit** (buite handelsure, Part G)
5. **R2:** voorraad terugsit by 'n void.
6. **R3:** 'n void ná die kasopmaak word 'n return. Dwing ook 'n oop sessie af wanneer 'n verkoop geskep word.
7. **K4:** escape kliënt- en produkname in `frontend-pos/index.html`.

**Week 3–4: ouditvastheid**
8. **R5:** onveranderbaarheid-triggers op geposte joernale en gesluite snapshots.
9. **R6, R7, R8:** presiese balans, jaareinde sluit by verstek, kredietnotas op state.
10. **R9:** rekeningrolle per maatskappy in plaas van hardgekodeerde kodes.
11. **K3:** lees Supabase-foute in die auth-, periodeslot- en ander kontroles.
12. **B1/K6:** rugsteun- en DR-dokument plus 'n hersteltoets; jest en lint in CI; bevestig die migrasie-workflow.

**Daarna: produk (groep)**
13. **E1:** konsolidasie-module (groepdefinisie, eienaarskap-%, uitskakelingsreëls, groep-W&V en -balansstaat in Insights).
14. **E2:** een intermaatskappy-storie bo-op Company Links, met 'n kruis-maatskappy-leningsrekon.
15. **E4:** "al my maatskappye"-dashboard.

---

## 6. Hoe dit nagegaan is
- Die backend se roete-montering (`server.js`), auth- en module-middleware, en sessie- en tokenlogika.
- Die rekeningkundige kern: `journalService.js` (skep, pos en omkeer), periodeslotte, jaareinde, BTW-dienste, state, faktuurnommering en die bank-toedeling.
- POS: die verkoop-, void-, return- en bestuurder-PIN-paaie.
- Die databasis: triggers, RLS en die service key, gesoek deur alle migrasies.
- Heuristiese soektogte oor die hele kodebasis: navrae volgens `id` sonder maatskappyfilter, Supabase-leesaksies sonder paginering, `innerHTML` sonder escaping, KV- en localStorage-skryfaksies, en hardgekodeerde rekeningkodes.
- Die Paytime-oudit van 18 Nov en die commits sedertdien.

**Nie gedoen nie:** geen lewendige DB-navrae (dus geen syfers oor hoeveel joernale of voids geraak word nie), geen penetrasietoets, en geen reël-vir-reël-lees van elke roete nie (die kodebasis het meer as 760 backend-lêers). Die heuristiese soektogte kan dinge gemis het. Die Practice/Firmflow-, Commander-, Collector- en Stockton-modules is net oppervlakkig nagegaan.
