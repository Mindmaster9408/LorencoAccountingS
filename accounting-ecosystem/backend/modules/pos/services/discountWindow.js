/**
 * ============================================================================
 * Daily Discount Window - Shared "is this discount active right now" logic
 * ============================================================================
 * Used by both discounts.js (list + performance) and products.js (price
 * attachment) so the two routes can't drift out of sync on what "today"
 * means for a discount with no end date.
 *
 * Business rule (Checkout Charlie till behaviour):
 *   - valid_until set   -> discount stays active through the end of that date
 *   - valid_until blank -> discount is a single-day discount: active only on
 *     its own creation day, then resets (stops applying) at midnight
 *
 * Day boundaries are anchored to SAST (UTC+2, no DST) rather than server/UTC
 * midnight, since tills expect "resets at midnight" to mean their own local
 * midnight, not whenever UTC happens to roll over.
 * ============================================================================
 */

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/**
 * SAST calendar day + UTC-offset ISO bounds for that day, for a given instant
 * (defaults to now). Pass a discount's created_at to get the bounds of the
 * day IT was created on, not necessarily today.
 */
function getBusinessDayBounds(atDate = new Date()) {
  const sast = new Date(new Date(atDate).getTime() + SAST_OFFSET_MS);
  const day = sast.toISOString().split('T')[0]; // YYYY-MM-DD in SAST terms
  return {
    day,
    dayStartISO: `${day}T00:00:00.000+02:00`,
    dayEndISO: `${day}T23:59:59.999+02:00`,
  };
}

/**
 * PostgREST .or() fragment: true when a discount row is active for `today`
 * (the SAST calendar day, per getBusinessDayBounds().day).
 */
function activeDiscountOrFilter({ day, dayStartISO, dayEndISO }) {
  return `and(valid_until.not.is.null,valid_until.gte.${day}),and(valid_until.is.null,created_at.gte.${dayStartISO},created_at.lte.${dayEndISO})`;
}

/**
 * True if a discount row (with valid_until + created_at already loaded) is
 * active on `today` (a YYYY-MM-DD SAST day string, from getBusinessDayBounds().day).
 */
function isDiscountActiveToday(discount, today) {
  if (discount.valid_until) return discount.valid_until >= today;
  return getBusinessDayBounds(discount.created_at).day === today;
}

module.exports = { getBusinessDayBounds, activeDiscountOrFilter, isDiscountActiveToday };
