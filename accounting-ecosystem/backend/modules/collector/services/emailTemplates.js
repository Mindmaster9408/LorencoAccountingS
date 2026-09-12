/**
 * ============================================================================
 * Collector — Email Templates
 * ============================================================================
 * Every client-facing string is built here, from variables — never hardcoded
 * inline in a route — so that (a) jurisdiction terminology substitution and
 * (b) real translation later are both additive changes, not a rewrite.
 *
 * v1 scope: jurisdiction terminology (VAT vs GST vs Sales Tax) is defined for
 * all 4 supported jurisdictions, but the email copy itself doesn't currently
 * need to reference the tax term directly (the checklist item labels, which
 * staff author per client, already carry any jurisdiction-specific wording,
 * e.g. "VAT support documents" vs "GST support documents"). JURISDICTION_TERMS
 * is still fully populated now so future copy can reference it without
 * re-deriving jurisdiction naming conventions from scratch.
 * ============================================================================
 */

const JURISDICTION_TERMS = {
  ZA:    { taxTerm: 'VAT',        agency: 'SARS' },
  UK:    { taxTerm: 'VAT',        agency: 'HMRC' },
  AU_NZ: { taxTerm: 'GST',        agency: 'the ATO/IRD' },
  US:    { taxTerm: 'Sales Tax',  agency: 'the IRS' },
};

function termsFor(jurisdiction) {
  return JURISDICTION_TERMS[jurisdiction] || JURISDICTION_TERMS.ZA;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function itemLine(item) {
  const icon = item.status === 'accepted' ? '✅'
    : item.status === 'submitted' || item.status === 'needs_review' ? '⚠️'
    : '❌';
  return `${icon} ${item.label}`;
}

/**
 * @param {object} opts
 * @param {object} opts.client        collector_clients row
 * @param {object} opts.period        collector_periods row
 * @param {object[]} opts.periodItems collector_period_items rows for this period
 * @param {string} opts.uploadUrl     full https URL to the client-facing page
 * @param {'initial_request'|'reminder'|'completion_confirmation'} opts.type
 * @param {string} [opts.firmName]
 */
function renderRequestEmail({ client, period, periodItems, uploadUrl, type, firmName }) {
  const firm = firmName || 'Lorenco Accounting Services';
  const outstanding = periodItems.filter(i => i.status === 'outstanding' && i.is_required);
  const totalRequired = periodItems.filter(i => i.is_required).length;
  const outstandingCount = outstanding.length;

  let subject;
  let intro;
  if (type === 'completion_confirmation') {
    subject = `${client.display_name} — ${period.period_label}: all documents received`;
    intro = `Thank you. We have received all the documents we need for ${period.period_label}. ${firm} can now continue processing. We will be in touch if anything further is required.`;
  } else if (type === 'reminder') {
    subject = `Reminder: ${outstandingCount} document${outstandingCount === 1 ? '' : 's'} still needed — ${client.display_name} (${period.period_label})`;
    intro = `This is a follow-up on ${period.period_label}'s bookkeeping documents. We still need ${outstandingCount} of ${totalRequired} item${totalRequired === 1 ? '' : 's'}.`;
  } else {
    subject = `${firm} — documents needed for ${period.period_label}`;
    intro = `We are busy with ${client.display_name}'s bookkeeping for ${period.period_label}. We need the following documents:`;
  }

  const listText = periodItems.map(itemLine).join('\n');
  const listHtml = periodItems.map(i => `<li>${itemLine(i)}</li>`).join('');

  const linkBlock = type === 'completion_confirmation'
    ? ''
    : `You can securely upload documents here: ${uploadUrl}\n`;
  const linkHtml = type === 'completion_confirmation'
    ? ''
    : `<p><a href="${escapeHtml(uploadUrl)}" style="display:inline-block;background:#d97706;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Upload documents</a></p>
       <p style="font-size:13px;color:#666;">Or copy this link: ${escapeHtml(uploadUrl)}</p>`;

  const text = `Hi ${client.primary_contact_name || ''},\n\n${intro}\n\n${listText}\n\n${linkBlock}\nKind regards,\n${firm}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">
      <p>Hi ${escapeHtml(client.primary_contact_name || '')},</p>
      <p>${escapeHtml(intro)}</p>
      <ul style="line-height:1.8;">${listHtml}</ul>
      ${linkHtml}
      <p style="margin-top:24px;">Kind regards,<br/>${escapeHtml(firm)}</p>
    </div>
  `;

  return { subject, text, html };
}

module.exports = {
  JURISDICTION_TERMS,
  termsFor,
  renderRequestEmail,
};
