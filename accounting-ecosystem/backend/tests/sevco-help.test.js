'use strict';

/** Tests — SEVCO help chatbot: knowledge in sean_knowledge_items, ask/feedback, draft → approve. */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const express = require('express');
const K = require('../sean/help/knowledge');

const mockDb = {};
const mockUser = { userId: 9, isSuperAdmin: true, role: 'admin' };
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../middleware/module-check', () => ({ requireModule: () => (req, res, next) => next() }));
jest.mock('../middleware/audit', () => ({ auditFromReq: async () => {} }));

describe('rank (no AI needed)', () => {
  const arts = [
    { slug: 'payslip/oortyd', title: 'Oortyd op \'n payslip invoer', body: 'Payslip-blad → Overtime → ure.', tags: ['ure'] },
    { slug: 'payslip/item', title: 'Item op \'n payslip sit', body: 'Regular Inputs → + Add.', tags: ['toelae'] },
    { slug: 'payroll/finaliseer', title: 'Maand finaliseer', body: 'Execute Payroll → Finalize.', tags: [] }
  ];
  test('Afrikaans and English questions find the same article; unrelated finds nothing', () => {
    expect(K.rank(arts, 'hoe moet ek n item in n payslip sit')[0].slug).toBe('payslip/item');
    expect(K.rank(arts, 'how do I add overtime')[0].slug).toBe('payslip/oortyd');
    expect(K.rank(arts, 'how do I finalise the month')[0].slug).toBe('payroll/finaliseer');
    expect(K.rank(arts, 'wat is die weer vandag')).toEqual([]);
  });
});

describe('detectLanguage (answer in the language asked)', () => {
  test('English and Afrikaans questions are recognised; unclear falls back', () => {
    expect(K.detectLanguage('How do I add overtime to a payslip?', 'AF')).toBe('EN');
    expect(K.detectLanguage('how do i finalise the month', 'AF')).toBe('EN');
    expect(K.detectLanguage('Hoe sit ek oortyd op \'n payslip?', 'EN')).toBe('AF');
    expect(K.detectLanguage('hoe moet ek n werknemer se salaris verander', 'EN')).toBe('AF');
    expect(K.detectLanguage('payslip', 'AF')).toBe('AF');
    expect(K.detectLanguage('payslip', 'EN')).toBe('EN');
    expect(K.detectLanguage('', undefined)).toBe('EN');
  });
});

describe('isAdviceQuestion (paid Sean AI, not free Pip)', () => {
  test('tax/advice questions are recognised', () => {
    ['Is a cellphone allowance taxable?', "is 'n selfoontoelae belasbaar", 'Which IRP5 code must I use for commission?',
     'watter kode gebruik ek vir kommissie', 'How much tax must I deduct on a bonus?', 'hoeveel belasting op n bonus',
     'Should I deduct UIF from a director?', 'moet ek uif aftrek van n direkteur', 'Is it legal to pay below minimum wage?',
     'what are the SARS rules for travel allowance', 'is a long service award tax free?']
      .forEach(q => expect([q, K.isAdviceQuestion(q)]).toEqual([q, true]));
  });
  test('how-to-use-the-app questions are NOT advice', () => {
    ['How do I add overtime?', 'hoe sit ek oortyd op n payslip', 'How do I set up an item with 80% taxable?',
     'Where do I enter the IRP5 code for an item?', 'hoe stel ek die IRP5-kode van n item', 'how do i finalise the month',
     'Hoe moet ek n werknemer se salaris verander', 'where is the bank file', 'hoe druk ek almal se payslips',
     'How do I reverse a pay run?', 'Should I run payroll before I print payslips?']
      .forEach(q => expect([q, K.isAdviceQuestion(q)]).toEqual([q, false]));
  });
});

describe('API', () => {
  let server, base;
  beforeAll(async () => {
    const { userRouter, adminRouter } = require('../sean/help/routes');
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.companyId = 51; req.user = mockUser; next(); });
    app.use('/api/help', userRouter);
    app.use('/api/sevco/help', adminRouter);
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(() => {
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, { sean_knowledge_items: [], sevco_help_questions: [] });
    mockUser.isSuperAdmin = true; mockUser.userId = 9;
  });
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const article = (over) => Object.assign({ app: 'paytime', slug: 'payslip/oortyd', screen_url: '/payroll/employee-detail.html', screen_name: 'Payslip page',
    tags: 'ure, hours', af: { title: 'Oortyd op \'n payslip invoer', body: '1. Maak die payslip oop\n2. Overtime → + Add' },
    en: { title: 'Add overtime to a payslip', body: '1. Open the payslip\n2. Overtime → + Add' } }, over || {});

  test('a new article is a DRAFT (both languages) and does not answer until approved', async () => {
    const s = await call('PUT', '/api/sevco/help/articles', article());
    expect(s.body.saved.map(x => x.language)).toEqual(['AF', 'EN']);
    expect(mockDb.sean_knowledge_items.every(r => r.status === 'DRAFT' && r.domain === 'PAYTIME_HELP' && r.company_id === null)).toBe(true);
    const a = await call('POST', '/api/help/ask', { app: 'paytime', question: 'hoe sit ek oortyd op n payslip', language: 'AF' });
    expect(a.body.articles).toEqual([]);
    expect(mockDb.sevco_help_questions[0].status).toBe('unmatched');
  });

  test('approved → answers in the asked language, with the screen link; feedback stored', async () => {
    await call('PUT', '/api/sevco/help/articles', article());
    await call('POST', '/api/sevco/help/articles/approve', { app: 'paytime', slug: 'payslip/oortyd' });
    const af = await call('POST', '/api/help/ask', { app: 'paytime', question: 'hoe sit ek oortyd op n payslip', language: 'AF' });
    expect(af.body.articles[0]).toMatchObject({ title: 'Oortyd op \'n payslip invoer', screen_url: '/payroll/employee-detail.html' });
    expect(af.body.ai).toEqual({ status: 'none' });            // no local AI configured in tests
    const en = await call('POST', '/api/help/ask', { app: 'paytime', question: 'how do I add overtime', language: 'EN' });
    expect(en.body.articles[0].title).toBe('Add overtime to a payslip');
    const fb = await call('POST', `/api/help/questions/${en.body.question_id}/feedback`, { feedback: 'down', note: 'unclear' });
    expect(fb.status).toBe(200);
    expect(mockDb.sevco_help_questions.find(q => q.id === en.body.question_id)).toMatchObject({ feedback: 'down', feedback_note: 'unclear' });
  });

  test('editing an approved article makes a new draft version; approving supersedes the old one', async () => {
    await call('PUT', '/api/sevco/help/articles', article());
    await call('POST', '/api/sevco/help/articles/approve', { app: 'paytime', slug: 'payslip/oortyd' });
    await call('PUT', '/api/sevco/help/articles', article({ af: { title: 'Oortyd invoer (nuut)', body: 'Nuwe stappe' }, en: undefined }));
    const afRows = mockDb.sean_knowledge_items.filter(r => r.language === 'AF');
    expect(afRows.map(r => [r.version, r.status])).toEqual([[1, 'APPROVED'], [2, 'DRAFT']]);
    await call('POST', '/api/sevco/help/articles/approve', { app: 'paytime', slug: 'payslip/oortyd' });
    expect(afRows.map(r => r.status)).toEqual(['SUPERSEDED', 'APPROVED']);
    expect(afRows[0].superseded_by_id).toBe(afRows[1].id);
  });

  test('only super users manage knowledge; someone else cannot read another user\'s question', async () => {
    mockUser.isSuperAdmin = false;
    expect((await call('PUT', '/api/sevco/help/articles', article())).status).toBe(403);
    mockDb.sevco_help_questions.push({ id: 77, company_id: 51, user_id: 5, app: 'paytime', ai_status: 'none' });
    expect((await call('GET', '/api/help/questions/77')).status).toBe(404);
  });

  test('archive stops an article from answering', async () => {
    await call('PUT', '/api/sevco/help/articles', article());
    await call('POST', '/api/sevco/help/articles/approve', { app: 'paytime', slug: 'payslip/oortyd' });
    await call('POST', '/api/sevco/help/articles/archive', { app: 'paytime', slug: 'payslip/oortyd' });
    expect((await call('POST', '/api/help/ask', { app: 'paytime', question: 'how do I add overtime', language: 'EN' })).body.articles).toEqual([]);
  });

  test('a tax/advice question gets the paid add-on reply (no article, no AI) and is recorded as advice', async () => {
    await call('PUT', '/api/sevco/help/articles', article());
    await call('POST', '/api/sevco/help/articles/approve', { app: 'paytime', slug: 'payslip/oortyd' });
    const r = await call('POST', '/api/help/ask', { app: 'paytime', question: 'Is overtime taxable?', language: 'AF' });
    expect(r.body).toMatchObject({ advice: true, articles: [], language: 'EN', ai: { status: 'none' } });
    expect(mockDb.sevco_help_questions.find(q => q.id === r.body.question_id).status).toBe('advice');
  });
});

describe('real Paytime articles: common questions find the right article (top 3 shown to the user)', () => {
  const j = require('../../docs/sevco/help/paytime-articles.json');
  const arts = (L) => j.articles.map(a => ({ slug: a.slug, title: a[L].title, body: a[L].body, tags: a.tags }));
  const cases = [
    ['how do I add overtime', 'en', 'payslip/oortyd'], ['hoe sit ek oortyd op n payslip', 'af', 'payslip/oortyd'],
    ['how do I download the bank file', 'en', 'payroll/bank-leer'], ['how do I make IRP5s', 'en', 'paye/easyfile-irp5'],
    ['waar kry ek die emp201', 'af', 'payroll/statutere-opgawes'], ['hoe voeg ek verlof by', 'af', 'werknemer/verlof'],
    ['how do I reverse a pay run', 'en', 'payroll/omkeer'], ['hoe finaliseer ek die maand', 'af', 'payroll/uitvoer-en-finaliseer'],
    ['where do I enter the PAYE reference number', 'en', 'maatskappy/besonderhede'], ['add medical aid', 'en', 'werknemer/mediese-fonds'],
    ['hoe beeindig ek n werknemer se diens', 'af', 'werknemer/diens-beeindig'], ['import previous payroll from old system', 'en', 'invoer/historiese-data']
  ];
  test.each(cases)('%s', (q, L, slug) => {
    expect(K.rank(arts(L), q).map(r => r.slug)).toContain(slug);
  });
  test('every slug is valid for the SEVCO editor and unique', () => {
    const slugs = j.articles.map(a => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    slugs.forEach(s => expect(s).toMatch(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/));
  });
});

describe('real Ledger Leo articles (2026-11-11): common questions find the right article (top 3)', () => {
  const j = require('../../docs/sevco/help/leo-articles.json');
  const arts = (L) => j.articles.map(a => ({ slug: a.slug, title: a[L].title, body: a[L].body, tags: a.tags }));
  const cases = [
    ['how do I create an invoice', 'en', 'kliente/faktuur'], ['hoe maak ek n faktuur', 'af', 'kliente/faktuur'],
    ['how do I email an invoice to the client', 'en', 'kliente/faktuur-epos-pdf'], ['hoe stuur ek n faktuur per epos', 'af', 'kliente/faktuur-epos-pdf'],
    ['convert a quote to an invoice', 'en', 'kliente/kwotasie'], ['hoe maak ek n kwotasie', 'af', 'kliente/kwotasie'],
    ['how do I record a customer payment', 'en', 'kliente/betaling-ontvang'], ['kliënt het betaal hoe teken ek dit aan', 'af', 'kliente/betaling-ontvang'],
    ['how do I add a new customer', 'en', 'kliente/nuwe-klient'], ['add items to my price list', 'en', 'kliente/items'],
    ['credit note for an invoice', 'en', 'kliente/kredietnota'], ['send a statement to a customer', 'en', 'kliente/staat-ouderdom'],
    ['how do I import a bank statement', 'en', 'bank/bankstaat-invoer'], ['hoe laai ek n pdf bankstaat op', 'af', 'bank/bankstaat-invoer'],
    ['allocate bank transactions', 'en', 'bank/toeken'], ['hoe ken ek banktransaksies toe', 'af', 'bank/toeken'],
    ['how do I reconcile the bank', 'en', 'bank/rekonsiliasie'], ['create a bank rule', 'en', 'bank/bankreels'],
    ['record a supplier invoice', 'en', 'verskaffers/verskafferfaktuur'], ['hoe betaal ek n verskaffer', 'af', 'verskaffers/betaal-verskaffer'],
    ['how do I do a journal entry', 'en', 'rekeninge/joernaal'], ['reverse a journal', 'en', 'rekeninge/joernaal'],
    ['opening balances from old system', 'en', 'rekeninge/openingsaldos'], ['how do I lock a month', 'en', 'rekeninge/periode-sluit'],
    ['where is the profit and loss report', 'en', 'verslae/wins-verlies'], ['trial balance', 'en', 'verslae/balansstaat-proefbalans'],
    ['how do I do the VAT201 return', 'en', 'btw/btw201'], ['set up chart of accounts', 'en', 'begin/rekeningplan'],
    ['add a user', 'en', 'maatskappy/gebruikers'], ['client wants to pay monthly', 'en', 'kliente/jaarliks-maandeliks'],
    ['upload company logo', 'en', 'begin/maatskappy-profiel'], ['add a bank account', 'en', 'bank/bankrekening']
  ];
  test.each(cases)('%s', (q, L, slug) => {
    expect(K.rank(arts(L), q).map(r => r.slug)).toContain(slug);
  });
  test('every slug is valid and unique; both languages present; screen links stay inside Leo', () => {
    const slugs = j.articles.map(a => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    j.articles.forEach(a => {
      expect(a.slug).toMatch(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/);
      expect(a.af.title && a.af.body && a.en.title && a.en.body).toBeTruthy();
      expect(a.screen_url).toMatch(/^\/accounting\//);
    });
  });
  test('Leo is a help app on the accounting module', () => {
    expect(K.APPS.leo).toMatchObject({ domain: 'LEO_HELP', module: 'accounting' });
  });
  test('VAT advice questions go to paid Sean; Leo how-to questions do not', () => {
    ['is a cellphone vatable?', 'can I claim VAT on entertainment?', 'what are the VAT rules for exports',
     'is dit nulkoers?', 'mag ek btw eis op n motor?'].forEach(q => expect([q, K.isAdviceQuestion(q)]).toEqual([q, true]));
    ['how do I do the VAT201 return', 'where is the VAT report', 'hoe sluit ek die btw periode', 'how do I create an invoice with VAT']
      .forEach(q => expect([q, K.isAdviceQuestion(q)]).toEqual([q, false]));
  });
});
