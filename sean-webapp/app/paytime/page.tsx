"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

interface IRP5Stats {
  sourceApp: string;
  totalLearningEvents: number;
  totalPatterns: number;
  patternsByStatus: Record<string, number>;
  pendingApprovals: number;
  totalPropagations: number;
  avgConfidence: number;
}

interface IRP5Pattern {
  id: number;
  normalized_item_name: string;
  item_category: string | null;
  suggested_irp5_code: string;
  confidence_score: number;
  occurrence_count: number;
  clients_observed: number;
  status: string;
  last_analyzed_at: string;
}

interface AffectedCompany {
  companyId: number;
  itemId: number;
  itemName: string;
  existingCode?: string;
}

interface IRP5Proposal {
  id: number;
  status: string;
  snapshot_normalized_name: string;
  snapshot_irp5_code: string;
  snapshot_confidence: number;
  snapshot_clients_count: number;
  proposed_at: string;
  approved_at?: string;
  propagation_ran_at?: string;
  propagation_applied_count?: number;
  propagation_skipped_count?: number;
  propagation_exception_count?: number;
  mapping_pattern: IRP5Pattern;
  missing: AffectedCompany[];
  conflicting: AffectedCompany[];
  alreadyCorrect: AffectedCompany[];
}

// ─── Confidence Badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? "bg-green-100 text-green-800 border-green-200" :
    score >= 50 ? "bg-yellow-100 text-yellow-800 border-yellow-200" :
                  "bg-red-100 text-red-800 border-red-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${color}`}>
      {score.toFixed(1)}%
    </span>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    candidate:  "bg-gray-100 text-gray-700",
    proposed:   "bg-blue-100 text-blue-800",
    approved:   "bg-green-100 text-green-800",
    rejected:   "bg-red-100 text-red-800",
    propagated: "bg-purple-100 text-purple-800",
    pending:    "bg-yellow-100 text-yellow-800",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] || "bg-gray-100 text-gray-700"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ─── Proposal Card ────────────────────────────────────────────────────────────

function ProposalCard({
  proposal,
  onApprove,
  onReject,
  onPropagate,
  loading,
}: {
  proposal: IRP5Proposal;
  onApprove: (id: number) => void;
  onReject: (id: number, reason: string) => void;
  onPropagate: (id: number) => void;
  loading: number | null;
}) {
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const isLoading = loading === proposal.id;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900 text-base">
              &ldquo;{proposal.snapshot_normalized_name}&rdquo;
            </span>
            <span className="text-gray-400">→</span>
            <span className="font-mono font-bold text-indigo-700 text-base">
              IRP5 {proposal.snapshot_irp5_code}
            </span>
            <ConfidenceBadge score={proposal.snapshot_confidence} />
            <StatusBadge status={proposal.status} />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Pattern seen across{" "}
            <strong>{proposal.snapshot_clients_count}</strong> client(s).
            Proposed {new Date(proposal.proposed_at).toLocaleDateString("en-ZA")}.
          </p>
        </div>
      </div>

      {/* Breakdown */}
      <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Will be filled */}
        <div className="rounded-md bg-green-50 border border-green-100 p-3">
          <div className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">
            Will be filled ({proposal.missing.length})
          </div>
          {proposal.missing.length === 0 ? (
            <p className="text-xs text-gray-400">No clients need filling.</p>
          ) : (
            <ul className="space-y-1 max-h-28 overflow-y-auto">
              {proposal.missing.map((c) => (
                <li key={c.itemId} className="text-xs text-gray-700">
                  Company #{c.companyId} — {c.itemName}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Exceptions */}
        <div className="rounded-md bg-red-50 border border-red-100 p-3">
          <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2">
            Exceptions — NOT touched ({proposal.conflicting.length})
          </div>
          {proposal.conflicting.length === 0 ? (
            <p className="text-xs text-gray-400">No conflicting codes.</p>
          ) : (
            <ul className="space-y-1 max-h-28 overflow-y-auto">
              {proposal.conflicting.map((c) => (
                <li key={c.itemId} className="text-xs text-gray-700">
                  <span className="font-medium">Company #{c.companyId}</span>{" "}
                  has{" "}
                  <span className="font-mono text-red-700">
                    IRP5 {c.existingCode}
                  </span>{" "}
                  — requires manual review
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Already correct */}
        <div className="rounded-md bg-gray-50 border border-gray-100 p-3">
          <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
            Already correct ({proposal.alreadyCorrect.length})
          </div>
          {proposal.alreadyCorrect.length === 0 ? (
            <p className="text-xs text-gray-400">—</p>
          ) : (
            <ul className="space-y-1 max-h-28 overflow-y-auto">
              {proposal.alreadyCorrect.map((c) => (
                <li key={c.itemId} className="text-xs text-gray-700">
                  Company #{c.companyId}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Propagation result (after propagation ran) */}
      {proposal.propagation_ran_at && (
        <div className="px-5 py-3 bg-purple-50 border-t border-purple-100 text-sm text-purple-700">
          Propagated on {new Date(proposal.propagation_ran_at).toLocaleString("en-ZA")}.
          Applied: {proposal.propagation_applied_count} | Skipped:{" "}
          {proposal.propagation_skipped_count} | Exceptions:{" "}
          {proposal.propagation_exception_count}
        </div>
      )}

      {/* Actions */}
      {proposal.status === "pending" && (
        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-3 flex-wrap">
          <button
            onClick={() => onApprove(proposal.id)}
            disabled={isLoading}
            className="px-4 py-1.5 rounded bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {isLoading ? "Working…" : "Approve"}
          </button>
          <button
            onClick={() => setRejectMode(!rejectMode)}
            disabled={isLoading}
            className="px-4 py-1.5 rounded bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200 disabled:opacity-50"
          >
            Reject
          </button>
          {rejectMode && (
            <div className="flex items-center gap-2 w-full mt-1">
              <input
                type="text"
                placeholder="Reason (optional)"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="flex-1 border border-gray-300 rounded px-3 py-1 text-sm"
              />
              <button
                onClick={() => { onReject(proposal.id, rejectReason); setRejectMode(false); }}
                className="px-3 py-1 text-sm rounded bg-red-600 text-white hover:bg-red-700"
              >
                Confirm Reject
              </button>
            </div>
          )}
        </div>
      )}

      {proposal.status === "approved" && (
        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-3">
          <button
            onClick={() => onPropagate(proposal.id)}
            disabled={isLoading}
            className="px-4 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {isLoading ? "Propagating…" : "Run Propagation"}
          </button>
          <span className="text-xs text-gray-500">
            This will fill missing IRP5 codes only. Existing codes are never overwritten.
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PaytimeIntelligencePage() {
  const [stats, setStats]         = useState<IRP5Stats | null>(null);
  const [patterns, setPatterns]   = useState<IRP5Pattern[]>([]);
  const [proposals, setProposals] = useState<IRP5Proposal[]>([]);
  const [activeTab, setActiveTab] = useState<"proposals" | "patterns" | "log">("proposals");
  const [loading, setLoading]     = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [toast, setToast]         = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const showToast = (type: "success" | "error", msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 5000);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, patternsRes, proposalsRes] = await Promise.all([
        fetch("/api/paytime/stats"),
        fetch("/api/paytime/patterns"),
        fetch("/api/paytime/proposals"),
      ]);
      if (statsRes.ok)     setStats(await statsRes.json());
      if (patternsRes.ok)  setPatterns((await patternsRes.json()).patterns || []);
      if (proposalsRes.ok) setProposals((await proposalsRes.json()).proposals || []);
    } catch (err) {
      console.error("Failed to load Paytime Intelligence data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/paytime/analyze", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        showToast("success", `Analysis complete. ${data.created} created, ${data.updated} updated, ${data.proposed} proposed.`);
        loadData();
      } else {
        showToast("error", data.error || "Analysis failed");
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApprove = async (id: number) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/paytime/proposals/${id}/approve`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        showToast("success", "Proposal approved. Click 'Run Propagation' to apply.");
        loadData();
      } else {
        showToast("error", data.error || "Approval failed");
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: number, reason: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/paytime/proposals/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast("success", "Proposal rejected.");
        loadData();
      } else {
        showToast("error", data.error || "Rejection failed");
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handlePropagate = async (id: number) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/paytime/proposals/${id}/propagate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        const r = data.result;
        showToast(
          "success",
          `Propagation complete. Applied: ${r.applied} | Skipped: ${r.skippedExisting} | Exceptions: ${r.exceptions}`
        );
        if (data.safetyNote) showToast("error", data.safetyNote);
        loadData();
      } else {
        showToast("error", data.error || "Propagation failed");
      }
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-5 py-3 rounded-lg shadow-lg text-sm font-medium max-w-sm ${
            toast.type === "success"
              ? "bg-green-600 text-white"
              : "bg-red-600 text-white"
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
                ← Dashboard
              </Link>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">
              Paytime Intelligence
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              Sean IRP5 code learning engine — controlled standardization across Paytime clients
            </p>
          </div>
          <button
            onClick={handleAnalyze}
            disabled={analyzing || loading}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {analyzing ? "Analyzing…" : "Run Analysis"}
          </button>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
            {[
              { label: "Learning Events", value: stats.totalLearningEvents },
              { label: "Patterns", value: stats.totalPatterns },
              { label: "Pending Approvals", value: stats.pendingApprovals, highlight: stats.pendingApprovals > 0 },
              { label: "Propagations Applied", value: stats.totalPropagations },
              { label: "Avg Confidence", value: `${stats.avgConfidence}%` },
              { label: "Proposed", value: stats.patternsByStatus?.proposed || 0 },
            ].map(({ label, value, highlight }) => (
              <div
                key={label}
                className={`bg-white rounded-lg border p-4 text-center ${
                  highlight ? "border-yellow-300 bg-yellow-50" : "border-gray-200"
                }`}
              >
                <div className={`text-2xl font-bold ${highlight ? "text-yellow-700" : "text-gray-900"}`}>
                  {value}
                </div>
                <div className="text-xs text-gray-500 mt-1">{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Safety Rule Banner */}
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-5 py-3 text-sm text-blue-800">
          <strong>Safety rules active:</strong> Sean will only fill clients where IRP5 code is missing.
          Existing codes are <strong>never overwritten automatically</strong>. Clients with conflicting codes
          are shown as exceptions and require individual review.
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 mb-6">
          {[
            { key: "proposals", label: `Proposals (${proposals.length})` },
            { key: "patterns",  label: `All Patterns (${patterns.length})` },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key as "proposals" | "patterns")}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div className="py-20 text-center text-gray-400 text-sm">Loading Paytime Intelligence…</div>
        )}

        {/* Proposals Tab */}
        {!loading && activeTab === "proposals" && (
          <div className="space-y-6">
            {proposals.length === 0 ? (
              <div className="py-16 text-center bg-white rounded-lg border border-gray-200">
                <div className="text-gray-400 text-sm">
                  No proposals pending. Run Analysis to discover patterns from learning events.
                </div>
                <button
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50"
                >
                  {analyzing ? "Analyzing…" : "Run Analysis Now"}
                </button>
              </div>
            ) : (
              proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onPropagate={handlePropagate}
                  loading={actionLoading}
                />
              ))
            )}
          </div>
        )}

        {/* All Patterns Tab */}
        {!loading && activeTab === "patterns" && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {patterns.length === 0 ? (
              <div className="py-12 text-center text-sm text-gray-400">
                No patterns discovered yet. Learning events will be analyzed automatically when IRP5 codes are set in Paytime.
              </div>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Payroll Item</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Category</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">IRP5 Code</th>
                    <th className="px-4 py-3 text-center font-medium text-gray-600">Confidence</th>
                    <th className="px-4 py-3 text-center font-medium text-gray-600">Occurrences</th>
                    <th className="px-4 py-3 text-center font-medium text-gray-600">Clients</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {patterns.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-800">{p.normalized_item_name}</td>
                      <td className="px-4 py-3 text-gray-500">{p.item_category || "—"}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-indigo-700">{p.suggested_irp5_code}</td>
                      <td className="px-4 py-3 text-center">
                        <ConfidenceBadge score={p.confidence_score} />
                      </td>
                      <td className="px-4 py-3 text-center text-gray-600">{p.occurrence_count}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{p.clients_observed}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Footer note */}
        <p className="mt-8 text-xs text-gray-400 text-center">
          Sean IRP5 Learning Engine · Governed by CLAUDE.md Part B · All propagation actions are audit-logged
        </p>
      </div>
    </div>
  );
}
