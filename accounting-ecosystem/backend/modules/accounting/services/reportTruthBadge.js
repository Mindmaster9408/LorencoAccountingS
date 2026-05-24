const BADGES = {
  posted_gl_only: {
    label: 'Posted GL Only',
    description: 'Contains only posted journal entries. Excludes draft journals, unallocated bank transactions, and sub-ledger data.',
    color: '#14532d',
    bgColor: '#dcfce7',
    borderColor: '#86efac',
  },
  mixed_gl_operational: {
    label: 'GL + Operational',
    description: 'Combines posted GL journal entries with operational data (e.g. bank transactions not yet journalised).',
    color: '#78350f',
    bgColor: '#fef3c7',
    borderColor: '#fde68a',
  },
  diagnostic_reconciliation: {
    label: 'Diagnostic',
    description: 'Reconciliation proof: compares two independent data sources. Differences flag items requiring investigation.',
    color: '#1e3a8a',
    bgColor: '#dbeafe',
    borderColor: '#93c5fd',
  },
};

const SOURCE_MODE_LABELS = {
  all:    'All Journals',
  manual: 'Manual Journals Only',
  system: 'System Journals Only',
};

/**
 * Returns the truth badge metadata for a report response.
 *
 * @param {'posted_gl_only'|'mixed_gl_operational'|'diagnostic_reconciliation'} reportType
 * @param {{ journalSourceMode?: 'all'|'manual'|'system' }} [options]
 */
function getBadge(reportType, { journalSourceMode } = {}) {
  const base = BADGES[reportType] || BADGES.posted_gl_only;
  const mode = ['all', 'manual', 'system'].includes(journalSourceMode) ? journalSourceMode : 'all';

  let label = base.label;
  let description = base.description;

  if (reportType === 'posted_gl_only' && mode !== 'all') {
    const modeLabel = SOURCE_MODE_LABELS[mode];
    label = `${base.label} — ${modeLabel}`;
    description = `${base.description} Filtered to ${modeLabel.toLowerCase()}.`;
  }

  return {
    type: reportType,
    label,
    description,
    color: base.color,
    bgColor: base.bgColor,
    borderColor: base.borderColor,
    journalSourceMode: mode,
  };
}

module.exports = { getBadge };
