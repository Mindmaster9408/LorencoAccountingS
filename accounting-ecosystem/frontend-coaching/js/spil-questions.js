// VITA Profile — Questions, Labels and Interpretation Data

export const VITA_DIMENSIONS = ['STRUKTUUR', 'PRESTASIE', 'INSIG', 'LIEFDE', 'EMOSIE', 'INISIATIEF'];

export const VITA_QUESTIONS = {
    STRUKTUUR: [
        "Ek werk die beste wanneer daar 'n duidelike plan of proses is",
        "Ek hou daarvan om dinge vooraf te organiseer",
        "Ek volg roetines en sisteme konsekwent",
        "Ek raak ongemaklik wanneer dinge chaoties is",
        "Ek verkies voorspelbaarheid bo verrassings",
        "Ek dokumenteer hoe dinge gedoen moet word",
        "Ek voltooi take volgens 'n plan",
        "Ek vertrou sisteme meer as gevoel",
        "Ek hou daarvan om beheer te hê oor prosesse",
        "Ek bou eerder stabiliteit as spoed"
    ],
    PRESTASIE: [
        "Ek neem vinnig besluite",
        "Ek wil vinnige resultate sien",
        "Stadige vordering frustreer my",
        "Ek vat eerder aksie as om te wag",
        "Ek geniet kompetisie",
        "Ek werk goed onder druk",
        "Ek soek geleenthede",
        "Ek hou nie van wag nie",
        "Ek dryf myself om klaar te maak",
        "Ek kry energie uit momentum"
    ],
    INSIG: [
        "Ek wil eers verstaan voordat ek optree",
        "Ek analiseer dinge diep",
        "Ek stel belang in hoe dinge werk",
        "Ek leer graag",
        "Ek vertrou logika",
        "Ek vra baie vrae",
        "Ek los komplekse probleme op",
        "Ek soek akkuraatheid",
        "Ek verkies feite",
        "Ek dink groot prentjie"
    ],
    LIEFDE: [
        "Ek gee om oor mense",
        "Ek bou diep verhoudings",
        "Ek wil hê mense moet behoort",
        "Ek help ander",
        "Ek waardeer eerlikheid",
        "Ek werk goed in span",
        "Ek soek betekenis",
        "Ek ondersteun mense",
        "Ek neem emosies in ag",
        "Ek kies verbinding bo resultate"
    ],
    EMOSIE: [
        "Ek vermy konflik",
        "Ek soek harmonie",
        "Spanning maak my ongemaklik",
        "Ek hou vrede",
        "Ek verkies stabiliteit",
        "Ek hou van rustigheid",
        "Ek verminder konflik",
        "Ek fokus op regverdigheid",
        "Ek hou nie van drama nie",
        "Ek beskerm my energie"
    ],
    INISIATIEF: [
        "Ek sien geleenthede",
        "Ek begin sonder volle kennis",
        "Ek is gemaklik met onsekerheid",
        "Ek vat risiko's",
        "Ek dink in moontlikhede",
        "Ek raak opgewonde oor idees",
        "Ek bou eerder as volg",
        "Ek vertrou my instink",
        "Ek sien groter visie",
        "Ek probeer al kan ek misluk"
    ]
};

export const DIM_LABELS = {
    STRUKTUUR:  'Struktuur',
    PRESTASIE:  'Prestasie',
    INSIG:      'Insig',
    LIEFDE:     'Liefde',
    EMOSIE:     'Emosie',
    INISIATIEF: 'Inisiatief'
};

export const DIM_COLORS = {
    STRUKTUUR:  '#0ea5e9',
    PRESTASIE:  '#f59e0b',
    INSIG:      '#8b5cf6',
    LIEFDE:     '#ec4899',
    EMOSIE:     '#10b981',
    INISIATIEF: '#f97316'
};

export const DIM_DESCRIPTIONS = {
    STRUKTUUR:  'Jy soek orde, sisteme en voorspelbaarheid in alles wat jy doen.',
    PRESTASIE:  'Jy vat aksie, soek vinnige resultate en dryf momentum voorentoe.',
    INSIG:      'Jy soek begrip, akkuraatheid en diepte voordat jy optree.',
    LIEFDE:     'Jy bou diep verbindings, gee opreg om oor mense en soek betekenis.',
    EMOSIE:     'Jy soek harmonie, vrede en emosionele balans in jou omgewing.',
    INISIATIEF: 'Jy sien geleenthede, vertrou jou instink en bou met bereidwilligheid om risiko te vat.'
};

export const DIM_GROWTH = {
    STRUKTUUR:  'Jy mag baat vind by sterker sisteme, roetines en konsekwentheid in jou prosesse.',
    PRESTASIE:  'Jy mag baat vind by meer geduld, dieper beplanning voor aksie en volgehoue fokus.',
    INSIG:      'Jy mag baat vind by vinniger aksie met minder analise — veral wanneer genoeg inligting beskikbaar is.',
    LIEFDE:     'Jy mag baat vind by gesonde grense en meer aandag aan jou eie behoeftes.',
    EMOSIE:     'Jy mag baat vind by meer direkte konfrontering van spanning eerder as om dit te vermy.',
    INISIATIEF: 'Jy mag baat vind by meer struktuur rondom jou idees om hulle na voltooiing te bring.'
};
