/**
 * ============================================================================
 * Email Service (Resend)
 * ============================================================================
 * Real email sending, replacing the old log-only placeholder. Every caller
 * across the backend (invoice/statement sends today; payslip emails, POS
 * receipt emails, and the password-reset flow are dormant candidates for
 * later) goes through this one function — "Shared > duplicated".
 *
 * Configuration: RESEND_API_KEY + EMAIL_FROM in env. Until Ruan supplies a
 * real verified sending domain/address, these stay unset — sendEmail()
 * fails CLEARLY (success:false) rather than the old stub's silent
 * success:true-on-a-no-op, which would have made a real failure look like
 * a successful send to every caller.
 * ============================================================================
 */
let Resend = null;
try {
  ({ Resend } = require('resend'));
} catch (_) {
  // Package not installed yet in some environment — handled below by the
  // same "not configured" path as a missing API key.
}

let resendClient = null;
function getClient() {
  if (!process.env.RESEND_API_KEY || !Resend) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} [body] - plain-text fallback
 * @param {string} [html]
 * @param {{filename: string, content: Buffer}[]} [attachments]
 */
async function sendEmail({ to, subject, body, html, attachments }) {
  const client = getClient();
  const from = process.env.EMAIL_FROM;

  if (!client || !from) {
    console.warn(`📧 Email NOT sent (service not configured — set RESEND_API_KEY + EMAIL_FROM): To=${to}, Subject=${subject}`);
    return { success: false, message: 'Email service not configured yet.' };
  }

  try {
    const { data, error } = await client.emails.send({
      from,
      to,
      subject,
      text: body || undefined,
      html: html || body || undefined,
      attachments: (attachments || []).map(a => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
      })),
    });

    if (error) {
      console.error(`📧 Email send failed: To=${to}, Subject=${subject}`, error);
      return { success: false, message: error.message || 'Email provider rejected the send.' };
    }

    console.log(`📧 Email sent: To=${to}, Subject=${subject}, id=${data?.id}`);
    return { success: true, id: data?.id };
  } catch (err) {
    console.error(`📧 Email send threw: To=${to}, Subject=${subject}`, err);
    return { success: false, message: err.message };
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

/** True when outgoing email can actually be sent (key + sender + package). Never exposes the values. */
function isEmailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && Resend);
}

module.exports = { sendEmail, sendPayslipEmail, isEmailConfigured };
