'use strict';

/**
 * vita.engine.js — VITA Report Data Builder
 *
 * Pure functions — no DB calls, no side effects.
 * All functions are independently testable.
 *
 * Exports:
 *   buildVitaData(ranking)     — master builder; returns all template variables
 *   deriveSections(ranking)    — maps positions to semantic role (PRIMARY, SECONDARY, ...)
 *   buildSpecialSections(data) — derives VISION, PATTERN, COMMUNICATION, etc.
 */

const { VITA_CONFIG, VITA_LABELS } = require('./vita.config');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format an array of strings as a markdown bullet list */
function bulletList(items) {
  return items.map(s => `- ${s}`).join('\n');
}

/** Join an array as a comma-separated string */
function commaList(items) {
  return items.join(', ');
}

// ─── deriveSections ───────────────────────────────────────────────────────────

/**
 * Maps each position in the ranking to a semantic role.
 *
 * @param {string[]} ranking — 6-element array of dimension keys, highest first
 * @returns {{ PRIMARY, SECONDARY, THIRD, STRESS, GROWTH, SHADOW }}
 */
function deriveSections(ranking) {
  return {
    PRIMARY:   ranking[0],
    SECONDARY: ranking[1],
    THIRD:     ranking[2],
    STRESS:    ranking[3],  // 4th — emerges under sustained pressure
    GROWTH:    ranking[4],  // 5th — conscious development opportunity
    SHADOW:    ranking[5],  // 6th — least active; blind spots
  };
}

// ─── buildSpecialSections ─────────────────────────────────────────────────────

/**
 * Derives the narrative special sections from the ranking.
 *
 * @param {{ PRIMARY, SECONDARY, THIRD, STRESS, GROWTH, SHADOW }} sections
 * @param {string[]} ranking
 * @returns {object} — keyed special section strings
 */
function buildSpecialSections(sections, ranking) {
  const top3 = new Set([sections.PRIMARY, sections.SECONDARY, sections.THIRD]);

  // ── VISION_INTERPRETATION ──────────────────────────────────────────────────
  const hasInsig      = top3.has('INSIG');
  const hasInisiatief = top3.has('INISIATIEF');
  let visionText;
  if (hasInsig && hasInisiatief) {
    visionText =
      'Jy kombineer **Insig** (diep begrip) met **Inisiatief** (aksie en innovasie) in jou top 3. ' +
      'Dit maak jou \'n seldsame tipe: iemand wat nie net groot idees genereer nie, maar ook die analitiese raamwerk ' +
      'het om dit te grond. Jy sien moontlikhede én verstaan die implikasies. ' +
      'Jou uitdaging is om hierdie balans te behou sonder om in paralise deur analise te verval.';
  } else if (hasInisiatief) {
    visionText =
      '**Inisiatief** in jou top 3 dui op sterk entrepreneuriese en visionêre energie. ' +
      'Jy sien geleenthede en wil beweeg — dikwels voor ander bewus is van die moontlikheid. ' +
      'Jou groei lê in die opbou van stelsels en konsekwentheid om jou visie oor tyd te realiseer.';
  } else if (hasInsig) {
    visionText =
      '**Insig** in jou top 3 dui op \'n strategie-georiënteerde visie. ' +
      'Jy dink diep na oor die toekoms, maar jou visie is gegrond in data en begrip eerder as intuïsie alleen. ' +
      'Jou sterkpunt is om komplekse probleme te vereenvoudig — jou groei lê in die wil om vinniger te beweeg sonder volledige sekerheid.';
  } else {
    visionText =
      'Jou top 3 dryfkragte fokus op die hede: kwaliteit, mense en resultate. ' +
      'Jy is betroubaar en konsekwent in jou uitvoering. ' +
      'Vir strategiese visioenering kan jy baat vind by die bewuste ontwikkeling van Inisiatief of Insig.';
  }

  // ── PROFILE_PATTERN ────────────────────────────────────────────────────────
  const p = sections.PRIMARY;
  const s = sections.SECONDARY;
  let patternName, patternDesc;

  if (p === 'INSIG'      && s === 'PRESTASIE')  { patternName = 'Strategiese Uitvoerder';     patternDesc = 'Jy kombineer diep analitiese denke met \'n gedrewe behoefte om resultate te lewer. Jy is op jou beste wanneer jy komplekse uitdagings moet oplos én moet lewer.'; }
  else if (p === 'PRESTASIE' && s === 'INSIG')  { patternName = 'Intelligente Kampioen';       patternDesc = 'Jy beweeg vinnig op uitkomste maar rugsteun jou besluite met analitiese denke. Prestasie sonder begrip is nie genoeg nie.'; }
  else if (p === 'STRUKTUUR' && s === 'PRESTASIE') { patternName = 'Gedissiplineerde Kampioen'; patternDesc = 'Orde en prestasie is jou kombinasie. Jy bou herhaalbare stelsels om konsekwent hoë resultate te lewer.'; }
  else if (p === 'PRESTASIE' && s === 'STRUKTUUR') { patternName = 'Resultaatgedrewe Boumeester'; patternDesc = 'Resultate is jou prioriteit, en jy gebruik struktuur as jou gereedskap om dit te bereik.'; }
  else if (p === 'LIEFDE'    && s === 'EMOSIE')    { patternName = 'Empatiese Verbinder';        patternDesc = 'Mense en gevoel is jou wêreld. Jy bou diep, outentieke verhoudings en skakel op \'n vlak wat ander selde bereik.'; }
  else if (p === 'EMOSIE'    && s === 'LIEFDE')    { patternName = 'Passievolle Verbinder';      patternDesc = 'Outentisiteit en mense-verbinding dryf jou. Jy inspireer deur jou eerlikheid en skep lojaliteit deur jou warmte.'; }
  else if (p === 'INISIATIEF' && s === 'PRESTASIE') { patternName = 'Entrepreneuriese Dryfkrag'; patternDesc = 'Jy sien geleenthede en beweeg vinnig om dit te kapitaliseer. Resultate valideer jou visie.'; }
  else if (p === 'PRESTASIE'  && s === 'INISIATIEF') { patternName = 'Ambisius Visionêr';        patternDesc = 'Jou ambisie en visie loop gelyktydig. Jy wil nie net bereik nie — jy wil pionierswerk doen.'; }
  else if (p === 'INISIATIEF' && s === 'INSIG')    { patternName = 'Visionêre Denker';           patternDesc = 'Groot idees, diep gegrond. Jy beweeg die grense van wat moontlik is terwyl jy die implikasies verstaan.'; }
  else if (p === 'INSIG'      && s === 'INISIATIEF') { patternName = 'Analitiese Visionêr';      patternDesc = 'Jy dink diep na oor die toekoms en skroom nie om te waag wanneer jou analise klop nie.'; }
  else if (p === 'LIEFDE'     && s === 'STRUKTUUR') { patternName = 'Betroubare Versorger';      patternDesc = 'Mense kan op jou reken. Jy kombineer opregte omgee met die konsekwentheid om dit te rugsteun.'; }
  else if (p === 'STRUKTUUR'  && s === 'LIEFDE')   { patternName = 'Stabiele Ondersteuner';      patternDesc = 'Jy bied struktuur en omgee terselfdertyd. Jou omgewing voel veilig en betroubaar.'; }
  else if (p === 'EMOSIE'     && s === 'INISIATIEF') { patternName = 'Passievolle Innoveerder';  patternDesc = 'Jy word gedryf deur gevoel EN die drang om nuut te skep. Jou energie is aansteeklik.'; }
  else if (p === 'INISIATIEF' && s === 'EMOSIE')   { patternName = 'Ekspressiewe Voorloper';     patternDesc = 'Jy lei met visie en outentisiteit. Mense volg jou nie net vir jou idees nie, maar vir jou eerlikheid.'; }
  else {
    // Generic fallback based on primary
    patternName = `${VITA_LABELS[p]}-gedrewe Profiel`;
    patternDesc = `Jou profiel word primêr gevorm deur ${VITA_LABELS[p]}${s ? ` en ondersteun deur ${VITA_LABELS[s]}` : ''}.`;
  }

  const patternText = `**${patternName}**\n\n${patternDesc}`;

  // ── COMMUNICATION_STYLE ────────────────────────────────────────────────────
  const commMap = {
    STRUKTUUR:  'Jy kommunikeer direk, feit-gebaseerd en gestruktureerd. Jy verkies duidelike agendas, opsommings en opvolg-aksies. Vaaghede en onvoltooide kommunikasie frustreer jou.',
    PRESTASIE:  'Jy kommunikeer doelgerigte en resultaat-gefokus. Tydens besprekings wil jy so vinnig as moontlik by besluite en aksies uitkom. Agtergrond-inligting is welkom slegs as dit relevant is.',
    INSIG:      'Jy kommunikeer analities en verduidelikend. Jy dink hardop, stel baie vrae en waardeer gesprekke wat diepte het. Oppervlakkige of haastige kommunikasie laat jou ongemaklik.',
    LIEFDE:     'Jy kommunikeer warm, empaties en aktief luisterend. Jy hou van tweerigting gesprekke waar ander ook gehoor voel. Koue, saaklike kommunikasie kan jou afsny van jou motivasie.',
    EMOSIE:     'Jy kommunikeer ekspressief, passiévol en deur stories en metafore. Jou energie dra oor op ander. Formele, emosielose kommunikasie voel vir jou soos \'n masker dra.',
    INISIATIEF: 'Jy kommunikeer visionêr, inspirerend en toekomsgerigte. Jy is bedrewe daarin om moontlikhede te skets en ander om \'n idee te skaar. Detail-gesprekke vermoei jou gou.',
  };
  const communicationStyle = commMap[sections.PRIMARY] ||
    `Jou kommunikasiestyl word sterk gevorm deur ${VITA_LABELS[sections.PRIMARY]}.`;

  // ── RELATIONSHIP_STYLE ─────────────────────────────────────────────────────
  const lPos = ranking.indexOf('LIEFDE');
  const ePos = ranking.indexOf('EMOSIE');
  let relationshipStyle;
  if (lPos <= 1 && ePos <= 1) {
    relationshipStyle =
      'Verhoudings is die sentrum van jou lewe. Jy bou diep, intense verbindings en ervaar die kwaliteit van jou verhoudings as \'n direkte maatstaf van jou welstand. ' +
      'Wees bewus van die neiging om eie behoeftes te verwaarloos in diens van ander.';
  } else if (lPos <= 2 || ePos <= 2) {
    const activeOne = lPos <= 2 ? 'Liefde' : 'Emosie';
    relationshipStyle =
      `${activeOne} in jou top 3 beteken dat verhoudings \'n beduidende rol in jou besluitneming speel. ` +
      'Jy waardeer verbinding en omgee, al is dit nie altyd jou primêre fokus nie.';
  } else {
    relationshipStyle =
      'Verhoudings is nie jou eerste motiveerder nie, maar dit beteken nie dat jy nie omgee nie. ' +
      'Jy bou verhoudings instrumenteel en doelbewus — kwaliteit bo kwantiteit. ' +
      'Wees bewus van persepsies van koelheid, veral by diegene met hoë Liefde-dryfkragte.';
  }

  // ── WORK_ENVIRONMENT ───────────────────────────────────────────────────────
  const workMap = {
    STRUKTUUR:  'Duidelike rolle, verantwoordbaarhede en prosesse. Voorspelbare werksomstandighede met ruimte vir deeglike voorbereiding.',
    PRESTASIE:  'Omgewings waar prestasie gemeet en erken word. Uitdagende doelwitte, kompetisie en sigbare resultate.',
    INSIG:      'Ruimte om diep te dink en te leer. Intellektuele uitdagings, toegang tot inligting en tyd om navorsing te doen.',
    LIEFDE:     'Samewerkende, mensgesentreerde omgewings. Sterk spandinamika, wedersydse ondersteuning en \'n kultuur van sorg.',
    EMOSIE:     'Outentieke, ekspressiewe kultuur. Ruimte om passie en gevoel in werk te bring. Kreatiewe vryheid en persoonlike uitdrukking.',
    INISIATIEF: 'Entrepreneuriese, veranderende omgewings. Vryheid om te eksperimenteer, nuwe idees te toets en die status quo te bevraagteken.',
  };
  const workEnv =
    `**Primêre behoefte (${VITA_LABELS[sections.PRIMARY]}):** ${workMap[sections.PRIMARY]}\n\n` +
    `**Ondersteunende behoefte (${VITA_LABELS[sections.SECONDARY]}):** ${workMap[sections.SECONDARY]}`;

  // ── ENERGY_GIVERS / DRAINERS ──────────────────────────────────────────────
  const energyGiversMap = {
    STRUKTUUR:  ['Voltooide take en afgemerkte lyste', 'Duidelike prosesse en orde', 'Sistemiese probleemoplossing', 'Beplanning en voorbereiding'],
    PRESTASIE:  ['Uitdagende doelwitte bereik', 'Sigbare vordering en resultate', 'Erkenning van prestasies', 'Kompetisie en peil stel'],
    INSIG:      ['Leer en nuwe kennis opdoen', 'Diepgaande gesprekke', 'Probleemoplossing vanuit eerste beginsels', 'Boeke, navorsing en analise'],
    LIEFDE:     ['Betekenisvolle verhoudings', 'Ander help en ondersteun', 'Saamwerk en span-energie', 'Dankbaarheid en verbinding ervaar'],
    EMOSIE:     ['Outentieke ervarings', 'Kreatiewe uitdrukking', 'Inspirerende stories en mense', 'Diepgaande persoonlike gesprekke'],
    INISIATIEF: ['Nuwe idees en projekte', 'Innovasie en eksperimentering', 'Visionêre gesprekke', 'Dinge van nuuts af bou'],
  };
  const energyDrainersMap = {
    STRUKTUUR:  ['Chaos, onduidelikheid en veranderende planne', 'Onafgewerkte take en lossies', 'Burokrasie sonder rede', 'Onverwagte verstoings'],
    PRESTASIE:  ['Stadige vordering of blokkasies', 'Gebrek aan erkenning', 'Onproduktiewe vergaderings', 'Middelmaatigheid rondom jou'],
    INSIG:      ['Oppervlakkige gesprekke en haastige besluite', 'Onvolledige inligting', 'Luidrugtige, ongestruktureerde omgewings', 'Gedwonge sosiale interaksie'],
    LIEFDE:     ['Konflik en gebrekkige harmonie', 'Koue, onpersoonlike omgewings', 'Verwerping of miskenning', 'Kompetitiewe, silo-kultuur'],
    EMOSIE:     ['Onderdrukte of valse omgewings', 'Robotmatiese, prosesgedrewe werk', 'Emosionele konflik sonder resolusie', 'Kritiek sonder erkenning'],
    INISIATIEF: ['Herhaling en roetine', 'Burokrasie en stadige besluite', 'Rigide strukture sonder vryheid', 'Nie-visionêre omgewings'],
  };

  return {
    VISION_INTERPRETATION: visionText,
    PROFILE_PATTERN:       patternText,
    COMMUNICATION_STYLE:   communicationStyle,
    RELATIONSHIP_STYLE:    relationshipStyle,
    WORK_ENVIRONMENT:      workEnv,
    ENERGY_GIVERS:         bulletList(energyGiversMap[sections.PRIMARY]),
    ENERGY_DRAINERS:       bulletList(energyDrainersMap[sections.SHADOW]),
  };
}

// ─── buildVitaData ─────────────────────────────────────────────────────────────

/**
 * Master builder — converts a ranking into all template variable values.
 *
 * @param {string[]} ranking — 6-element array, e.g. ["INSIG","PRESTASIE",...]
 * @returns {object} — all {{PLACEHOLDER}} keys mapped to string values
 */
function buildVitaData(ranking) {
  const sections = deriveSections(ranking);
  const special  = buildSpecialSections(sections, ranking);

  const pick = (dim) => VITA_CONFIG[dim];

  const primaryCfg   = pick(sections.PRIMARY);
  const secondaryCfg = pick(sections.SECONDARY);
  const thirdCfg     = pick(sections.THIRD);
  const shadowCfg    = pick(sections.SHADOW);

  return {
    RANKED_CODE: ranking.join(' \u2013 '),   // em-dash separated VITA code

    PRIMARY_LABEL:      primaryCfg.label,
    PRIMARY_VALUES:     commaList(primaryCfg.values),
    PRIMARY_BEHAVIOUR:  primaryCfg.behaviour,
    PRIMARY_STRENGTHS:  bulletList(primaryCfg.strengths),
    PRIMARY_WEAKNESSES: bulletList(primaryCfg.weaknesses),

    SECONDARY_LABEL:     secondaryCfg.label,
    SECONDARY_VALUES:    commaList(secondaryCfg.values),
    SECONDARY_BEHAVIOUR: secondaryCfg.behaviour,

    THIRD_LABEL:  thirdCfg.label,
    THIRD_VALUES: commaList(thirdCfg.values),

    STRESS_LABEL: VITA_LABELS[sections.STRESS],
    GROWTH_LABEL: VITA_LABELS[sections.GROWTH],
    SHADOW_LABEL: shadowCfg.label,
    SHADOW_WEAKNESSES: bulletList(shadowCfg.weaknesses),

    ...special,
  };
}

module.exports = { buildVitaData, deriveSections, buildSpecialSections };
