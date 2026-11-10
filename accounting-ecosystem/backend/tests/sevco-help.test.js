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
});
