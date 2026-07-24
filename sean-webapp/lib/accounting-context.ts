// lib/accounting-context.ts
// Thin proxy: fetches live accounting context from the accounting-ecosystem backend
// to inject into Sean's answers. All errors return null per field — never throws.
//
// Endpoints consumed (all under /api/accounting/, JWT-auth replaced by service token):
//   GET /reports/trial-balance?fromDate=&toDate=
//   GET /bank/transactions?status=unmatched&fromDate=&toDate=&limit=
//   GET /vat-recon/periods?status=open
//
// Auth: Authorization: Bearer <ECO_SERVICE_TOKEN>
//       X-Company-Id:  <companyId>   (backend reads this when service token is present)

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrialBalanceBucket {
  debit: number;
  credit: number;
  balance: number;
}

export interface TrialBalanceSummary {
  fromDate: string;
  toDate: string;
  summary: {
    asset:     TrialBalanceBucket;
    liability: TrialBalanceBucket;
    equity:    TrialBalanceBucket;
    income:    TrialBalanceBucket;
    expense:   TrialBalanceBucket;
    total:     TrialBalanceBucket;
  };
  journalCount: number;
  isBalanced: boolean;
  accountCount: number;
}

export interface UnmatchedTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: string;
  bankAccountName: string | null;
}

export interface VatPeriodStatus {
  openCount: number;
  currentPeriodKey: string | null;
  currentPeriodStatus: string | null;
  periods: Array<{
    id: string;
    periodKey: string;
    status: string;
  }>;
}

export interface AccountingContext {
  companyId: string;
  fetchedAt: string;
  trialBalance: TrialBalanceSummary | null;
  unmatchedTransactions: UnmatchedTransaction[] | null;
  vatPeriodStatus: VatPeriodStatus | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function serviceHeaders(companyId: string): HeadersInit {
  const token = process.env.ECO_SERVICE_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-Company-Id": companyId,
  };
}

// Returns YYYY-MM-DD for a given Date
function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// ── Field fetchers ────────────────────────────────────────────────────────────

async function fetchTrialBalance(
  companyId: string,
  ecoBaseUrl: string
): Promise<TrialBalanceSummary | null> {
  try {
    // Year-to-date: 1 Jan of the current year through today
    const now = new Date();
    const fromDate = `${now.getFullYear()}-01-01`;
    const toDate = isoDate(now);

    const url = `${ecoBaseUrl}/api/accounting/reports/trial-balance?fromDate=${fromDate}&toDate=${toDate}`;
    const res = await fetch(url, { headers: serviceHeaders(companyId) });

    if (!res.ok) {
      console.warn(`[AccountingContext] trial-balance ${res.status} for company ${companyId}`);
      return null;
    }

    const data = await res.json() as {
      fromDate: string;
      toDate: string;
      accounts: unknown[];
      summary: TrialBalanceSummary["summary"];
      journalCount: number;
      isBalanced: boolean;
    };

    return {
      fromDate: data.fromDate,
      toDate: data.toDate,
      summary: data.summary,
      journalCount: data.journalCount ?? 0,
      isBalanced: data.isBalanced ?? false,
      accountCount: Array.isArray(data.accounts) ? data.accounts.length : 0,
    };
  } catch (err) {
    console.error("[AccountingContext] Failed to fetch trial balance:", err);
    return null;
  }
}

async function fetchUnmatchedTransactions(
  companyId: string,
  ecoBaseUrl: string
): Promise<UnmatchedTransaction[] | null> {
  try {
    // Last 30 days
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    const fromDate = isoDate(from);
    const toDate = isoDate(now);

    const url =
      `${ecoBaseUrl}/api/accounting/bank/transactions` +
      `?status=unmatched&fromDate=${fromDate}&toDate=${toDate}&limit=50`;

    const res = await fetch(url, { headers: serviceHeaders(companyId) });

    if (!res.ok) {
      console.warn(`[AccountingContext] bank/transactions ${res.status} for company ${companyId}`);
      return null;
    }

    const data = await res.json() as {
      transactions?: Array<{
        id: string;
        date: string;
        description: string;
        amount: number;
        status: string;
        bank_accounts?: { name: string } | null;
      }>;
    };

    if (!Array.isArray(data.transactions)) return null;

    return data.transactions.map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      status: t.status,
      bankAccountName: t.bank_accounts?.name ?? null,
    }));
  } catch (err) {
    console.error("[AccountingContext] Failed to fetch unmatched transactions:", err);
    return null;
  }
}

async function fetchVatPeriodStatus(
  companyId: string,
  ecoBaseUrl: string
): Promise<VatPeriodStatus | null> {
  try {
    const url = `${ecoBaseUrl}/api/accounting/vat-recon/periods?status=open`;
    const res = await fetch(url, { headers: serviceHeaders(companyId) });

    if (!res.ok) {
      console.warn(`[AccountingContext] vat-recon/periods ${res.status} for company ${companyId}`);
      return null;
    }

    const data = await res.json() as {
      success?: boolean;
      periods?: Array<{ id: string; periodKey?: string; period_key?: string; status: string }>;
    };

    if (!data.success || !Array.isArray(data.periods)) return null;

    const periods = data.periods.map((p) => ({
      id: p.id,
      periodKey: p.periodKey ?? p.period_key ?? "",
      status: p.status,
    }));

    // The most recent open period is the "current" one
    const current = periods[0] ?? null;

    return {
      openCount: periods.length,
      currentPeriodKey: current?.periodKey ?? null,
      currentPeriodStatus: current?.status ?? null,
      periods,
    };
  } catch (err) {
    console.error("[AccountingContext] Failed to fetch VAT period status:", err);
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetches live accounting context from the accounting-ecosystem backend.
 * Each field is fetched independently — one failure does not block the others.
 * Returns null per field on error. Never throws.
 */
export async function getAccountingContext(
  companyId: string,
  ecoBaseUrl: string
): Promise<AccountingContext> {
  const [trialBalance, unmatchedTransactions, vatPeriodStatus] = await Promise.allSettled([
    fetchTrialBalance(companyId, ecoBaseUrl),
    fetchUnmatchedTransactions(companyId, ecoBaseUrl),
    fetchVatPeriodStatus(companyId, ecoBaseUrl),
  ]);

  return {
    companyId,
    fetchedAt: new Date().toISOString(),
    trialBalance:
      trialBalance.status === "fulfilled" ? trialBalance.value : null,
    unmatchedTransactions:
      unmatchedTransactions.status === "fulfilled" ? unmatchedTransactions.value : null,
    vatPeriodStatus:
      vatPeriodStatus.status === "fulfilled" ? vatPeriodStatus.value : null,
  };
}

/**
 * True when at least one field of an AccountingContext was actually fetched —
 * used by callers to decide whether to prepend a summary / write an audit log,
 * versus a context where every ecosystem call failed or returned nothing.
 */
export function hasLiveData(ctx: AccountingContext): boolean {
  return ctx.trialBalance !== null || ctx.unmatchedTransactions !== null || ctx.vatPeriodStatus !== null;
}

// ── Context → readable markdown summary ─────────────────────────────────────
// Shared by app/api/accounting/query/route.ts and app/api/chat/messages/route.ts
// so both surfaces render live data identically instead of each rolling their own.

export function buildContextSummary(ctx: AccountingContext): string {
  const lines: string[] = [];

  if (ctx.trialBalance) {
    const tb = ctx.trialBalance;
    const s = tb.summary;
    const balanced = tb.isBalanced ? "✅ Balanced" : "⚠️ Out of balance";
    lines.push(
      `**Trial Balance (${tb.fromDate} → ${tb.toDate}):** ` +
        `${tb.accountCount} accounts | ${tb.journalCount} posted journals | ${balanced}`
    );
    lines.push(
      `  Income R${s.income.balance.toFixed(2)} | ` +
        `Expenses R${s.expense.balance.toFixed(2)} | ` +
        `Assets R${s.asset.balance.toFixed(2)} | ` +
        `Liabilities R${s.liability.balance.toFixed(2)}`
    );
  }

  if (ctx.unmatchedTransactions !== null) {
    const count = ctx.unmatchedTransactions.length;
    lines.push(
      `**Unmatched Bank Transactions (last 30 days):** ${count} transaction${count !== 1 ? "s" : ""} pending allocation`
    );
  }

  if (ctx.vatPeriodStatus) {
    const v = ctx.vatPeriodStatus;
    if (v.currentPeriodKey) {
      lines.push(
        `**VAT Period:** ${v.currentPeriodKey} — ${v.currentPeriodStatus ?? "open"} ` +
          `(${v.openCount} open period${v.openCount !== 1 ? "s" : ""})`
      );
    } else {
      lines.push(`**VAT Periods:** ${v.openCount} open period${v.openCount !== 1 ? "s" : ""}`);
    }
  }

  if (lines.length === 0) return "";

  return (
    `> 📊 **Live Accounting Data** *(as of ${new Date(ctx.fetchedAt).toLocaleString("en-ZA")})*\n` +
    lines.map((l) => `> ${l}`).join("\n") +
    "\n"
  );
}
