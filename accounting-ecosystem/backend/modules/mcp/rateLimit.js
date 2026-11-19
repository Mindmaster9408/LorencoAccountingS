'use strict';

/**
 * Fair-use limits for bot traffic on /mcp (Ruan 2026-11-18: protects the shared server;
 * limits TEMPO only — never a bot's rights or how many bots a practice runs).
 *
 *   per user (each bot)          60 / minute, bursts up to 120
 *   per company (all bots)      600 / minute
 *   heavy tools per user         10 / minute   (imports, PDF reports — future write tools)
 *
 * Token buckets in process memory (one Render instance). Override with env:
 *   MCP_RATE_USER_PER_MIN, MCP_RATE_USER_BURST, MCP_RATE_COMPANY_PER_MIN, MCP_RATE_HEAVY_PER_MIN
 */

const num = (v, d) => { const n = parseInt(v, 10); return n > 0 ? n : d; };

class Buckets {
  constructor(perMinute, burst) {
    this.rate = perMinute / 60000;         // tokens per ms
    this.capacity = burst || perMinute;
    this.map = new Map();
  }
  /** @returns {{ ok: boolean, retryAfterSec: number }} */
  take(key, cost = 1, now = Date.now()) {
    let b = this.map.get(key);
    if (!b) { b = { tokens: this.capacity, ts: now }; this.map.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.ts) * this.rate);
    b.ts = now;
    if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, retryAfterSec: 0 }; }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cost - b.tokens) / this.rate / 1000)) };
  }
  prune(now = Date.now(), idleMs = 10 * 60000) {
    for (const [k, b] of this.map) if (now - b.ts > idleMs) this.map.delete(k);
  }
}

function createLimiter(env = process.env) {
  const user    = new Buckets(num(env.MCP_RATE_USER_PER_MIN, 60), num(env.MCP_RATE_USER_BURST, 120));
  const company = new Buckets(num(env.MCP_RATE_COMPANY_PER_MIN, 600));
  const heavy   = new Buckets(num(env.MCP_RATE_HEAVY_PER_MIN, 10));
  let calls = 0;
  return {
    /** Check (and spend) every bucket that applies; nothing is spent when one refuses. */
    check({ userId, companyId, heavy: isHeavy }, now = Date.now()) {
      if (++calls % 500 === 0) { user.prune(now); company.prune(now); heavy.prune(now); }
      const tests = [[user, 'u' + userId, 'per bot']];
      if (companyId) tests.push([company, 'c' + companyId, 'per company']);
      if (isHeavy) tests.push([heavy, 'h' + userId, 'heavy actions per bot']);
      // Dry run first so a refusal never spends tokens in the other buckets.
      for (const [b, key, scope] of tests) {
        const snap = b.map.get(key) ? { ...b.map.get(key) } : null;
        const r = b.take(key, 1, now);
        if (snap) b.map.set(key, snap); else b.map.delete(key);
        if (!r.ok) return { ok: false, retryAfterSec: r.retryAfterSec, scope };
      }
      tests.forEach(([b, key]) => b.take(key, 1, now));
      return { ok: true };
    }
  };
}

module.exports = { Buckets, createLimiter };
