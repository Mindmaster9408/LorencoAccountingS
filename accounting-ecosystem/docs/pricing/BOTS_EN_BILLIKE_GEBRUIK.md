# Bots, billike gebruik en pryse

> Notas vir Ruan, 18 November 2026. Niks hiervan is nog gebou nie; dit is besluite en idees om by pryse in ag te neem.
> Agtergrond: [Grok MCP-ondersoek](../accounting/GROK_MCP_INTEGRATION_AUDIT_2026-11-18.md).

## 1. Die beginsel (besluit deur Ruan)

- 'n Eksterne AI-bot (Grok of enige ander) wat 'n kliënt of praktyk self inbring, is vir Lorenco **net 'n werknemer-gebruiker**.
- Die praktyk se bestuurder besluit watter regte die bot kry — selfs alle regte. **Dit is sy besluit, nie Lorenco s'n nie.**
- Lorenco beperk **nie** hoeveel bots 'n praktyk hardloop nie.
- **Sean** is Lorenco se eie, ingeboude AI — dáár is ons verantwoordelik en besluit ons.
- Sean leer steeds by die bots: elke toekenning gaan deur dieselfde pospad as by 'n mens.

## 2. Billike-gebruik-limiet (voorgestel)

Dit beperk niemand se **regte** of **aantal bots** nie — net die **tempo**, sodat een kliënt se bots nie ander kliënte se Paytime of Checkout Charlie stadig maak nie. Geld net vir bot-sleutels; mense in die blaaier merk niks.

| Laag | Voorgestelde limiet |
|---|---|
| Per gebruiker (elke bot) | 60 versoeke per minuut, kort uitbarsting tot 120 |
| Per maatskappy (alle bots saam) | 600 per minuut |
| Swaar aksies (invoer, PDF-verslae) | 10 per minuut per gebruiker |

Oor die limiet: die bot kry "wag 'n bietjie" (HTTP 429 met hoe lank) en probeer weer. Niks breek nie; dit word aangeteken. Getalle is 'n begin — verhoog as die bediener meer hanteer.

## 3. Dink hieraan vir pryse

**a. Bots as gebruikers = lisensies per gebruiker.**
As pryse ooit per gebruiker is, is 'n bot 'n gebruiker. Besluit of 'n bot dieselfde kos as 'n mens, of 'n eie (laer of hoër) tarief het.

**b. API/MCP-toegang as byvoeging.**
Die bot-koppeling kos ons bedienerkrag (elke versoek) en ondersteuning. Opsies:
- Ingesluit in die app-prys, met die billike-gebruik-limiet hierbo.
- 'n Byvoeging ("Bot-koppeling" / "API-toegang") per maand per praktyk.
- Vlakke: bv. *Standaard* (60/min per bot) en *Pro* (hoër limiet) — die limiet word dan deel van die produk.

**c. Gebruik meet voordat jy prys.**
Die bot-koppeling teken elke versoek aan. Hardloop dit 'n paar maande met die limiet, kyk wat praktyke werklik gebruik, en prys dan. Moenie raai nie.

**d. Swaar werk kos meer.**
Invoere (PDF lees, OCR), PDF-verslae en Sean se maandeinde-oorsig is die duurste. As ooit volume-gebaseer, tel hierdie apart.

**e. Sean se waarde.**
Bots maak Sean slimmer (hulle toekennings word leergebeurtenisse). Dit bevoordeel alle kliënte. Hou dit in gedagte as argument vir die Sean-byvoeging se prys — en as rede om bot-gebruik nie te duur te maak nie.

**f. Verantwoordelikheid in die terme.**
Omdat die praktyk die bot inbring en sy regte bepaal, moet die diensbepalings sê:
- die praktyk is verantwoordelik vir wat sy bot doen en vir die data wat die bot na 'n derde party (bv. xAI) stuur (POPIA: die praktyk is die verantwoordelike party);
- Lorenco verskaf die platform, beskerm maatskappy-isolasie, hou die ouditspoor, en mag 'n billike-gebruik-limiet toepas.

**g. Ondersteuning.**
"My bot werk nie" gaan oproepe bring. Besluit of bot-ondersteuning ingesluit is, of net vir 'n betaalde vlak.

## 4. Oop vrae vir Ruan

1. Kos 'n bot-gebruiker dieselfde as 'n mens-gebruiker?
2. Is die bot-koppeling ingesluit of 'n byvoeging?
3. Een limiet vir almal, of vlakke?
4. Wie skryf die diensbepalings-klousule oor bots (CLO)?
