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
    stressText:
      'Wanneer Struktuur as stres-dimensie aktiveer, mag die persoon skielik oormatig kontrolerend, rigied of ' +
      'perfeksionisties word. Hulle kan vasval in besonderhede en haas probeer \'n situasie "beheer" wat hulle ' +
      'onseker laat voel. Dit is \'n teken dat die diep behoefte aan sekerheid en voorspelbaarheid nie vervul ' +
      'word nie — die beheer-gedrag is \'n beskerming, nie \'n aanval nie.',
    growthText:
      'Om Struktuur as groei-area te ontwikkel, oefen om meer sistematies en konsekwent te werk. ' +
      'Bou stappe vir jou dag, week en projekte doelbewus in. ' +
      'Leer om eenvoudige prosesse op te stel wat jy kan herhaal — dit skakel onsekerheid om in ' +
      'voorspelbare uitkomste. Begin klein: een roetine wat jy elke dag volg.',
    commWith:
      'Wees georganiseer en spesifiek. Gee \'n agenda vooraf en kom vroeg. ' +
      'Formuleer vrae met duidelike antwoorde en vermy vae ooreenkomste. ' +
      'Volg beloftes konsekwent na — betroubaarheid is hul geldeenheid. ' +
      'Moenie in besprekings afwyk van die punt af nie.',
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
    stressText:
      'Wanneer Prestasie as stres-dimensie aktiveer, kan die persoon skielik kompetitief, ongeduldig of ' +
      'selfkrities raak. Hulle jaag resultate op \'n wyse wat ander kan verwar of uitput. ' +
      'Hulle mag hul eie welstand opsy skuif om \'n doel te bereik en erken nie hul eie grense nie. ' +
      'Dit is \'n teken dat hul sin van waarde te nou aan prestasie vasgeheg is.',
    growthText:
      'Om Prestasie as groei-area te ontwikkel, begin om doelwitte duideliker te stel en vordering aktief te meet. ' +
      'Vier klein oorwinnings — dit bou momentum. Leer om meting en verantwoordbaarheid as ' +
      'energiebron te gebruik in plaas van iets om te vrees. ' +
      'Stel een meetbare doelwit per week en track jou vordering sigbaar.',
    commWith:
      'Kom direk by die punt. Praat in uitkomste, tydraamwerke en resultate. ' +
      'Respekteer hul tyd — moenie rondomtalie praat of onnodige agtergrond gee nie. ' +
      'Erken prestasies openlik en gee duidelike, direkte terugvoer oor wat goed en wat verkeerd gaan.',
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
    stressText:
      'Wanneer Insig as stres-dimensie aktiveer, kan die persoon skielik intens analities word of in ' +
      'ooranalise verval. Hulle mag stil, onttrokke of kriteries raak en probeer inligting versamel ' +
      'om \'n situasie "te verstaan" voor hulle kan reageer. ' +
      'Dit mag ander frustreer wat vinnige antwoorde verwag, maar is regtig \'n beskerming teen ' +
      'die ongemak van onsekerheid.',
    growthText:
      'Om Insig as groei-area te ontwikkel, oefen om vrae te vra in plaas van net na te dink. ' +
      'Lees, luister na gedagteprovoerende inhoud of leer van ander mense se ervarings. ' +
      'Pas strategiese denke toe op jou eie lewe: "Waarom doen ek dit?" en "Wat is die regte vraag?" ' +
      'Neem tyd om diep te dink oor ten minste een probleem per week.',
    commWith:
      'Gee die "hoekom" eerste. Ondersteun jou stellings met data, redes en verwysings. ' +
      'Gee hulle tyd om te dink voor hulle antwoord — hulle sal terugkeer met diepgaande reaksies. ' +
      'Moenie haastige, oppervlakkige gesprekke verwag nie. ' +
      'Stuur inligting vooraf sodat hulle kan voorberei.',
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
    stressText:
      'Wanneer Liefde as stres-dimensie aktiveer, mag die persoon skielik baie sensitief vir ander se ' +
      'emosies raak. Hulle mag probeer situasies "reg maak" of konflik in die kiem sny — dikwels ' +
      'ten koste van eerlike kommunikasie. Verwerping of spanning in verhoudings tref hulle dan ' +
      'harder as normaal en hul eie behoeftes verdwyn agter die behoefte om harmonie te herstel.',
    growthText:
      'Om Liefde as groei-area te ontwikkel, oefen om meer bewustelik verbindings te bou. ' +
      'Leer om mense werklik te sien en te waardeer, nie net instrumenteel te beskou nie. ' +
      'Ontwikkel empatie as \'n bewuste vaardigheid — vra hoe mense voel en luister sonder om ' +
      'onmiddellik op te los. Een opregte gesprek per week kan hierdie dimensie aansienlik aktiveer.',
    commWith:
      'Begin persoonlik. Vra hoe dit met hulle gaan voordat jy sake bespreek. ' +
      'Toon dat jy werklik luister en hul perspektief respekteer. ' +
      'Vermy koue, formele kommunikasie — dit skep onnodig afstand en ondermyn vertroue. ' +
      'Wees geduldig en laat hulle die verhouding voor die transaksie stel.',
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
    stressText:
      'Wanneer Emosie as stres-dimensie aktiveer, kan die persoon skielik ekspressief, reaktief of ' +
      'emosioneel oorweldigend word. Hulle kan hul gevoelens nie maklik terughou nie en dit mag op ' +
      'maniere uitkom wat die situasie versleg. Hulle benodig ruimte om te prosesseer ' +
      'voor hulle effektief kan reageer — dwang tot rasionaliteit op hierdie moment werk selde.',
    growthText:
      'Om Emosie as groei-area te ontwikkel, oefen om meer aandag te gee aan jou eie gevoelens as ' +
      'bruikbare data. Leer om outentiek te kommunikeer — selfs oor moeilike emosies — op \'n ' +
      'konstruktiewe wyse. Kreatiewe uitdrukking soos skryf, kuns of musiek kan hierdie dimensie ' +
      'op \'n veilige wyse aktiveer en groei-energie vrystel.',
    commWith:
      'Wees outentiek en persoonlik. Vermy robotmatiese, formele kommunikasie. ' +
      'Deel jou eie gevoel of reaksie — dit skep onmiddellike verbinding. ' +
      'Erken hul passie en energie; moenie dit "af-koel" as onprofessioneel nie. ' +
      'Toon dat jy werklik betrokke is, nie net die motiewe deurvoer nie.',
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
    stressText:
      'Wanneer Inisiatief as stres-dimensie aktiveer, kan die persoon impulsiewe besluite neem of nuwe ' +
      'projekte begin om \'n gevoel van beheer terug te kry. Hulle vlug dikwels na nuutheid wanneer \'n ' +
      'situasie te swaar raak — "begin iets nuuts" is hul manier om energie te herstel. ' +
      'Dit mag soos wankonsekwentheid lyk vir ander, maar is regtig \'n uitlaatklep vir opgeboude spanning.',
    growthText:
      'Om Inisiatief as groei-area te ontwikkel, oefen om nuwe moontlikhede aktief te identifiseer en ' +
      'te eksperimenteer. Neem bewuste risiko\'s, stel nuwe idees voor en bevraagteken die status quo ' +
      'konstruktief. Leer dat voorwaartse beweging — selfs klein stappe — \'n kragtige bron van energie ' +
      'en momentum kan wees wat jou profiel diep bemagtig.',
    commWith:
      'Skets die groot prentjie eerste — visie, potensiaal en moontlikhede inspireer hulle. ' +
      'Hou detail-gesprekke so kort as moontlik: stuur die besonderhede in \'n e-pos. ' +
      'Ondersteun hul idees voor jy dit evalueer — hulle floreer wanneer hulle voel hul visie ' +
      'word ernstig opgeneem. Wees bereid om vinnig te beweeg en saam te eksperimenteer.',
  },
};

module.exports = { VITA_DIMENSIONS, VITA_LABELS, VITA_CONFIG };
