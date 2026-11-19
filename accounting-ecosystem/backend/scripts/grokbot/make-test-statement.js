'use strict';

/**
 * Synthetic bank statement for testing GrokBot (Codebox 4) — company 51 ONLY.
 * Every name, number and amount here is FICTIONAL. Layout: FNB business statement
 * ("Transactions in RAND"), which Leo's own PDF reader (sean/pdf-statement-parsers/
 * fnb-parser.js) understands, so the bot imports it through the real import path.
 *
 *   node scripts/grokbot/make-test-statement.js <out.pdf> [YYYY-MM]
 *   node scripts/grokbot/make-test-statement.js <out.pdf> [YYYY-MM] --check   (also parses it with Leo's reader)
 *
 * Each line carries the scenario it tests (see SCENARIOS) — the bot never sees that.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const ACCOUNT_NUMBER = '62000000917';            // fictional
const OPENING = 50000.00;

// [day, description, amount (+ in / − out), scenario]
const SCENARIOS = [
  [1,  'ENGEN WATERFRONT FUEL',            -850.00,  'rule: ENGEN → 6300 Motor Vehicle — Fuel'],
  [2,  'VODACOM DEBIT ORDER',              -699.00,  'sean: history → 6200 Telephone and Internet'],
  [2,  'FNB MONTHLY SERVICE FEE',          -185.00,  'sean starter: bank charges 6700 (low confidence)'],
  [3,  'PAYMENT FROM SUNRISE TRADERS',    12500.00,  'bot reasoned: client receipt → 4100 Service Revenue'],
  [4,  'OFFICE RENT OCTOBER',             -9200.00,  'VAT: rent → 6100 with standard VAT'],
  [5,  'TAKEALOT PURCHASE',               -1349.00,  'unknown expense → flag_for_review'],
  [6,  'ENGEN N1 CITY FUEL',               -920.50,  'rule: ENGEN → 6300'],
  [7,  'PAYMENT TO DIRECTOR J DOE',       -15000.00, 'director → must wait for approval'],
  [8,  'TRANSFER TO SAVINGS',             -10000.00, 'internal transfer → 1030 savings, must wait'],
  [9,  'MICROSOFT SUBSCRIPTION',           -420.00,  'VAT: software 6510'],
  [10, 'WOOLWORTHS FOOD',                  -356.80,  'duplicate pair (1 of 2)'],
  [10, 'WOOLWORTHS FOOD',                  -356.80,  'duplicate pair (2 of 2) → bot should reject/flag'],
  [12, 'VODACOM DEBIT ORDER',              -699.00,  'sean: history → 6200'],
  [13, 'PAYMENT FROM BLUE CRANE CC',       8000.00,  'bot reasoned: client receipt → 4100'],
  [14, 'CASH WITHDRAWAL ATM',             -5000.00,  'cash, no evidence → flag_for_review'],
  [15, 'SANTAM INSURANCE PREMIUM',         -1150.00, 'bot reasoned: 6800 Insurance — Business'],
  [16, 'GOOGLE ADS',                       -750.00,  'bot reasoned: 6900 Marketing and Advertising'],
  [17, 'DRAWINGS OWNER',                  -3000.00,  'owner drawings → must wait'],
  [18, 'ENGEN SANDTON FUEL',               -780.00,  'rule: ENGEN → 6300'],
  [20, 'CONSULTING FEE K NAIDOO',         -4500.00,  'bot reasoned / evidence: 6620 Consulting Fees'],
  [22, 'VODACOM DEBIT ORDER',              -699.00,  'sean: history → 6200'],
  [24, 'INTEREST ON LOAN',                 -310.25,  'bot reasoned: 7000 Interest Expense'],
  [27, 'PAYMENT FROM SUNRISE TRADERS',     6750.00,  'bot reasoned: client receipt → 4100'],
  [30, 'UNKNOWN EFT REF 7781 ZX',          -2200.00, 'unknown → flag_for_review']
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (n) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const balTxt = (b) => fmt(b) + (b >= 0 ? 'Cr' : 'Dr');

function build(outFile, ym) {
  const [y, m] = (ym || '2026-10').split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const mon = MON[m - 1];
  const doc = new PDFDocument({ size: 'A4', margin: 40, compress: false, pdfVersion: '1.4' });
  const stream = fs.createWriteStream(outFile);
  const done = new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
  doc.pipe(stream);
  doc.font('Helvetica').fontSize(9);
  const line = (t) => doc.text(t, { lineBreak: false }).moveDown(0.6);

  line('SYNTHETIC TEST STATEMENT — NOT A REAL BANK DOCUMENT');
  line('Gold Business Account : ' + ACCOUNT_NUMBER);
  line('Infinite Legacy TEST (synthetic)');
  line(`Statement Period : 1 ${mon} ${y} to ${lastDay} ${mon} ${y}`);
  line('Opening Balance ' + fmt(OPENING) + ' Cr');
  line('Transactions in RAND (ZAR)');
  line('Date Description Amount Balance');

  let bal = OPENING;
  const rows = [];
  for (const [d, desc, amt, scenario] of SCENARIOS) {
    if (d > lastDay) continue;
    bal = Math.round((bal + amt) * 100) / 100;
    // "DD Mon<description><amount>[Cr]<balance>Cr" — the layout the FNB reader expects
    line(`${String(d).padStart(2, '0')} ${mon}${desc}${fmt(amt)}${amt > 0 ? 'Cr' : ''}${balTxt(bal)}`);
    rows.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, description: desc, amount: amt, balance: bal, scenario });
  }
  line('Closing Balance ' + fmt(bal) + (bal >= 0 ? ' Cr' : ' Dr'));
  line('First National Bank - a division of FirstRand Bank Limited (synthetic test layout)');
  doc.end();
  return { rows, opening: OPENING, closing: bal, done };
}

async function main() {
  const out = process.argv[2];
  if (!out) { console.error('usage: node scripts/grokbot/make-test-statement.js <out.pdf> [YYYY-MM] [--check]'); process.exit(1); }
  const ym = process.argv[3] && /^\d{4}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : '2026-10';
  const info = build(out, ym);
  await info.done; delete info.done;
  fs.writeFileSync(out.replace(/\.pdf$/i, '') + '.expected.json', JSON.stringify(info, null, 1));
  console.log(`wrote ${out}: ${info.rows.length} lines, opening ${info.opening.toFixed(2)}, closing ${info.closing.toFixed(2)}`);

  if (process.argv.includes('--check')) {
    const Pdf = require(path.join(__dirname, '..', '..', 'sean', 'pdf-statement-import-service'));
    const r = await Pdf.parsePdf(fs.readFileSync(out), 'fnb-synthetic-test.pdf', {});
    const got = r.transactions || [];
    const bad = info.rows.filter((e, i) => !got[i] || got[i].date !== e.date || Math.abs(Number(got[i].amount) - e.amount) > 0.005);
    console.log(`Leo reader: bank ${r.bank}, parser ${r.parserId}, ${got.length} lines read, ${bad.length} mismatches`);
    if (bad.length || got.length !== info.rows.length) {
      console.log(JSON.stringify(got.slice(0, 5), null, 1));
      process.exit(2);
    }
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { build, SCENARIOS, ACCOUNT_NUMBER };
