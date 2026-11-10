#!/usr/bin/env node
/**
 * Loads help articles from docs/sevco/help/<app>-articles.json into SEVCO's brain
 * (sean_knowledge_items) as DRAFT rows — one per language. A super user approves
 * each article in SEVCO → Paytime Help before the assistant uses it.
 * Idempotent: a slug that already exists for the app is left alone.
 *
 *   node scripts/seed-sevco-help.js paytime            (dry run — shows what it would add)
 *   node scripts/seed-sevco-help.js paytime --write
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/database');
const { APPS } = require('../sean/help/knowledge');

(async () => {
  const app = process.argv[2];
  const write = process.argv.includes('--write');
  if (!APPS[app]) { console.error('Usage: node scripts/seed-sevco-help.js <' + Object.keys(APPS).join('|') + '> [--write]'); process.exit(1); }
  const file = path.join(__dirname, '..', '..', 'docs', 'sevco', 'help', `${app}-articles.json`);
  const { articles } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const domain = APPS[app].domain;

  const { data: existing, error } = await supabase.from('sean_knowledge_items')
    .select('slug').eq('domain', domain).eq('layer', 'APP_HELP');
  if (error) throw new Error(error.message);
  const have = new Set((existing || []).map(r => r.slug));

  const rows = [];
  for (const a of articles) {
    if (have.has(a.slug)) { console.log('skip (exists):', a.slug); continue; }
    for (const L of ['af', 'en']) {
      if (!a[L]) continue;
      rows.push({
        title: a[L].title, content: a[L].body, content_text: a[L].body,
        domain, layer: 'APP_HELP', content_type: 'help_article', language: L.toUpperCase(),
        slug: a.slug, status: 'DRAFT', version: 1, kb_version: 1, scope_type: 'GLOBAL', company_id: null,
        tags: a.tags || [], source_url: a.screen_url || null, source_section: a.screen_name || null,
        source_type: 'sevco_help_seed', citation_id: `HELP:${a.slug}:${L.toUpperCase()}:v1`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
    }
    console.log((write ? 'add: ' : 'would add: ') + a.slug);
  }
  if (!write) { console.log(`\nDry run: ${rows.length} rows. Add --write to insert them as DRAFT.`); process.exit(0); }
  if (rows.length) {
    const { error: insErr } = await supabase.from('sean_knowledge_items').insert(rows);
    if (insErr) throw new Error(insErr.message);
  }
  console.log(`\nInserted ${rows.length} DRAFT rows. Approve them in SEVCO → Paytime Help.`);
  process.exit(0);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
