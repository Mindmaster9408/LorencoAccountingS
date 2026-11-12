/**
 * App pricing shown to clients when they request an app.
 *
 * Price lists are still being finalised (Ruan, 2026-11-11). While an app has
 * no entry here the "Manage apps" modal tells the client that Lorenco will
 * confirm the price before activating, and they accept that instead.
 *
 * When a price list is ready, add entries like:
 *   payroll: { text: 'R 350 per month + R 25 per employee', billing: 'monthly in advance' },
 * The modal then shows the text and the client must accept it before
 * requesting; the accepted text is stored on the request (price_shown).
 */
const APP_PRICES = {
  // pos:        { text: '', billing: 'monthly in advance' },
  // payroll:    { text: '', billing: 'monthly in advance' },
  // accounting: { text: '', billing: 'monthly in advance' },
  // inventory:  { text: '', billing: 'monthly in advance' },
  // practice:   { text: '', billing: 'monthly in advance' },
  // sean:       { text: '', billing: 'monthly in advance' },
};

/** The price text for an app, or null when no price has been set yet. */
function priceFor(appKey) {
  const p = APP_PRICES[appKey];
  return p && p.text ? { text: p.text, billing: p.billing || 'monthly in advance' } : null;
}

module.exports = { APP_PRICES, priceFor };
