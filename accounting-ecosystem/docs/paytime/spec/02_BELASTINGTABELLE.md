# 02 — Belastingtabelle en wetgewing

> Status: **KONSEP** · Raak: elke PAYE-, UIF- en SDL-syfer in die stelsel

## Doel

Die program moet vir elke betaalperiode outomaties die korrekte SARS-tabelle van **daardie periode se belastingjaar** gebruik (1 Maart – laaste dag van Februarie), en kan bewys watter tabelle gebruik is.

## Reëls

| # | Reël | Status |
|---|---|---|
| BT-01 | Tabelle word per belastingjaar gestoor (skale, primêre/sekondêre/tersiêre korting, mediese krediete, UIF-koers en -plafon, SDL-koers), elk met 'n bronverwysing (SARS-URL/datum). | ❌ Een globale `tax_config` in KV + hardgekodeerde tabelle [W3] |
| BT-02 | 'n Periode gebruik altyd die tabel van sy eie belastingjaar — ook by herberekening van 'n ou periode. | ❌ Globale tabel geld vir alle jare [W3] |
| BT-03 | Die 2027-jaar (Mrt 2026 – Feb 2027): skale 245 100 / 383 100 / 530 200 / 695 800 / 887 000 / 1 878 600; kortings R17 820 / R9 765 / R3 249; mediese krediet R376 / R376 / R254. | ❌ Kode het nog 2026-syfers [K1] — verifieer of DB-oorskrywing reeds bestaan |
| BT-04 | Historiese jare korrek: 2023-jaar kortings 16 425/9 000/2 997, medies 347/234; 2024-jaar kortings 17 235/9 444/3 145, medies 364/246. | ❌ Een jaar agter [W2] |
| BT-05 | Skaalformule: basis + koers × (inkomste **bo** die vorige skaal se maksimum), presies soos SARS dit publiseer. | ⚠️ 1 rand verskuif — sente-verskil [B10] |
| BT-06 | Nuwe jaar se tabelle kan vooraf gelaai word, maar word eers vanaf 1 Maart gebruik. | ❌ Tans geld 'n nuwe tabel onmiddellik vir alle periodes |
| BT-07 | **BEVESTIG 2026-10-12:** slegs 'n **super user** (Infinite Legacy as die programmaker) kan belastingtabelle invoer of verander. Geen tweede goedkeuring nodig nie — solank dit korrek is. Kliëntmaatskappye kan dit sien maar nie verander nie. Elke verandering word geoudit (wie, wanneer, ou/nuwe waardes). | ⚠️ Super-admin-hek bestaan; volle ouditspoor ontbreek |
| BT-08 | Gereedheidskontrole: vanaf 1 Februarie wys die stelsel 'n waarskuwing as die volgende jaar se tabelle nie bevestig is nie; Maart-payroll word geblokkeer tot dit bevestig is. | 🆕 |
| BT-09 | Elke snapshot stoor die belastingjaar en 'n verwysing/hash van die presiese tabel wat gebruik is. | ❌ [B7] |
| BT-10 | UIF: 1% werknemer + 1% werkgewer, plafon R17 712/maand (R177,12 elk). | ✅ |
| BT-11 | SDL: 1% van leviable remuneration; 0 as maatskappy nie geregistreer is nie (onder R500k payroll per jaar). | ✅ (vlag-gebaseer) |

## Waarom die oorskakeling na 'n nuwe belastingjaar tans so moeilik is (nagegaan 2026-10-12)

Ruan se vraag: *"Hoekom maak die program dit so moeilik om na die volgende belastingperiode se tabelle te skuif? Dit moet mos net reg wees."*

**Oorsaak — die ontwerp het een "aktiewe jaar" in plaas van "elke periode kies sy eie jaar":**

1. Op *Payroll Items → Tax Configuration* hou die stelsel 'n lys jare (`tax_years_v2`) in die **KV-stoor, per maatskappy** — nie in 'n behoorlike databasistabel nie.
2. Een jaar word met die hand as die **"active calculation year"** gekies. Net dié jaar se tabel word as die globale `tax_config` gestoor.
3. Die backend gebruik dan **daardie een tabel vir elke periode**, ongeag die datum. Dit lei tot drie probleme:
   - Voordat iemand die knoppie druk, word Maart (nuwe jaar) met verlede jaar se tabelle bereken.
   - Nadat iemand die knoppie druk, word Februarie (ou jaar) — as dit nog nie gefinaliseer is nie — en enige vroeër periode met die **nuwe** jaar se tabelle bereken.
   - As die nuwe jaar se syfers nie ingetik is nie, gebruik die enjin stilweg die nuutste jaar wat dit ken, sonder om te waarsku.
4. Die nuwe jaar se syfers moet elke jaar met die hand ingetik word, en die standaardwaardes in die kode (in **twee** enjin-lêers) moet ook met die hand bygewerk word.

| # | Reël (hoe dit MOET werk) | Status |
|---|---|---|
| BT-12 | Daar is **geen "aktiewe jaar"-knoppie** nie. Die stelsel kies outomaties die tabel volgens die periode se datum: Maart 2027 → 2027/28-tabel, Februarie 2027 → 2026/27-tabel. Ou en nuwe jaar kan in dieselfde week langs mekaar bereken word. | ❌ Een handmatige aktiewe jaar |
| BT-13 | Al die jare se tabelle word in **een databasistabel** gestoor (nie KV nie, nie per maatskappy nie), elk met "geldig vanaf / tot". | ❌ |
| BT-14 | Die enigste jaarlikse werk is om die nuwe jaar se syfers **een keer** in te voer nadat die begroting in Februarie aangekondig is (of dit kom saam met 'n kode-opdatering). Daarna gebeur alles vanself. | ❌ |
| BT-15 | As 'n periode in 'n jaar val waarvoor daar nog geen bevestigde tabel is nie, waarsku die stelsel duidelik (sien BT-08) — dit gebruik nooit stilweg 'n ander jaar se tabel nie. | ❌ Stil terugval na die nuutste bekende jaar |

## ❓ Vrae vir Ruan

1. ~~Tweede goedkeurder~~ → **BEANTWOORD:** nee; net die super user voer dit in (BT-07).
2. Mag 'n individuele kliëntmaatskappy ooit sy eie tabel hê (bv. buitelandse maatskappye in Commander), of is SA-tabelle altyd globaal?
3. Moet die Maart-payroll regtig **geblokkeer** word as die nuwe tabelle nie bevestig is nie, of net 'n waarskuwing?
