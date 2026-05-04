'use strict';

/**
 * vita.config.js — VITA Dimension Definitions
 *
 * Source of truth for all VITA dimension content.
 * Used by vita.engine.js to build report data.
 * Editable here to update report text without touching engine logic.
 */

const VITA_DIMENSIONS = ['STRUKTUUR', 'PRESTASIE', 'INSIG', 'LIEFDE', 'EMOSIE', 'INISIATIEF'];

const VITA_LABELS = {
  STRUKTUUR:  'Struktuur',
  PRESTASIE:  'Prestasie',
  INSIG:      'Insig',
  LIEFDE:     'Liefde',
  EMOSIE:     'Emosie',
  INISIATIEF: 'Inisiatief',
};

const VITA_CONFIG = {
  STRUKTUUR: {
    label: 'Struktuur',
    values: ['Orde', 'Voorspelbaarheid', 'Stabiliteit', 'Konsekwentheid', 'Duidelikheid'],
    behaviour:
      'Jy benader werk en lewe op \'n metodiese, sistematiese wyse. ' +
      'Jy verkies duidelike prosesse, roetines en verantwoordbaarhede. ' +
      'Onsekere of ongestruktureerde situasies aktiveer jou behoefte om beheer te skep.',
    strengths: [
      'Organisasie en gedetailleerde beplanning',
      'Betroubaarheid — jy volg konsekwent deur op beloftes',
      'Aandag aan detail en kwaliteitscontrole',
      'Konsekwentheid onder druk',
      'Skep herhaalbare stelsels wat ander kan volg',
    ],
    weaknesses: [
      'Weerstand teen onverwagte verandering of werkswyseaanpassings',
      'Kan rigied raak wanneer prosesse aangepas moet word',
      'Oorplanning en voorbereiding wat vordering vertraag',
      'Ongemak met ambiguïteit en onvoltooide raamwerke',
    ],
  },

  PRESTASIE: {
    label: 'Prestasie',
    values: ['Sukses', 'Doelwitte', 'Resultate', 'Groei', 'Kompetisie'],
    behaviour:
      'Jy word gedryf deur meetbare uitkomste en die behoefte om te oorpresteer. ' +
      'Doelwitte gee jou energie en motiveer jou aksies. ' +
      'Jy meet jou waarde dikwels aan jou laaste prestasie.',
    strengths: [
      'Sterk deursettingsvermoë en selfmotivering',
      'Doelgerigte fokus wat resultate lewer',
      'Hoë produktiwiteit en uitset',
      'Ambisie wat andere inspireer om hoër te mik',
      'Vermoë om druk te hanteer en te presteer',
    ],
    weaknesses: [
      'Neiging tot werkaholis-gedrag en uitbranding',
      'Perfeksionisme wat verhoudings en spoed benadeel',
      'Sukkel om ander se tempo te respekteer of te akkommodeer',
      'Erken selde die proses — slegs die eindresultaat tel',
    ],
  },

  INSIG: {
    label: 'Insig',
    values: ['Kennis', 'Begrip', 'Waarheid', 'Analitiese denke', 'Diepte'],
    behaviour:
      'Jy dink diep voor jy handel. Jy soek die "hoekom" agter dinge en neem besluite ' +
      'gebaseer op begrip, nie bloot op indrukke nie. ' +
      'Kennis is vir jou \'n bron van krag en sekerheid.',
    strengths: [
      'Diep analitiese vermoë en kritiese denke',
      'Probleemoplossing vanuit eerste beginsels',
      'Sterk leerdrang en deurlopende kennisopbou',
      'Kalm, bedagsame besluitneming',
      'Sien onderliggende patrone wat ander misloop',
    ],
    weaknesses: [
      'Ooranalise wat aksie en besluitneming vertraag',
      'Besluiteloosheid in situasies van onvoltooide inligting',
      'Kan afstandelik of koud voorkom in sosiale situasies',
      'Sukkel om inligting te deel voor dit in die eie oog "volmaak" is',
    ],
  },

  LIEFDE: {
    label: 'Liefde',
    values: ['Verbinding', 'Verhoudings', 'Empatie', 'Omgee', 'Lojaliteit'],
    behaviour:
      'Mense en verhoudings is jou kern-motiveerder. ' +
      'Jy neem besluite met die impak op ander in ag en bou diep, langtermyn verbindings. ' +
      'Jou omgewing se emosionele toestand beïnvloed jou eie betekeniservaring.',
    strengths: [
      'Diep empatie en hoë emosionele intelligensie',
      'Vermoë om vertroue en veiligheid te bou',
      'Sterk spanspeler, mentor en ondersteuner',
      'Lojaliteit aan mense, waardes en gemeenskappe',
      'Skep omgewings waar ander kan floreer en groei',
    ],
    weaknesses: [
      'Sukkel om gesonde, duidelike grense te stel',
      'Vermy konflik ten koste van eerlike kommunikasie',
      'Eie behoeftes word chronies laaste geprioritiseer',
      'Neem persoonlike verwerping of kritiek baie swaar',
    ],
  },

  EMOSIE: {
    label: 'Emosie',
    values: ['Outentisiteit', 'Passie', 'Ervaring', 'Uitdrukking', 'Gevoel'],
    behaviour:
      'Jou lewe word gerig deur hoe dinge jou laat voel. ' +
      'Jy leef outentiek, passiévol en ekspressief — emosies is vir jou data, nie swakhede nie. ' +
      'Jy beweeg mense deur jou eerlikheid en intensiteit.',
    strengths: [
      'Outentieke, inspirerende teenwoordigheid',
      'Passie wat ander motiveer en in beweging bring',
      'Kreatiewe, ekspressiewe uitset en kommunikasie',
      'Sterk intuïsie en emosionele situasie-lees',
      'Omskep persoonlike ervarings in betekenis vir ander',
    ],
    weaknesses: [
      'Emosionele reaksies kan situasies oorweldig',
      'Onstandvastigheid wanneer innerlike motivasie laag is',
      'Kwesbaar vir kritiek, verwerping en persoonlike aanvalle',
      'Subjektiewe besluitneming wanneer emosies hoog loop',
    ],
  },

  INISIATIEF: {
    label: 'Inisiatief',
    values: ['Innovasie', 'Entrepreneurskap', 'Toekoms', 'Verandering', 'Geleenthede'],
    behaviour:
      'Jy sien moontlikhede waar ander probleme sien. ' +
      'Jy tree op voor jy seker is en bou liewer iets nuuts as om bestaande patrone te herhaal. ' +
      'Die toekoms is jou primêre orientasie — die verlede informeer, maar beperk nie.',
    strengths: [
      'Visionêre, voorwaarts-denkende leierskap',
      'Vermoë om nuwe geleenthede te identifiseer voor ander dit sien',
      'Innoverend en risikobereid in onbekende terrein',
      'Beweeg vinnig vanaf idee na aksie',
      'Inspireer ander om buite die boks te dink en te waag',
    ],
    weaknesses: [
      'Sukkel om projekte te voltooi en af te werk',
      'Konsekwentheid en opvolgaksies is chronies swak',
      'Ongeduld met stadige prosesse of burokrasie',
      'Neem gelyktydig te veel nuwe projekte aan',
    ],
  },
};

module.exports = { VITA_DIMENSIONS, VITA_LABELS, VITA_CONFIG };
