// spil.report.js — SPIL-E Profile report generator
//
// Generates two outputs from a completed spil_profiles row:
//
//   generateReport(results, respondentName, lang)
//     → { markdown: string, generatedAt: string }
//       The client-facing free report (11 sections).
//
//   generateInternalNotes(results, respondentName)
//     → { markdown: string, generatedAt: string }
//       Coach-facing internal notes (observations + talking points).
//
// Wording rules (from brief):
//   ✗ Do NOT use the word "entrepreneur"
//   ✓ Use "professional", "person", "individual", "leader", "builder" instead
//   ✓ INISIATIEF in top 3 of ranking triggers specific growth-potential language
//   ✓ Growth edge = lowest-ranked dimension
//   ✓ Primary driver = ranking[0]
//   ✓ Supporting strength = ranking[1]

import { SPIL_STRUCTURE } from './spil.config.js';

// ─── Dimension content blocks ─────────────────────────────────────────────────
// Provides all text needed for client report and coach internal notes.
// All wording follows the official SPIL-E brief (brief §7 and §8).
// Rule: NEVER use the word "entrepreneur" in any client-facing string.

const DIM_CONTENT = {
  STRUKTUUR: {
    coreWord:      'orde en beplanning',
    primaryDesc:   "Jou primêre dryfkrag is STRUKTUUR.\n\nJy is van nature gedryf deur orde, sisteme en voorspelbaarheid. Jy soek duidelike prosesse en planne voor jy volledig deelneem. Jy is geenergeer deur roetines, betroubaarheid en die bou van strukture wat werk.",
    supportingDesc: "Dit gee jou struktuur en volhouding. Jy bou nie net idees nie — jy organiseer hulle in uitvoerbare planne met duidelike stappe.",
    growthEdge:    "Dit beteken nie jy kan nie gestruktureerd wees nie. Dit beteken struktuur vereis meer bewuste moeite van jou. Jy mag vryheid, beweging of buigsaamheid verkies bo roetine en konsekwentheid.\n\nJou volgende vlak mag beter sisteme, duideliker roetines of sterker deursetting vereis.",
    lifeHigh:      'jy na orde, beplanning en voorspelbaarheid soek',
    lifeLow:       'sisteme en roetines meer bewuste moeite van jou vereis',
    strengthBrief: 'jy sisteme bou en stabiliteit skep',
    riskBrief:     'jy rigied of stadig kan raak wanneer iets onverwags gebeur',
    communication: 'Kommunikeer met hierdie persoon deur gebruik te maak van duidelike stappe, verwagtinge, tydlyne en struktuur.',
    workBest:      "'n struktureerde omgewing met duidelike prosesse, roetines en voorspelbare verwagtinge",
    workDrain:     'chaoties, ongeorganiseerde of onvoorspelbare omgewings',
    workPerform:   "duidelike doelwitte, gedefinieerde prosesse en stabiele, voorspelbare uitkomste"
  },
  PRESTASIE: {
    coreWord:      'aksie en vordering',
    primaryDesc:   "Jou primêre dryfkrag is PRESTASIE.\n\nJy is van nature gedryf deur aksie, momentum en die begeerte om resultate te sien. Jy wil nie net dink oor wat kan werk nie — jy wil dit beweeg, toets en verbeter. Jy is geenergeer deur vordering, prestasie en die gevoel dat jy aanbeweeg.",
    supportingDesc: "Dit gee jou beweging en uitvoering. Jy dink nie net oor wat kan werk nie — jy wil beweeg, toets, verbeter en resultate sien.",
    growthEdge:    "Dit beteken nie jy kan nie presteer nie. Dit beteken vinnige beweging en uitvoering vereis soms meer vertraging — genoeg om dieper te dink, beter te luister en te stabiliseer.\n\nJou volgende vlak mag meer geduld, dieper nadenke of groter bewustheid van ander se pas vereis.",
    lifeHigh:      'jy vinnig wil beweeg en resultate wil sien',
    lifeLow:       'jy langer mag neem om tot aksie oor te gaan',
    strengthBrief: 'jy uitvoer, momentum genereer en resultate lewer',
    riskBrief:     'jy ongeduldig of reaktief kan raak wanneer dinge te stadig voel',
    communication: 'Kommunikeer met hierdie persoon direk. Fokus op resultate, beweging, besluite en vordering.',
    workBest:      "'n vinnig bewegende, resultaatgedrewe omgewing met ruimte om te besluit en te lewer",
    workDrain:     'trae, oorbeplande of rigiede omgewings waar besluite stadig geneem word',
    workPerform:   "duidelike doelwitte, bewegingsvryheid en sigbare vordering"
  },
  INSIG: {
    coreWord:      'denke en begrip',
    primaryDesc:   "Jou primêre dryfkrag is INSIG.\n\nJy is van nature gedryf deur begrip, logika en die soeke na waarheid. Jy wil weet hoe en hoekom dinge werk. Jy soek duidelikheid, akkuraatheid en dieper betekenis voor jy volledig deelneem. Jy is geenergeer deur leer, probleemoplossing en die sien van die groter prentjie.",
    supportingDesc: "Dit gee jou diepte en duidelikheid. Jy verstaan nie net die situasie nie — jy ontleed dit, identifiseer patrone en bring logika in waar ander emosie bring.",
    growthEdge:    "Dit beteken nie jy kan nie analiseer nie. Dit beteken diep denke vereis soms meer bereidheid om met minder inligting aksie te neem.\n\nJou volgende vlak mag meer bereidheid vereis om te begin voordat alles perfek duidelik is.",
    lifeHigh:      'jy diep dink en eers wil verstaan voor jy optree',
    lifeLow:       'jy soms kan optree voordat jy die volle prentjie het',
    strengthBrief: 'jy komplekse probleme oplos en duidelike redenasies bied',
    riskBrief:     "jy kan oor-analiseer of aksie uitstel wanneer nie genoeg inligting beskikbaar is nie",
    communication: 'Kommunikeer met hierdie persoon deur logika, konteks, feite en die rede agter die besluit te gebruik.',
    workBest:      "'n omgewing wat diep denke, probleemoplossing en voortdurende leer aanmoedig",
    workDrain:     'oppervlakkige, onlogiese of suiwer emosioneel gedrewe omgewings',
    workPerform:   "duidelike redenasies, tyd om te analiseer en ruimte vir diep denkwerk"
  },
  LIEFDE: {
    coreWord:      'verbinding en sorg',
    primaryDesc:   "Jou primêre dryfkrag is LIEFDE.\n\nJy is van nature gedryf deur verbinding, sorg en die begeerte om te behoort en omgee te word. Verhoudings is die kern van jou energie. Jy bou vertroue, ondersteun mense en skep 'n gevoel van behoort. Jy is geenergeer deur egtheid, empatie en die wete dat jy vir ander beteken.",
    supportingDesc: "Dit gee jou die menslike dimensie. Jy verbind jou krag met die mense rondom jou en sorg dat niemand agterbly nie.",
    growthEdge:    "Dit beteken nie jy is nie lief nie. Dit beteken diep verbinding en sorg vir ander vereis soms meer bewuste aandag.\n\nJou volgende vlak mag vereis dat jy meer bewus word van die mense rondom jou, hoe hulle die situasie beleef, en waar jy nog meer waarlik kan ondersteun.",
    lifeHigh:      'jy baie omgee oor mense en diep in verhoudings investeer',
    lifeLow:       'jy soms meer op uitkomste as op mense se gevoelens fokus',
    strengthBrief: 'jy vertroue bou en mense werklik ondersteun',
    riskBrief:     'jy te veel van jouself kan gee of moeilike grense kan vermy',
    communication: "Kommunikeer met hierdie persoon deur sorg, verbinding, eerlikheid en verhoudingsvertroue.",
    workBest:      "'n mensgeoriënteerde, samewerkende omgewing met opregte verhoudings en ruimte vir verbinding",
    workDrain:     'koue, resultaat-alleen of onpersoonlike omgewings',
    workPerform:   "omgewings waar mense gesien word en verhoudings gewaardeer word"
  },
  EMOSIE: {
    coreWord:      'harmonie en stabiliteit',
    primaryDesc:   "Jou primêre dryfkrag is EMOSIE.\n\nJy is van nature gedryf deur harmonie, emosionele veiligheid en die soeke na balans. Jy beskerm jou emosionele energie en soek vrede in jou omgewing. Jy is geenergeer deur etiek, regverdigheid en die skep van 'n atmosfeer waar almal veilig voel.",
    supportingDesc: "Dit gee jou balans en kalmte. Jy sorg dat jou krag nie ten koste van ander gebeur nie en dat harmonie behoue bly in die proses.",
    growthEdge:    "Dit beteken nie jy is onstabiel nie. Dit beteken emosionele harmonie en kalmte vereis soms meer bewuste aandag.\n\nJou volgende vlak mag vereis dat jy spanning rondom jou aanpreek eerder as om dit te vermy of te ignoreer.",
    lifeHigh:      'jy harmonie soek en onnodige spanning vermy',
    lifeLow:       "jy minder bewus kan wees van die emosionele koste van jou aksies op ander",
    strengthBrief: "jy spanning verminder en 'n atmosfeer van kalmte skep",
    riskBrief:     'jy noodsaaklike gesprekke of konfrontasies kan uitstel omdat dit spanning veroorsaak',
    communication: 'Kommunikeer met hierdie persoon rustig. Vermy onnodige druk, konflik of emosionele chaos.',
    workBest:      "'n vreedsame, etiese en harmoniese omgewing",
    workDrain:     'hoog-druk, konflikryke of onregverdige omgewings',
    workPerform:   "kalmte, duidelike grense en 'n etiese en respekvolle werksomgewing"
  },
  INISIATIEF: {
    coreWord:      'inisiatief en moontlikhede',
    primaryDesc:   "Jou primêre dryfkrag is INISIATIEF.\n\nJy is van nature gedryf deur die drang om te begin, te bou en moontlikhede te sien. Jy sien geleenthede waar ander probleme sien. Jy is gemaklik met onsekerheid en jy vat aksie selfs as jy nie alles weet nie. Jy is geenergeer deur die idee van iets nuuts skep of bou.",
    supportingDesc: "Dit gee jou die drang om te begin en te bou. Jy sien nie net die moontlikhede nie — jy wil iets daarmee doen en dit lewendig maak.",
    growthEdge:    "Dit beteken nie jy kan nie begin nie. Dit beteken inisiatief, risiko-toleransie en die bou van nuwe dinge vereis meer bewuste aandag.\n\nJou volgende vlak mag vereis dat jy meer gemaklik word met onsekerheid en kleiner risiko's begin neem.",
    lifeHigh:      'jy moontlikhede sien en aangetrek word na bou en begin',
    lifeLow:       "'n beproefde pad mag verkies bo die begin van iets nuuts",
    strengthBrief: "jy nuwe goed begin, geleenthede identifiseer en deur onsekerheid beweeg",
    riskBrief:     'jy te veel terselfdertyd begin of onderskat hoeveel struktuur en deursetting jy nodig het',
    communication: 'Kommunikeer met hierdie persoon deur moontlikhede, visie, groei, eienaarskap en wat gebou kan word.',
    workBest:      "'n nuwe, ongestruktureerde of groei-georiënteerde omgewing waar jy kan bou en skep",
    workDrain:     'rigiede, beperkende omgewings waar niks nuuts gebou of begin word nie',
    workPerform:   "eienaarskap, vryheid om te eksperimenteer en ruimte om nuwe idees en geleenthede na te volg"
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dimName(dim) {
    return SPIL_STRUCTURE.dimensions[dim]?.name ?? dim;
}

// ─── generateReport ───────────────────────────────────────────────────────────
// Client-facing free report. 11 sections per the official SPIL-E brief.
//
// Section mapping:
//   Header          → name, date, SPIL code, score table
//   Section 1       → SPIL-E code explanation
//   Section 2       → Primary driver
//   Section 3       → Supporting strength
//   Section 4       → Growth potential (INISIATIEF logic)
//   Section 5       → Growth edge (lowest dimension)
//   Section 6       → How this shows up in life
//   Section 7       → Communication insight (primary driver)
//   Section 8       → Work/business insight (primary driver)
//   Section 9       → Reflection prompt (3 fixed questions from brief)
//   Section 10      → Next step / hook
//
// Rule: NEVER use the word "entrepreneur" in any client-facing output.
export function generateReport(results, respondentName = 'Jy', lang = 'af') {
    const { scores, ranking, spilCode, generatedAt } = results;

    const primary    = ranking[0];
    const supporting = ranking[1];
    const lowest     = ranking[ranking.length - 1];
    const inTop3     = ranking.slice(0, 3).includes('INISIATIEF');

    const name = respondentName ? String(respondentName).trim() : 'Jy';

    const P  = DIM_CONTENT[primary]    ?? {};
    const S  = DIM_CONTENT[supporting] ?? {};
    const Lo = DIM_CONTENT[lowest]     ?? {};

    const lines = [];

    // ── HEADER ────────────────────────────────────────────────────────────────
    lines.push('# Jou VITA Profiel');
    lines.push('');
    lines.push("*'n Praktiese insig in hoe jy dink, optree, verbind en bou.*");
    lines.push('');
    lines.push(`**Naam:** ${name}`);
    lines.push(`**Datum:** ${new Date(generatedAt).toLocaleDateString('af-ZA')}`);
    lines.push(`**VITA Kode:** ${spilCode}`);
    lines.push('');
    lines.push('| Dimensie | Telling |');
    lines.push('|---|---|');
    for (const dim of ranking) {
        lines.push(`| ${dimName(dim)} | ${scores[dim] ?? 0}/100 |`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── VITA EXPLANATION SECTION ──────────────────────────────────────────────
    lines.push('## Wat VITA Verteenwoordig');
    lines.push('');
    lines.push('VITA wys hoe jy dink (Insig), optree (Toewyding), verbind (Aansluiting), voel (Lewe) en waarheen jy beweeg (Visie).');
    lines.push('');
    lines.push('| | Interpretasie | Dryfkrag |');
    lines.push('|---|---|---|');
    lines.push('| **V — Visie** | Rigting, roeping, langtermyn-denke | INISIATIEF + INSIG |');
    lines.push('| **I — Insig** | Kennis, wysheid, duidelikheid | INSIG |');
    lines.push('| **T — Toewyding** | Aksie, verbintenis, uitvoering | PRESTASIE |');
    lines.push('| **A — Aansluiting** | Verhoudings, verbinding, empatie | LIEFDE |');
    lines.push('| **L — Lewe** | Emosionele toestand, balans, innerlike vrede | EMOSIE |');
    lines.push('');
    lines.push('*STRUKTUUR voed beide Visie (stabiliseer langtermyn-rigting) en Toewyding (volhoubare uitvoering) — dit is die fondasie van jou groei.*');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 1 — VITA CODE ─────────────────────────────────────────────────
    lines.push('## Jou VITA Kode');
    lines.push('');
    lines.push('Jou VITA kode is:');
    lines.push('');
    lines.push(`**${spilCode}**`);
    lines.push('');
    lines.push(`Dit beteken jou sterkste huidige dryfkragte is ${P.coreWord ?? dimName(primary)} en ${S.coreWord ?? dimName(supporting)}.`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 2 — PRIMARY DRIVER ────────────────────────────────────────────
    lines.push(`## Jou Primêre Dryfkrag: ${dimName(primary)}`);
    lines.push('');
    lines.push(P.primaryDesc ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 3 — SUPPORTING STRENGTH ──────────────────────────────────────
    lines.push(`## Jou Ondersteunende Sterkte: ${dimName(supporting)}`);
    lines.push('');
    lines.push(S.supportingDesc ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 4 — GROWTH POTENTIAL (INISIATIEF logic from brief §7 Sec 4) ──
    lines.push('## Jou Groeipotensiaalkrag');
    lines.push('');
    if (inTop3) {
        lines.push("Jou INISIATIEF-telling dui aan dat jy moontlik moontlikhede sien voordat ander dit sien. Jy mag intern getrek voel na bou, verbeter, skep of iets nuuts begin.");
        lines.push('');
        lines.push("Dit beteken nie jy moet noodwendig iets spesifiek besig word nie. Dit beteken jy mag 'n sterk interne dryfkrag dra om iets betekenisvolle te skep.");
    } else {
        lines.push(`Jou INISIATIEF-telling (${scores['INISIATIEF'] ?? 0}/100) wys hoe gemaklik jy tans is met onsekerheid, nuwe idees en begin sonder volledige sekerheid. Hierdie area kan groei met verloop van tyd as jou lewe of werk meer durf, kreatiwiteit of eienaarskap vereis.`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 5 — GROWTH EDGE (lowest dimension) ────────────────────────────
    lines.push(`## Jou Groeikant: ${dimName(lowest)}`);
    lines.push('');
    lines.push(Lo.growthEdge ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 6 — HOW THIS SHOWS UP IN LIFE ────────────────────────────────
    lines.push('## Hoe Dit In Jou Lewe Voorkom');
    lines.push('');
    const lifeHighP = P.lifeHigh ?? `${dimName(primary)} hoog is`;
    const lifeHighS = S.lifeHigh ?? `${dimName(supporting)} hoog is`;
    const lifeLowLo = Lo.lifeLow ?? `${dimName(lowest)} laag is`;
    const strengthP = P.strengthBrief ?? dimName(primary);
    const strengthS = S.strengthBrief ?? dimName(supporting);
    const riskP     = P.riskBrief ?? `dit spanning kan skep`;
    lines.push(`Omdat ${dimName(primary)} en ${dimName(supporting)} hoog is, ${lifeHighP} en ${lifeHighS}. Dit kan jou kragtig maak wanneer ${strengthP} en ${strengthS} saamwerk, maar ook spanning skep wanneer ${riskP}. Omdat ${dimName(lowest)} jou laagste dimensie is, beteken dit dat jy ${lifeLowLo}.`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 7 — COMMUNICATION INSIGHT ────────────────────────────────────
    lines.push('## Kommunikasie-insig');
    lines.push('');
    lines.push(`Gebaseer op jou primêre dryfkrag (${dimName(primary)}):`);
    lines.push('');
    lines.push(P.communication ?? '');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 8 — WORK / BUSINESS INSIGHT ──────────────────────────────────
    lines.push('## Werk- en Sakelewe-insig');
    lines.push('');
    lines.push(`Jy werk die beste wanneer jy toegang het tot ${P.workBest ?? dimName(primary)}. Jy mag uitgeput raak in ${P.workDrain ?? 'omgewings wat teen jou dryfkrag werk'}. Jy presteer beter wanneer jy ${P.workPerform ?? 'jou sterkste dryfkrag kan benut'} het.`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 9 — REFLECTION PROMPT (exact questions from brief §7 Sec 10) ─
    lines.push('## Refleksie-vrae');
    lines.push('');
    lines.push('1. Waar in jou lewe gebruik jy tans jou sterkste dryfkrag goed?');
    lines.push('2. Waar skep jou laagste dimensie wryging of vertraging?');
    lines.push('3. Wat is een klein aanpassing wat jou lewe of werk makliker sal maak hierdie week?');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── SECTION 10 — NEXT STEP / HOOK (exact wording from brief §7 Sec 11) ───
    lines.push('## Volgende Stap');
    lines.push('');
    lines.push('Hierdie verslag is slegs die beginpunt.');
    lines.push('');
    lines.push("Jou VITA Profiel wys jou natuurlike patroon, maar die ware transformasie kom deur te verstaan hoe hierdie patroon jou besluite, verhoudings, werk, energie en toekomstige rigting beïnvloed.");
    lines.push('');
    lines.push("Die volgende stap is om te ondersoek hoe om hierdie VITA Profiel prakties te gebruik in jou lewe, gesin, besigheid en nalatenskap-reis.");
    lines.push('');

    return {
        markdown:    lines.join('\n'),
        generatedAt: generatedAt ?? new Date().toISOString()
    };
}

// ─── generateInternalNotes ────────────────────────────────────────────────────
// Coach-facing internal notes. NOT shown to the respondent.
// Pattern detection rules are from the official SPIL-E brief, Section 9.
export function generateInternalNotes(results, respondentName = 'Respondent') {
    const { scores, ranking, spilCode, generatedAt } = results;

    const primary    = ranking[0];
    const supporting = ranking[1];
    const lowest     = ranking[ranking.length - 1];

    const name = respondentName ? String(respondentName).trim() : 'Respondent';

    // High = top 3 positions, Low = bottom 3 positions
    const top3  = new Set(ranking.slice(0, 3));
    const bot3  = new Set(ranking.slice(3));
    const isHigh = dim => top3.has(dim);
    const isLow  = dim => bot3.has(dim);

    const lines = [];

    // ── Header ────────────────────────────────────────────────────────────────
    lines.push(`# Interne Notas: ${name}`);
    lines.push('');
    lines.push(`**VITA Kode:** ${spilCode}`);
    lines.push(`**Gegenereer:** ${new Date(generatedAt).toLocaleString('af-ZA')}`);
    lines.push('');
    lines.push('> *Hierdie notas is vir die afrigter alleen. Deel dit nie met die kliënt nie.*');
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── Score summary ──────────────────────────────────────────────────────────
    lines.push('## Telling-opsomming');
    lines.push('');
    lines.push('| Dimensie | Telling | Rang |');
    lines.push('|---|---|---|');
    for (let i = 0; i < ranking.length; i++) {
        const dim = ranking[i];
        lines.push(`| ${dimName(dim)} | ${scores[dim] ?? 0}/100 | #${i + 1} |`);
    }
    lines.push('');

    // Spread analysis
    const allScores = ranking.map(d => scores[d] ?? 0);
    const maxScore  = Math.max(...allScores);
    const minScore  = Math.min(...allScores);
    const spread    = maxScore - minScore;
    lines.push(`**Verspreiding:** ${spread} punte (${minScore}–${maxScore})`);
    if (spread < 15) {
        lines.push('*Lae verspreiding — profiel is gebalanseerd. Kliënt kan diffuus of onbeslis voel rondom identiteit of rigting.*');
    } else if (spread > 40) {
        lines.push('*Hoë verspreiding — sterk gedifferensieerde dryfkragte. Duidelike prioriteite. Moontlike blinde kolle.*');
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── Profile observation ────────────────────────────────────────────────────
    lines.push('## Profiel-observasie');
    lines.push('');
    lines.push(`- Primêre dryfkrag:    **${dimName(primary)}** (${scores[primary] ?? 0}/100)`);
    lines.push(`- Ondersteunende krag: **${dimName(supporting)}** (${scores[supporting] ?? 0}/100)`);
    lines.push(`- Laagste dimensie:    **${dimName(lowest)}** (${scores[lowest] ?? 0}/100)`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // ── Pattern identification (brief §9 — all 6 patterns) ────────────────────
    lines.push('## Patroon-identifikasie');
    lines.push('');

    const patterns = [];

    // Pattern 1: High INISIATIEF + high INSIG + high PRESTASIE → Legacy Builder
    if (isHigh('INISIATIEF') && isHigh('INSIG') && isHigh('PRESTASIE')) {
        patterns.push('⚡ **Moontlike Nalatenskapbouer-patroon.** INISIATIEF, INSIG en PRESTASIE is almal hoog. Kliënt mag getrek voel na die bou van iets groter as hulself. Bespreek langtermyn-visie, eienaarskap en nalatenskap.');
    }

    // Pattern 2: High INISIATIEF + low STRUKTUUR → Vision without sustainability
    if (isHigh('INISIATIEF') && isLow('STRUKTUUR')) {
        patterns.push("⚠️ **Visie sonder volhoubaarheid.** INISIATIEF is hoog maar STRUKTUUR is laag. Beweging en moontlikhede is teenwoordig, maar sisteme en volhoubaarheid mag swak wees. Bespreek roetines, volhouding en stelselmatige uitvoering.");
    }

    // Pattern 3: High LIEFDE + high EMOSIE → Emotional carrier, boundary need
    if (isHigh('LIEFDE') && isHigh('EMOSIE')) {
        patterns.push('💛 **Emosionele draer.** LIEFDE en EMOSIE is beide hoog. Kliënt mag ander se emosies dra en grensopleiding benodig. Bespreek persoonlike grense, self-sorg en die verskil tussen empatie en verantwoordelikheid.');
    }

    // Pattern 4: High PRESTASIE + low EMOSIE → Pusher, low emotional awareness
    if (isHigh('PRESTASIE') && isLow('EMOSIE')) {
        patterns.push("⚠️ **Dryfkrag sonder emosionele bewustheid.** PRESTASIE is hoog maar EMOSIE is laag. Kliënt mag hard druk en sukkel om die emosionele impak op ander raak te sien. Bespreek die impak op verhoudings en spandynamika.");
    }

    // Pattern 5: High INSIG + low PRESTASIE → Deep thinker who delays action
    if (isHigh('INSIG') && isLow('PRESTASIE')) {
        patterns.push("🔍 **Diep denker wat aksie uitstel.** INSIG is hoog maar PRESTASIE is laag. Kliënt mag diep dink maar aksie uitstel. Bespreek die drempel van analise na uitvoering — wanneer is genoeg inligting genoeg?");
    }

    // Pattern 6: High STRUKTUUR + low INISIATIEF → Stable but avoids risk
    if (isHigh('STRUKTUUR') && isLow('INISIATIEF')) {
        patterns.push("🧱 **Betroubaar maar risiko-skuwerig.** STRUKTUUR is hoog maar INISIATIEF is laag. Kliënt is betroubaar en stabiel maar mag risiko of nuwe rigting vermy. Bespreek groei buite die bekende en wat dit sou neem om 'n nuwe stap te waag.");
    }

    if (patterns.length === 0) {
        lines.push("*Geen spesifieke patroonwaarskuwings geïdentifiseer nie. Voer 'n oop verkenning van die profiel.*");
    } else {
        for (const p of patterns) {
            lines.push(p);
            lines.push('');
        }
    }

    lines.push('---');
    lines.push('');

    // ── Session talking points ─────────────────────────────────────────────────
    lines.push('## Sessie-besprekingspunte');
    lines.push('');
    lines.push(`1. Herken die kliënt hul primêre dryfkrag (${dimName(primary)}) in hul alledaagse lewe?`);
    lines.push(`2. Hoe ervaar die kliënt spanning tussen ${dimName(primary)} en ${dimName(lowest)}?`);
    lines.push(`3. Is die kliënt bewus van hoe hul ${dimName(supporting)} hul ${dimName(primary)} ondersteun of teenwerk?`);
    if (top3.has('INISIATIEF')) {
        const rank = ranking.indexOf('INISIATIEF') + 1;
        lines.push(`4. INISIATIEF is #${rank} — bespreek waar hul energie heen gaan en of dit volhoubaar is.`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('*[Voeg jou eie kotsnotas hier by na die sessie.]*');
    lines.push('');

    return {
        markdown:    lines.join('\n'),
        generatedAt: generatedAt ?? new Date().toISOString()
    };
}
