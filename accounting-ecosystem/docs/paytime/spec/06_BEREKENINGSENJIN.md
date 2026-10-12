# 06 — Berekeningsenjin

> Status: **KONSEP** · Lêer: `backend/core/payroll-engine.js` (die enigste enjin) · Raak: alles

## Doel

Vir een werknemer en een periode: bereken bruto, belasbare inkomste, PAYE, UIF (werknemer + werkgewer), SDL, aftrekkings en netto — volgens SARS se Vierde Bylae en die UIF-wet — en verduidelik hoe elke syfer bereken is.

## A. Die volgorde van die berekening

1. Basiese salaris (pro-rata indien begin/einde in die maand)
2. \+ herhalende verdienste (belasbare % toegepas)
3. \+ eenmalige insette, oortyd, multi-rate
4. − short time
5. = **bruto**
6. − pre-tax aftrekkings (pensioen/RA, binne limiet) → **belasbare inkomste**, verdeel in *herhalend* en *eenmalig*
7. **PAYE** (sien B), minus mediese krediet, plus vrywillige ekstra belasting
8. **UIF** op UIF-basis (plafon), **SDL** op bruto
9. **Netto** = bruto − PAYE − UIF − alle werknemer-aftrekkings

Status: ✅ Die volgorde in die kode stem hiermee ooreen.

## B. PAYE-metode — **die belangrikste besluit**

SARS se beginsel: herhalende inkomste word geannualiseer; **eenmalige** inkomste (bonus) se volle ekstra belasting word in die maand van betaling afgetrek; die jaar se totaal moet teen Februarie die werklike aanspreeklikheid wees.

| # | Reël | Status |
|---|---|---|
| ENJ-01 | Eenmalige inkomste (bonus) word **nie** geannualiseer nie; die volle ekstra belasting word in die betaalmaand afgetrek. | ✅ maandmetode · ❌ standaard YTD-metode annualiseer dit steeds [K3] |
| ENJ-02 | 'n Werknemer wat middel in die jaar begin, word geannualiseer op grond van die **maande wat hy werk**, nie die kalendermaand nie. | ❌ PAYE ≈ R0 vir maande [K2] |
| ENJ-03 | YTD/kumulatiewe aanpassing gebruik net geslote vorige maande in **dieselfde** belastingjaar en word geblokkeer as 'n vorige maand nog nie gefinaliseer is nie. | ⚠️ Gebruik net geslote maande, maar geen volgorde-blok [V2] |
| ENJ-04 | Die metode wat vir 'n snapshot gebruik is, word in die snapshot gestoor. | ✅ (`_meta.ytdMethod`) |
| ENJ-05 | Belastingdirektief (persentasie) vervang die tabelberekening; IRP3(a)-direktiewe (vaste bedrag op 'n lump sum) word ook ondersteun. | ⚠️ Net persentasie |
| ENJ-06 | Mediese krediet per maand: hooflid + eerste afhanklike + addisionele afhanklikes, verminder PAYE (nooit onder 0). | ✅ |

**BEVESTIG deur Ruan 2026-10-12:** gebruik die aanbevole SARS-kumulatiewe metode hieronder, **saam met** afdeling E (Voluntary PAYE): vrywillige ekstra PAYE word nie in YTD teruggegee nie (VPA-10), behalwe Bonus Spread, wat as "reeds betaal" teen die bonus se belasting tel (VPA-14/15).

Die metode:
`jaarekwivalent = (herhalende belasbare inkomste tot datum ÷ maande gewerk × 12) + alle eenmalige inkomste tot datum`
`PAYE hierdie maand = (jaarbelasting × maande gewerk ÷ 12) + eenmalige belasting − PAYE reeds afgetrek`
Dit gee in die meeste gevalle presies die tabelbedrag, hanteer bonusse soos SARS, en korrigeer self teen Februarie.

## C. UIF en SDL

| # | Reël | Status |
|---|---|---|
| ENJ-10 | UIF = 1% van UIF-remunerasie, plafon R177,12; werkgewer betaal dieselfde bedrag. | ✅ |
| ENJ-11 | **BEVESTIG deur Ruan 2026-10-12: direkteure betaal UIF.** Geen UIF slegs vir: werknemers met 'n UIF-vrystelling (per werknemer gestel) en maatskappye wat nie UIF-geregistreer is nie. | ❌ Enjin stel tans UIF = 0 vir direkteure; werknemer-vrystelling word nie gelees nie [B9] |
| ENJ-12 | SDL = 1% van bruto (leviable amount); 0 as maatskappy vrygestel. Belastingvrye terugbetalings tel nie. | ⚠️ Belastingvrye inkomste tel tans by SDL |

## D. Pro-rata

| # | Reël | Status |
|---|---|---|
| ENJ-20 | Faktor = geskeduleerde ure gewerk ÷ geskeduleerde ure in die maand, **sonder afronding** (net die rand-bedrag word na sente afgerond). | ❌ Faktor afgerond na 2 desimale (R109 fout op R30k) [B8] |
| ENJ-21 | **BEVESTIG 2026-10-12:** basiese salaris **en vaste toelaes** word pro-rata bereken vir iemand wat middel in die maand begin of eindig. (Eenmalige insette, oortyd en aftrekkings nie.) | ⚠️ Net basiese salaris tans |

## E. Vrywillige PAYE-aanpassing (Voluntary PAYE Adjustment)

> Afdeling **BEVESTIG deur Ruan op 2026-10-12** (volledig).
> Skerm: werknemer-detail → Payslip-oortjie → "Voluntary PAYE Adjustment". Gestoor in `employees.voluntary_tax_config` (SQL).

### E.1 Hoofreël

**PAYE mag nooit minder wees as die statutêre bedrag nie.** Vrywillige aanpassings mag net **meer** belasting aftrek, nooit minder nie. Die enigste uitsondering is Bonus Spread (E.4), en dit net binne die reëls daar.

### E.2 Watter opsies is aktief

| Opsie | Status volgens Ruan | Hoe |
|---|---|---|
| **Fixed Monthly** (verhoog) | AKTIEF | — |
| **Target PAYE Amount** | AKTIEF | — |
| **Bonus Spread** | AKTIEF | — |
| **Variable (Period)** | **ONAKTIEF** | Knoppie versteek/gedeaktiveer. Kode **bly**, word net nie meer aangebied nie. |
| **Reduce PAYE** (rigting "verlaag" by Fixed/Variable) | **ONAKTIEF** | Knoppie versteek/gedeaktiveer. Kode **bly**, word net nie meer aangebied nie. |

Onaktief beteken: die kode word **nie uitgehaal nie**. Dit word net deur 'n instelling/vlag afgeskakel, sodat dit later weer aangeskakel kan word.

### E.3 Reëls per opsie

| # | Reël | Status |
|---|---|---|
| VPA-01 | **Fixed Monthly:** vaste ekstra bedrag bo-op die statutêre PAYE elke maand. | ✅ |
| VPA-02 | Fixed Monthly en Target PAYE kry 'n **opsionele begin- en eindmaand**. As dit leeg gelaat word, geld dit elke maand (soos nou). | ❌ Bestaan nie — geld tans altyd |
| VPA-03 | **Target PAYE:** as die teiken **hoër** as statutêr is, word die verskil as ekstra PAYE bygevoeg. | ✅ |
| VPA-04 | **Target PAYE:** as die teiken **laer** as statutêr is, word die statutêre PAYE afgetrek (statutêr wen) en die gebruiker kry 'n **waarskuwing** (op die skerm en in die Execute Payroll-resultate). | ❌ Bring PAYE tans tot by die teiken, ook onder statutêr [W6] |
| VPA-05 | 'n Rede is verpligtend vir Target PAYE en word op die **backend** afgedwing, nie net op die skerm nie. | ⚠️ Net skerm |
| VPA-06 | Variable (Period) en Reduce PAYE is onaktief vir nuwe inskrywings (E.2). | ❌ Tans aktief |
| VPA-07 | Verskeie inskrywings mag saam bestaan; elkeen verskyn as 'n **aparte lyn** op die payslip-skerm **en** die PDF, met sy beskrywing/rede. | ❌ Skerm wys een saamgevoegde lyn; PDF wys die aanpassing glad nie apart nie |
| VPA-08 | Stoor van 'n inskrywing wys sukses of 'n fout. 'n Inskrywing verskyn nie op die skerm as dit nie in die databasis gestoor is nie. | ❌ Stoor sonder foutboodskap |
| VPA-09 | Die snapshot stoor elke aanpassing apart (tipe, bedrag, rede), sodat 'n herdruk dieselfde lyne wys. | ⚠️ Net die totaal + die config in die invoer |
| VPA-10 | Vrywillige ekstra PAYE word **nie** in die volgende maande se YTD-berekening teruggegee nie: dit bly 'n oorbetaling wat SARS by assessering terugbetaal. **Uitsondering:** Bonus Spread (VPA-15). | ✅ (YTD gebruik `paye_base`) |

### E.4 Bonus Spread — hoe Ruan dit beskryf

1. Die gebruiker sleutel die **bonusbedrag** in.
2. Die stelsel bereken **X**: die ekstra belasting wat die bonus in sy betaalmaand sou veroorsaak (statutêre PAYE mét bonus − sonder bonus, vir daardie maand).
3. Die gebruiker kies om X oor **Y maande** te betaal, vanaf 'n gekose maand. Maandbedrag = X ÷ Y.
4. Alles moet betaal wees **voor die einde van die belastingjaar** (laaste maand = Februarie).
5. **Wanneer die bonus werklik betaal word, weet die stelsel dat die belasting daarop reeds (gedeeltelik) in ag geneem is, en trek dit nie weer af nie.**

| # | Reël | Status |
|---|---|---|
| VPA-11 | Sakrekenaar: maandbedrag = X ÷ Y. | ❌ Tans X × 12 ÷ Y (12× te hoog) [K5] |
| VPA-12 | Die spreidingsmaande moet almal binne dieselfde belastingjaar as die bonusmaand val, en eindig uiterlik in Februarie. Die skerm laat nie 'n eindmaand ná Februarie toe nie. | ❌ Geen kontrole; tot 60 maande toegelaat |
| VPA-13 | Die Bonus Spread-inskrywing word gekoppel aan die **bonus self** (bonusbedrag + bonusmaand), sodat die stelsel die regte bonus herken wanneer dit as inset ingesleutel word. | ❌ Geen koppeling |
| VPA-14 | In die bonusmaand word die bonus se ekstra belasting verminder met wat reeds deur die spreiding betaal is. Dit word nooit minder as 0 nie. | ❌ Bonusbelasting word tans **weer** volledig afgetrek (dubbel) |
| VPA-15 | Spreidingsbedrae tel as "reeds betaal" teen die bonus se belasting (die uitsondering op VPA-10). | ❌ |
| VPA-16 | Is die werklike bonus **groter** as beplan, word die ekstra belasting op die verskil normaal in die bonusmaand afgetrek. Is dit **kleiner**, of word die bonus nie betaal nie, bly die oorbetaling staan en word dit op die payslip gewys. SARS betaal dit by assessering terug. | ❌ |
| VPA-17 | **Tydsberekening — BEVESTIG 2026-10-12: albei toegelaat.** Die spreiding mag vóór/tot by die bonusmaand loop (opsie A) **of** ook ná die bonusmaand (opsie B). Die skerm stel A voor. As enige spreidingsmaand ná die bonusmaand val (B), wys die stelsel 'n duidelike waarskuwing **voordat** dit gestoor word: *"Die PAYE in die bonusmaand sal laer wees as die statutêre bedrag. Die werkgewer kan by 'n SARS-oudit 'n penalty en rente kry. Die volle bedrag moet teen Februarie betaal wees."* Die gebruiker moet dit bevestig, en die bevestiging (wie en wanneer) word geoudit. Die waarskuwing verskyn ook in die Execute Payroll-resultate vir die bonusmaand. | ❌ Bestaan nie |

**Voorbeeld:** salaris R20 000, bonus R20 000 in Desember, X = R5 200, Y = 4 → R1 300/maand.
- **Opsie A (vooruit):** Sep–Des elk + R1 300. In Desember is die bonus se R5 200 reeds betaal, dus geen ekstra bonusbelasting nie. ✅ Altyd ≥ statutêr.
- **Opsie B (vanaf bonusmaand):** Des–Feb (maks. 3 maande). In Desember word net R1 300 van die R5 200 afgetrek. ⚠️ Desember se PAYE is onder statutêr; die werkgewer kan by 'n SARS-oudit 'n penalty en rente kry, al klop die jaartotaal.

### E.5 Bestaande inskrywings

| # | Reël | Status |
|---|---|---|
| VPA-20 | **BEVESTIG 2026-10-12:** Bestaande "Variable"- en "Reduce"-inskrywings wat reeds by werknemers gestoor is, hou op toepas vanaf die volgende **ongeslote** maand. Hulle bly sigbaar op die skerm, gemerk **"onaktief"**, en word nie uitgevee nie. | ❌ Werk tans nog |
| VPA-21 | Geslote (gefinaliseerde) payslips word nooit deur enige van hierdie veranderinge geraak nie. | ✅ |

## F. Algemeen

| # | Reël | Status |
|---|---|---|
| ENJ-40 | Daar is net een enjin; die frontend roep die backend vir elke syfer (ook Net-to-Gross en verslae). | ❌ Frontend-enjin nog in gebruik [B5] |
| ENJ-41 | Elke berekening is herhaalbaar: dieselfde invoer + tabelle = presies dieselfde uitset (goue toetse). | ⚠️ Toetse bestaan, 3 druip |
| ENJ-42 | **BEVESTIG 2026-10-12:** betaalfrekwensies **maandeliks, tweeweekliks, weekliks en daagliks** word ondersteun en korrek belas (12 / 26 / 52 / werkdae per jaar). Die frekwensie kom uit die maatskappy se instelling in *Company Details* (reeds ingebou: Monthly, Bi-Weekly, Weekly; Daily moet bygevoeg word) en die werknemer se betaalskedule. | 🆕 Enjin is tans net maandeliks |

## ❓ Vrae vir Ruan

1. ~~PAYE-metode~~ → **BEANTWOORD:** SARS-kumulatief, met inagneming van afdeling E.
2. ~~"Reduce" en "target_paye"~~ → **BEANTWOORD 2026-10-12:** Reduce en Variable onaktief (kode bly); Target PAYE: statutêr wen + waarskuwing (sien E). Bonus Spread: A en B albei toegelaat, met 'n waarskuwing vir B (VPA-17). Bestaande Variable/Reduce-inskrywings hou op toepas en word as "onaktief" gewys (VPA-20). Afdeling E is volledig bevestig.
3. ~~Pro-rata vir toelaes~~ → **BEANTWOORD:** ja (ENJ-21).
4. ~~Weeklikse betaling~~ → **BEANTWOORD:** maandeliks, tweeweekliks, weekliks en daagliks (ENJ-42).
5. ~~Kontrakteurs~~ → **BEANTWOORD 2026-10-12:** belas op die skale, geen UIF en geen SDL nie (WN-08).
