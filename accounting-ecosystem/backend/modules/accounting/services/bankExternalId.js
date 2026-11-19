'use strict';

/**
 * ============================================================================
 * bankExternalId — keep bank transaction external_ids unique per statement LINE
 * ============================================================================
 * PDF / image imports build external_id from date + amount + the first 20
 * letters of the description (see _makeExternalId in sean/pdf- and
 * image-statement-import-service.js). Banks routinely put several genuinely
 * separate, identical lines on one day — e.g. nine R5 "Fee POS declined
 * insufficient funds" charges on one day (Dronedog, 2026-06-29). All of them
 * got the SAME external_id, and the unique index from migration 163
 * (bank_account_id, external_id) then rejected the 2nd one. Because
 * confirmStaged() bulk-inserts, that single collision failed the whole
 * confirm — the user could not push the statement through at all.
 *
 * Scheme: the first occurrence keeps the plain id, the 2nd becomes "<id>#2",
 * the 3rd "<id>#3", ... Numbering is by position in the statement, so
 * re-importing the same statement produces the same ids and real re-imports
 * are still hard-skipped by stageTransactions.
 * ============================================================================
 */

const SUFFIX_RE = /#(\d+)$/;

/** Strip an occurrence suffix: "pdf-x#3" → "pdf-x". */
function baseExternalId(id) {
  return String(id).replace(SUFFIX_RE, '');
}

/**
 * Give repeated external_ids within ONE incoming file an occurrence suffix.
 * Returns a new array; the input is not mutated. Rows without an id are left
 * alone (they go through fuzzy duplicate detection instead).
 *
 * @param {Array<object>} transactions — each with externalId or external_id
 * @returns {Array<object>}
 */
function numberRepeatedExternalIds(transactions) {
  const seen = new Map();
  return (transactions || []).map(txn => {
    const id = txn && (txn.externalId || txn.external_id);
    if (!id) return txn;
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    if (n === 1) return txn;
    const numbered = `${id}#${n}`;
    const out = { ...txn };
    if (out.externalId)  out.externalId  = numbered;
    if (out.external_id) out.external_id = numbered;
    return out;
  });
}

/**
 * Pick a free external_id for each row, given the ids already taken per bank
 * account. A taken id moves to the next free "#n" of its base id. Used when
 * the user explicitly confirms a staged row whose id already exists live —
 * the user has decided it is a separate bank line.
 *
 * @param {Array<{bank_account_id:number, external_id:string|null}>} rows
 * @param {Set<string>} taken — keys "<bank_account_id>|<external_id>"; updated in place
 * @returns {Array<string|null>} resolved id per row (null stays null)
 */
function resolveExternalIdCollisions(rows, taken) {
  return rows.map(row => {
    const id = row.external_id;
    if (!id) return null;
    const acct = row.bank_account_id;
    let candidate = id;
    if (taken.has(`${acct}|${candidate}`)) {
      const base = baseExternalId(id);
      let n = 2;
      while (taken.has(`${acct}|${base}#${n}`)) n++;
      candidate = `${base}#${n}`;
    }
    taken.add(`${acct}|${candidate}`);
    return candidate;
  });
}

module.exports = { baseExternalId, numberRepeatedExternalIds, resolveExternalIdCollisions };
