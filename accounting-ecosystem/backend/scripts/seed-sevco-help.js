#!/usr/bin/env node
/**
 * Loads help articles from docs/sevco/help/<app>-articles.json into SEVCO's brain
 * (sean_knowledge_items) as DRAFT rows — one per language. A super user approves
 * each article in SEVCO → Paytime Help before the assistant uses it.
 *
 * New slugs are added as DRAFT v1. Existing slugs are left alone, unless --update:
 * then a language whose title/body in the file differs from the current version gets
 * a new DRAFT version (the APPROVED one stays live until the draft is approved —
 * the same rule as editing in SEVCO). A language that already has a DRAFT is skipped
 * so a super user's unsaved review work is never overwritten.
 *
 *   node scripts/seed-sevco-help.js paytime                    (dry run — shows what it would do)
 *   node scripts/seed-sevco-help.js paytime --update           (dry run incl. changed articles)
 *   node scripts/seed-sevco-help.js paytime [--update] --write
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/database');
const { APPS } = require('../sean/help/knowledge');

const LIVE = ['DRAFT', 'APPROVED', 'ARCHIVED'];

function row(domain, a, L, version, now) {
  return {
    title: a[L].title, content: a[L].body, content_text: a[L].body,
    domain, layer: 'APP_HELP', content_type: 'help_article', language: L.toUpperCase(),
    slug: a.slug, status: 'DRAFT', version, kb_version: version, scope_type: 'GLOBAL', company_id: null,
    tags: a.tags || [], source_url: a.screen_url || null, source_section: a.screen_name || null,
    source_type: 'sevco_help_seed', citation_id: `HELP:${a.slug}:${L.toUpperCase()}:v${version}`,
    created_at: now, updated_at: now
  };
}

(async () => {
  const app = process.argv[2];
  const write = process.argv.includes('--write');
  const update = process.argv.includes('--update');
  if (!APPS[app]) { console.error('Usage: node scripts/seed-sevco-help.js <' + Object.keys(APPS).join('|') + '> [--update] [--write]'); process.exit(1); }
  const file = path.join(__dirname, '..', '..', 'docs', 'sevco', 'help', `${app}-articles.json`);
  const { articles } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const domain = APPS[app].domain;

  const { data: existing, error } = await supabase.from('sean_knowledge_items')
    .select('slug, language, status, version, title, content').eq('domain', domain).eq('layer', 'APP_HELP');
  if (error) throw new Error(error.message);
  const bySlug = {};
  (existing || []).forEach(r => { (bySlug[r.slug] = bySlug[r.slug] || []).push(r); });

  const now = new Date().toISOString();
  const rows = [];
  let added = 0, versioned = 0;
  for (const a of articles) {
    const have = bySlug[a.slug];
    if (!have) {
      for (const L of ['af', 'en']) if (a[L]) rows.push(row(domain, a, L, 1, now));
      added++;
      console.log((write ? 'add: ' : 'would add: ') + a.slug);
      continue;
    }
    if (!update) continue;
    for (const L of ['af', 'en']) {
      if (!a[L]) continue;
      const mine = have.filter(r => r.language === L.toUpperCase());
      if (mine.some(r => r.status === 'DRAFT')) { console.log(`skip (draft waiting for approval): ${a.slug} ${L}`); continue; }
      const current = mine.filter(r => LIVE.includes(r.status)).sort((x, y) => (y.version || 0) - (x.version || 0))[0];
      if (current && current.title === a[L].title && current.content === a[L].body) continue;
      const version = Math.max(0, ...mine.map(r => r.version || 0)) + 1;
      rows.push(row(domain, a, L, version, now));
      versioned++;
      console.log(`${write ? 'new version' : 'would make new version'}: ${a.slug} ${L} v${version}`);
    }
  }
  const summary = `${added} new article(s), ${versioned} new version(s), ${rows.length} DRAFT row(s)`;
  if (!write) { console.log(`\nDry run: ${summary}. Add --write to insert them.`); process.exit(0); }
  if (rows.length) {
    const { error: insErr } = await supabase.from('sean_knowledge_items').insert(rows);
    if (insErr) throw new Error(insErr.message);
  }
  console.log(`\nInserted ${summary}. Approve them in SEVCO → Paytime Help.`);
  process.exit(0);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
