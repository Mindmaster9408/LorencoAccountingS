'use strict';

/**
 * vita.report.js — VITA Report Generator
 *
 * Combines vita.engine.js (data) + vita.template.js (structure)
 * to produce a final markdown report string.
 *
 * Exports:
 *   generateVitaReport(ranking) → { markdown, generatedAt }
 */

const { buildVitaData } = require('./vita.engine');
const { VITA_TEMPLATE } = require('./vita.template');

/**
 * Replace all {{VARIABLE}} placeholders in the template.
 * Throws if any placeholder remains unreplaced after substitution,
 * so a missing variable is caught immediately rather than silently left in output.
 *
 * @param {string} template
 * @param {object} data — key/value map matching placeholder names
 * @returns {string}
 */
function mergeTemplate(template, data) {
  let output = template;

  for (const [key, value] of Object.entries(data)) {
    // Replace all occurrences of {{KEY}}
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    output = output.replace(placeholder, value != null ? String(value) : '');
  }

  // Safety check — catch any unreplaced placeholders
  const remaining = output.match(/\{\{[A-Z_]+\}\}/g);
  if (remaining) {
    throw new Error(
      `VITA template merge incomplete. Unreplaced placeholders: ${remaining.join(', ')}`
    );
  }

  return output;
}

/**
 * generateVitaReport
 *
 * @param {string[]} ranking — 6-element ordered array of VITA dimension keys
 * @returns {{ markdown: string, generatedAt: string }}
 */
function generateVitaReport(ranking, clientName = '') {
  const generatedAt = new Date().toISOString();
  const data        = buildVitaData(ranking);

  // Inject the timestamp into the data map so the template can use {{GENERATED_AT}}
  data.GENERATED_AT = generatedAt;

  // Inject client name line (empty string if anonymous — template renders nothing)
  data.CLIENT_NAME_LINE = clientName
    ? `**Kliënt:** ${clientName}\n`
    : '';

  // Inject formatted date in Afrikaans locale
  data.VITA_DATE = new Date().toLocaleDateString('af-ZA', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const markdown = mergeTemplate(VITA_TEMPLATE, data);

  return { markdown, generatedAt };
}

module.exports = { generateVitaReport, mergeTemplate };
