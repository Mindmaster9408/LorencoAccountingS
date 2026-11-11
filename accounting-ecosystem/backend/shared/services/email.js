/**
 * ============================================================================
 * Email Service — SMTP (Zoho) or Resend
 * ============================================================================
 * Every caller across the backend (invoice/statement sends, monthly invoice
 * plans, Collector requests; payslip emails etc. later) goes through this one
 * function — "Shared > duplicated".
 *
 * Provider is chosen from env (2026-11-11, Ruan uses Zoho Mail):
 *   1. SMTP  — SMTP_HOST + SMTP_USER + SMTP_PASS (+ SMTP_PORT, default 465 = SSL)
 *              e.g. Zoho: smtp.zoho.com / smtppro.zoho.com (organisation
 *              accounts), with a Zoho *app password*, never the login password.
 *   2. Resend — RESEND_API_KEY
 *   EMAIL_FROM = the sending address ("Name <addr>" or "addr"). With SMTP it
 *   defaults to SMTP_USER; Zoho only accepts the mailbox's own address/aliases.
 *
 * Multi-tenant: one sending mailbox serves every company. Callers pass
 * fromName (the invoicing company's name — shown as the sender) and replyTo
 * (that company's own email) so customers see and reply to the right business.
 *
 * Unconfigured → success:false with a clear message (never a silent "sent").
 * Secrets are never logged.
 * ============================================================================
 */
let Resend = null;
try { ({ Resend } = require('resend')); } catch (_) { /* not installed → Resend unavailable */ }
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* not installed → SMTP unavailable */ }

function smtpReady() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
function resendReady() {
  return !!(Resend && process.env.RESEND_API_KEY);
}
function provider() {
  if (smtpReady()) return 'smtp';
  if (resendReady()) return 'resend';
  return null;
}

let smtpTransport = null;
function getSmtp() {
  if (!smtpTransport) {
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,                 // 465 = SSL; 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Fail fast (e.g. a host that blocks outgoing SMTP) instead of hanging the request.
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
    });
  }
  return smtpTransport;
}

let resendClient = null;
function getResend() {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/** The bare address out of "Name <addr>" or "addr" (pure). */
function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim();
}

/** Display name safe for a From header: no quotes/angle brackets/newlines (pure). */
function cleanName(name) {
  return String(name || '').replace(/[\r\n"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** The From header: the caller's display name on the configured address (pure). */
function buildFrom(configuredFrom, fromName) {
  const addr = addressOf(configuredFrom);
  const name = cleanName(fromName);
  if (!name) return configuredFrom;
  return `"${name}" <${addr}>`;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} [body] - plain-text fallback
 * @param {string} [html]
 * @param {{filename: string, content: Buffer}[]} [attachments]
 * @param {string} [fromName] - sender display name (e.g. the invoicing company)
 * @param {string} [replyTo]  - where replies go (e.g. that company's email)
 */
async function sendEmail({ to, subject, body, html, attachments, fromName, replyTo }) {
  const which = provider();
  const configuredFrom = process.env.EMAIL_FROM || (which === 'smtp' ? process.env.SMTP_USER : '');

  if (!which || !configuredFrom) {
    console.warn(`📧 Email NOT sent (service not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS or RESEND_API_KEY + EMAIL_FROM): To=${to}, Subject=${subject}`);
    return { success: false, message: 'Email service not configured yet.' };
  }

  const from = buildFrom(configuredFrom, fromName);
  const reply = replyTo && EMAIL_RE.test(String(replyTo).trim()) ? String(replyTo).trim() : undefined;

  try {
    if (which === 'smtp') {
      const info = await getSmtp().sendMail({
        from, to, subject, replyTo: reply,
        text: body || undefined,
        html: html || body || undefined,
        attachments: (attachments || []).map(a => ({ filename: a.filename, content: a.content }))
      });
      console.log(`📧 Email sent (smtp): To=${to}, Subject=${subject}, id=${info && info.messageId}`);
      return { success: true, id: info && info.messageId };
    }

    const { data, error } = await getResend().emails.send({
      from, to, subject,
      reply_to: reply,
      text: body || undefined,
      html: html || body || undefined,
      attachments: (attachments || []).map(a => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      })),
    });
    if (error) {
      console.error(`📧 Email send failed (resend): To=${to}, Subject=${subject}`, error);
      return { success: false, message: error.message || 'Email provider rejected the send.' };
    }
    console.log(`📧 Email sent (resend): To=${to}, Subject=${subject}, id=${data?.id}`);
    return { success: true, id: data?.id };
  } catch (err) {
    console.error(`📧 Email send threw (${which}): To=${to}, Subject=${subject}:`, err.message);
    let message = err.message;
    if (which === 'smtp' && /EAUTH|535|auth/i.test(`${err.code} ${err.message}`)) {
      message = 'The mail server refused the login — check SMTP_USER and the app password (SMTP_PASS).';
    } else if (which === 'smtp' && /ETIMEDOUT|ECONNREFUSED|ECONNECTION|ESOCKET|timeout/i.test(`${err.code} ${err.message}`)) {
      message = 'Could not reach the mail server — check SMTP_HOST/SMTP_PORT, or the host may block outgoing email.';
    }
    return { success: false, message };
  }
}

async function sendPayslipEmail(employee, payslipPdf) {
  return sendEmail({
    to: employee.email,
    subject: `Payslip - ${employee.full_name}`,
    body: 'Please find your payslip attached.',
    attachments: payslipPdf ? [{ filename: `Payslip-${employee.full_name}.pdf`, content: payslipPdf }] : undefined,
  });
}

/** True when outgoing email can actually be sent. Never exposes the values. */
function isEmailConfigured() {
  const which = provider();
  if (which === 'smtp') return true;              // EMAIL_FROM defaults to SMTP_USER
  return which === 'resend' && !!process.env.EMAIL_FROM;
}

module.exports = { sendEmail, sendPayslipEmail, isEmailConfigured, _internal: { addressOf, cleanName, buildFrom, provider } };
