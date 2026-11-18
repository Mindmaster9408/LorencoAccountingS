'use strict';

/**
 * Help bots — "explain step by step" (2026-11-17). Fictional article only.
 * Invariants:
 *   1. An answer with numbers / codes / links / tax words NOT in the article is rejected.
 *   2. An answer that only rephrases the article passes.
 *   3. The chat sent to the model = rules + article, first question, answered follow-ups, new message.
 */

const E = require('../sean/help/explain');

const ARTICLE = [{
  title: 'Add overtime to a payslip',
  screen_name: 'Employee Detail',
  body: '1. Open Employees and pick the employee.\n2. Click "Current Inputs".\n3. Choose Overtime, enter the hours, rate 1.5 is the default.\n4. Click "Save".'
}];

describe('checkAnswer (lock 4)', () => {
  test('a plain step-by-step rephrase passes', () => {
    const a = '1. Click "Employees" on the left.\n2. Pick the employee.\n3. Click "Current Inputs".\nTell me when you are there and I will give you the next step.';
    expect(E.checkAnswer(a, ARTICLE)).toEqual({ ok: true });
  });

  test('numbers from the article are fine, also written with a comma', () => {
    expect(E.checkAnswer('Enter the hours, leave the rate on 1,5 and click "Save".', ARTICLE).ok).toBe(true);
  });

  test('a bare closing line without steps is rejected (trial: the model sent only that)', () => {
    expect(E.checkAnswer('Tell me when you are there.', ARTICLE).ok).toBe(false);
  });

  test('Afrikaans answers drifting into Dutch or English chatter are rejected; echo too', () => {
    expect(E.checkAnswer('1. Klik op "Current Inputs".\n2. Geef \'n reden voor die oortyd.', ARTICLE, 'AF').ok).toBe(false);
    expect(E.checkAnswer('1. Kies + Add Leave Request vir \'n nieuw verlofverzoek.', ARTICLE, 'AF').ok).toBe(false);
    expect(E.checkAnswer("Let's start: klik op Employees en kies die werknemer.", ARTICLE, 'AF').ok).toBe(false);
    expect(E.checkAnswer('Ek het vir jou hierdie hulpartikel gewys: Add overtime. Klik Save.', ARTICLE, 'AF').ok).toBe(false);
    expect(E.checkAnswer('1. Klik op Employees en kies die werknemer.\n2. Klik "Current Inputs".', ARTICLE, 'AF').ok).toBe(true);
  });

  test('a number, rate or code that is not in the article is rejected', () => {
    expect(E.checkAnswer('Overtime is paid at 2.5 on Sundays.', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('Use IRP5 code 3601 for overtime.', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('UIF is 1% of the salary.', ARTICLE).ok).toBe(false);
  });

  test('tax / advice words not in the article are rejected', () => {
    expect(E.checkAnswer('Overtime is taxable, so click Save.', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('Oortyd is belasbaar.', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('SARS wants you to do this monthly.', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('I recommend you pay double time.', ARTICLE).ok).toBe(false);
  });

  test('a tax word the article itself uses is allowed', () => {
    const withSars = [{ title: 'Submit EMP201', body: 'Click "Export" and upload the file on SARS eFiling.' }];
    expect(E.checkAnswer('1. Click "Export".\n2. Upload the file on SARS eFiling.', withSars).ok).toBe(true);
  });

  test('links not in the article, empty and over-long answers are rejected', () => {
    expect(E.checkAnswer('See https://example.com for more.', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('   ', ARTICLE).ok).toBe(false);
    expect(E.checkAnswer('Click Save. '.repeat(200), ARTICLE).ok).toBe(false);
  });
});

describe('buildExplainMessages', () => {
  test('rules + article, first question, only answered follow-ups, then the new message', () => {
    const msgs = E.buildExplainMessages({
      app: 'paytime', language: 'EN', articles: ARTICLE,
      rootQuestion: 'How do I add overtime?',
      history: [
        { question: 'Please explain this step by step.', ai_answer: '1. Click "Employees".' },
        { question: 'Something blocked', ai_answer: null }
      ],
      message: 'I cannot find Current Inputs'
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('Pip');
    expect(msgs[0].content).toContain('Paytime');
    expect(msgs[0].content).toContain('Add overtime to a payslip');
    expect(msgs[0].content).toContain('NOT_COVERED');
    expect(msgs.slice(1).map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[msgs.length - 1].content).toBe('I cannot find Current Inputs');
    expect(msgs.some(m => m.content === 'Something blocked')).toBe(false);
  });

  test('the step the client is at goes with the message, so the AI continues from there', () => {
    const en = E.buildExplainMessages({ app: 'paytime', language: 'EN', articles: ARTICLE, rootQuestion: 'q', history: [], message: 'I do not see the hours', atStep: 3 });
    expect(en[en.length - 1].content).toBe('I do not see the hours (I have already done steps 1 to 3 of the article.)');
    const af = E.buildExplainMessages({ app: 'paytime', language: 'AF', articles: ARTICLE, rootQuestion: 'q', history: [], message: 'Ek sien nie die ure nie', atStep: 0 });
    expect(af[af.length - 1].content).toBe('Ek sien nie die ure nie');
  });

  test('rules are in English for both languages; the answer language is set per question', () => {
    const af = E.buildExplainMessages({ app: 'paytime', language: 'AF', articles: ARTICLE, rootQuestion: 'q', history: [] });
    expect(af[0].content).toContain('South African Afrikaans');
    const en = E.buildExplainMessages({ app: 'paytime', language: 'EN', articles: ARTICLE, rootQuestion: 'q', history: [] });
    expect(en[0].content).toContain('Write the answer in English');
  });

  test('no message → the default "explain step by step" in the language; Lenny for Leo', () => {
    const msgs = E.buildExplainMessages({ app: 'leo', language: 'AF', articles: ARTICLE, rootQuestion: 'Hoe maak ek n faktuur?', history: [] });
    expect(msgs[msgs.length - 1].content).toBe(E.DEFAULT_MESSAGE.AF);
    expect(msgs[0].content).toContain('Lenny');
    expect(msgs[0].content).toContain('Ledger Leo');
  });
});
