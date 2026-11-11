'use strict';

/** Tests — shared email service: SMTP (Zoho) first, Resend fallback, sender name + Reply-To per company. */

const mockSent = [];
let mockFail = null;
jest.mock('nodemailer', () => ({
  createTransport: (opts) => ({
    opts,
    sendMail: async (msg) => {
      if (mockFail) { const e = new Error(mockFail.message); e.code = mockFail.code; throw e; }
      mockSent.push({ via: 'smtp', opts, msg });
      return { messageId: '<m1@test>' };
    }
  })
}));
jest.mock('resend', () => ({
  Resend: class { constructor() { this.emails = { send: async (msg) => { mockSent.push({ via: 'resend', msg }); return { data: { id: 'r1' }, error: null }; } }; } }
}));

const ENV_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'RESEND_API_KEY', 'EMAIL_FROM'];
function load(env) {
  ENV_KEYS.forEach(k => delete process.env[k]);
  Object.assign(process.env, env);
  let mod;
  jest.isolateModules(() => { mod = require('../shared/services/email'); });
  return mod;
}

beforeEach(() => { mockSent.length = 0; mockFail = null; });
afterAll(() => ENV_KEYS.forEach(k => delete process.env[k]));

const pdf = Buffer.from('%PDF-1.4 test');

test('not configured → clear failure, nothing sent', async () => {
  const email = load({});
  expect(email.isEmailConfigured()).toBe(false);
  const r = await email.sendEmail({ to: 'a@b.co.za', subject: 'x', body: 'y' });
  expect(r.success).toBe(false);
  expect(mockSent).toHaveLength(0);
});

test('Zoho SMTP: company name as sender on the mailbox address, replies to the company, PDF attached', async () => {
  const email = load({ SMTP_HOST: 'smtp.zoho.com', SMTP_USER: 'accounts@example.co.za', SMTP_PASS: 'app-pass' });
  expect(email.isEmailConfigured()).toBe(true);
  const r = await email.sendEmail({ to: 'client@x.co.za', subject: 'Invoice INV-1', html: '<p>hi</p>',
    attachments: [{ filename: 'Invoice-INV-1.pdf', content: pdf }], fromName: 'Fictional Farms (Pty) Ltd', replyTo: 'info@fictional.co.za' });
  expect(r).toEqual({ success: true, id: '<m1@test>' });
  const { opts, msg } = mockSent[0];
  expect(opts).toMatchObject({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: 'accounts@example.co.za', pass: 'app-pass' } });
  expect(msg.from).toBe('"Fictional Farms (Pty) Ltd" <accounts@example.co.za>');
  expect(msg.replyTo).toBe('info@fictional.co.za');
  expect(msg.attachments[0]).toEqual({ filename: 'Invoice-INV-1.pdf', content: pdf });
});

test('SMTP wins over Resend when both are set; port 587 uses STARTTLS; EMAIL_FROM name form is respected', async () => {
  const email = load({ SMTP_HOST: 'smtppro.zoho.com', SMTP_PORT: '587', SMTP_USER: 'u@example.co.za', SMTP_PASS: 'p',
    RESEND_API_KEY: 're_x', EMAIL_FROM: 'Lorenco <billing@example.co.za>' });
  await email.sendEmail({ to: 'c@x.co.za', subject: 's', body: 'b' });
  expect(mockSent[0].via).toBe('smtp');
  expect(mockSent[0].opts).toMatchObject({ port: 587, secure: false });
  expect(mockSent[0].msg.from).toBe('Lorenco <billing@example.co.za>');   // no fromName → configured From unchanged
  expect(mockSent[0].msg.replyTo).toBeUndefined();
});

test('Resend still works when only Resend is configured (with reply_to)', async () => {
  const email = load({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'billing@example.co.za' });
  expect(email.isEmailConfigured()).toBe(true);
  const r = await email.sendEmail({ to: 'c@x.co.za', subject: 's', body: 'b', fromName: 'Co', replyTo: 'co@x.co.za',
    attachments: [{ filename: 'a.pdf', content: pdf }] });
  expect(r.success).toBe(true);
  expect(mockSent[0]).toMatchObject({ via: 'resend', msg: { from: '"Co" <billing@example.co.za>', reply_to: 'co@x.co.za' } });
  expect(mockSent[0].msg.attachments[0].content).toBe(pdf.toString('base64'));
  expect(load({ RESEND_API_KEY: 're_x' }).isEmailConfigured()).toBe(false);   // Resend needs EMAIL_FROM
});

test('header injection and bad reply-to are neutralised', async () => {
  const email = load({ SMTP_HOST: 'h', SMTP_USER: 'u@example.co.za', SMTP_PASS: 'p' });
  await email.sendEmail({ to: 'c@x.co.za', subject: 's', body: 'b', fromName: 'Evil"\r\nBcc: x@y.com <z>', replyTo: 'not an email' });
  expect(mockSent[0].msg.from).toBe('"Evil Bcc: x@y.com z" <u@example.co.za>');
  expect(mockSent[0].msg.replyTo).toBeUndefined();
});

test('SMTP login and connection failures give a clear message (no secrets)', async () => {
  const email = load({ SMTP_HOST: 'h', SMTP_USER: 'u@example.co.za', SMTP_PASS: 'secret-pass' });
  mockFail = { code: 'EAUTH', message: 'Invalid login: 535 Authentication Failed' };
  let r = await email.sendEmail({ to: 'c@x.co.za', subject: 's', body: 'b' });
  expect(r.success).toBe(false);
  expect(r.message).toMatch(/app password/);
  expect(r.message).not.toMatch(/secret-pass/);
  mockFail = { code: 'ETIMEDOUT', message: 'Connection timeout' };
  r = await email.sendEmail({ to: 'c@x.co.za', subject: 's', body: 'b' });
  expect(r.message).toMatch(/block outgoing email/);
});
