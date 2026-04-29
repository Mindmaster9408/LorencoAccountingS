// spil.config.js — SPIL-E Profile Engine: single source of truth
//
// 6 dimensions × 10 questions = 60 total questions.
// Scoring: simple SUM (not average, no reverse scoring).
// Scale: 1–10 per question → dimension total 10–100.
//
// Questions are the official 60-question SPIL-E brief (10 per dimension, Afrikaans).
// Scale: 1–10 per question (1 = Stem glad nie saam nie, 10 = Stem heeltemal saam).
//
// Tie-breaker order (used when two dimensions score equally):
//   1st INISIATIEF, 2nd INSIG, 3rd PRESTASIE,
//   4th STRUKTUUR, 5th LIEFDE, 6th EMOSIE
//   (lower position = ranked higher when scores are equal)

export const SPIL_STRUCTURE = {
  dimensions: {

    // ── STRUKTUUR (S) ──────────────────────────────────────────────────────
    STRUKTUUR: {
      name: 'Struktuur',
      fullName: 'Struktuur — Sisteme & Orde',
      description: 'Systems, order, planning, consistency, reliability, routines, predictability.',
      questions: [
        "Ek werk die beste wanneer daar 'n duidelike plan of proses is.",
        "Ek hou daarvan om dinge vooraf te organiseer.",
        "Ek volg roetines en sisteme konsekwent.",
        "Ek raak ongemaklik wanneer dinge chaoties of ongeorganiseerd is.",
        "Ek verkies voorspelbaarheid bo verrassings.",
        "Ek dokumenteer of standaardiseer hoe dinge gedoen moet word.",
        "Ek voltooi take volgens 'n gestruktureerde plan.",
        "Ek vertrou sisteme meer as mense se gevoel.",
        "Ek hou daarvan om beheer te hê oor hoe dinge verloop.",
        "Ek bou eerder stabiliteit as spoed."
      ]
    },

    // ── PRESTASIE (P) ──────────────────────────────────────────────────────
    PRESTASIE: {
      name: 'Prestasie',
      fullName: 'Prestasie — Aksie & Resultate',
      description: 'Action, momentum, results, achievement, drive, progress, execution.',
      questions: [
        "Ek neem vinnig besluite en beweeg aan.",
        "Ek hou daarvan om resultate vinnig te sien.",
        "Ek raak gefrustreerd met stadige vordering.",
        "Ek vat eerder aksie as om te lank te dink.",
        "Ek geniet kompetisie en wen.",
        "Ek werk goed onder druk.",
        "Ek soek geleenthede om vorentoe te beweeg.",
        "Ek hou nie van wag nie.",
        "Ek dryf myself om dinge klaar te kry.",
        "Ek kry energie uit momentum."
      ]
    },

    // ── INSIG (I) ──────────────────────────────────────────────────────────
    INSIG: {
      name: 'Insig',
      fullName: 'Insig — Logika & Begrip',
      description: 'Knowledge, logic, learning, analysis, understanding, truth, big-picture thinking.',
      questions: [
        "Ek wil eers verstaan voordat ek optree.",
        "Ek analiseer dinge diep voordat ek besluit.",
        "Ek stel belang in hoe en hoekom dinge werk.",
        "Ek geniet dit om te leer en kennis op te bou.",
        "Ek vertrou logika meer as emosie.",
        "Ek vra baie vrae.",
        "Ek hou daarvan om komplekse probleme op te los.",
        "Ek soek akkuraatheid en korrektheid.",
        "Ek verkies feite bo opinies.",
        "Ek dink in terme van die groter prentjie."
      ]
    },

    // ── LIEFDE (L) ─────────────────────────────────────────────────────────
    LIEFDE: {
      name: 'Liefde',
      fullName: 'Liefde — Verbinding & Sorg',
      description: 'Care, connection, empathy, relationships, authenticity, support, belonging.',
      questions: [
        "Ek gee om oor mense se gevoelens.",
        "Ek bou maklik diep verhoudings.",
        "Ek wil hê mense moet voel hulle behoort.",
        "Ek help ander selfs al kos dit my iets.",
        "Ek waardeer eerlikheid en opregtheid.",
        "Ek werk goed in spanomgewings.",
        "Ek soek betekenisvolle interaksies.",
        "Ek hou daarvan om mense te ondersteun.",
        "Ek neem ander se emosies in ag.",
        "Ek soek verbinding bo resultate."
      ]
    },

    // ── EMOSIE (E) ─────────────────────────────────────────────────────────
    EMOSIE: {
      name: 'Emosie',
      fullName: 'Emosie — Harmonie & Balans',
      description: 'Balance, emotional safety, harmony, peace, ethics, stability, conflict reduction.',
      questions: [
        "Ek vermy konflik waar moontlik.",
        "Ek soek harmonie in my omgewing.",
        "Ek raak ongemaklik met spanning.",
        "Ek probeer vrede hou tussen mense.",
        "Ek verkies stabiliteit bo verandering.",
        "Ek hou van 'n rustige omgewing.",
        "Ek neem besluite wat konflik verminder.",
        "Ek fokus op wat regverdig en eties is.",
        "Ek hou nie van drama nie.",
        "Ek beskerm my emosionele energie."
      ]
    },

    // ── INISIATIEF (E+) ────────────────────────────────────────────────────
    INISIATIEF: {
      name: 'Inisiatief',
      fullName: 'Inisiatief (E+) — Visie & Begin',
      description: 'Initiative, possibility-thinking, building, risk tolerance, opportunity recognition, vision.',
      questions: [
        "Ek sien geleenthede waar ander probleme sien.",
        "Ek begin dinge al weet ek nie alles nie.",
        "Ek is gemaklik met onsekerheid.",
        "Ek vat risiko's as ek glo dit kan werk.",
        "Ek dink in terme van moontlikhede eerder as beperkings.",
        "Ek raak opgewonde oor nuwe idees.",
        "Ek bou eerder iets nuuts as om iets te volg.",
        "Ek vertrou my instink wanneer ek besluite neem.",
        "Ek sien die groter visie voordat ander dit sien.",
        "Ek sal iets probeer selfs al kan ek misluk."
      ]
    }
  },

  // Tie-breaker order: when two dimensions have equal scores,
  // the dimension earlier in this list ranks higher.
  tieBreakerOrder: [
    'INISIATIEF',  // rank 1 tiebreaker (ranked highest when tied)
    'INSIG',       // rank 2
    'PRESTASIE',   // rank 3
    'STRUKTUUR',   // rank 4
    'LIEFDE',      // rank 5
    'EMOSIE'       // rank 6 tiebreaker (ranked lowest when tied)
  ],

  // Scoring parameters
  scoring: {
    minPerQuestion:  1,
    maxPerQuestion: 10,
    questionsPerDimension: 10,
    minTotal: 10,   // 10 × 1
    maxTotal: 100   // 10 × 10
  }
};

// Flat set of all valid answer keys across all dimensions.
// Used by the engine and routes for completeness validation.
export const ALL_SPIL_KEYS = new Set(
  Object.keys(SPIL_STRUCTURE.dimensions).flatMap((dim, dimIdx) =>
    SPIL_STRUCTURE.dimensions[dim].questions.map((_, qIdx) => `${dim}_${qIdx + 1}`)
  )
);

export const SPIL_DIMENSIONS = Object.keys(SPIL_STRUCTURE.dimensions);
export const TOTAL_SPIL_QUESTIONS = ALL_SPIL_KEYS.size; // 60
