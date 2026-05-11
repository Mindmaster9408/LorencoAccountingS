'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'accounting-ecosystem/backend/domain');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
for (const f of files) {
  const fp = path.join(dir, f);
  let content = fs.readFileSync(fp, 'utf8');
  const count = (content.match(/[\u2018\u2019]/g) || []).length;
  const fixed = content.replace(/[\u2018\u2019]/g, "'");
  fs.writeFileSync(fp, fixed, 'utf8');
  console.log(f + ': replaced ' + count + ' curly quotes');
}
console.log('Done.');
