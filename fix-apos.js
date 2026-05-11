'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'accounting-ecosystem/backend/domain');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
for (const filename of files) {
  const fp = path.join(dir, filename);
  let src = fs.readFileSync(fp, 'utf8');
  const before = (src.match(/(?<!\\)'n /g) || []).length;
  // Replace unescaped 'n (apostrophe-n-space) but NOT \'n (already escaped)
  src = src.replace(/(?<!\\)'n /g, "\\'n ");
  fs.writeFileSync(fp, src, 'utf8');
  console.log(filename + ': escaped ' + before + ' instances');
}
console.log('Done.');
