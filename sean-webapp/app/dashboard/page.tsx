"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface DashboardStats {
  system: {
    users: number;
    conversations: number;
    messages: number;
    codex: {
      total: number;
      approved: number;
      pending: number;
    };
    allocations: {
      total: number;
      processed: number;
      rules: number;
    };
    bootstrapCalls: number;
  };
  user: {
    conversations: number;
    codexSubmitted: number;
    transactions: number;
  };
  codexByDomain: Array<{ domain: string; count: number }>;
  recentActivity: Array<{
    id: string;
    action: string;
    user: string;
    createdAt: string;
  }>;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      try {
        const res = await fetch("/api/dashboard/stats");
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } catch (error) {
        console.error("Failed to load stats:", error);
      } finally {
        setLoading(false);
      }
    };

    loadStats();
    // Refresh every 30 seconds
    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const formatAction = (action: string) => {
    const labels: Record<string, string> = {
      LOGIN: "User Login",
      LOGOUT: "User Logout",
      MESSAGE_SEND: "Message Sent",
      KB_SUBMIT: "Codex Submitted",
      KB_APPROVE: "Codex Approved",
      KB_REJECT: "Codex Rejected",
      REASON_QUERY: "Codex Query",
      LLM_BOOTSTRAP: "LLM Bootstrap",
      ALLOCATION_LEARN: "Allocation Learned",
      ALLOCATION_REINFORCE: "Allocation Reinforced",
      TRANSACTIONS_IMPORT: "Transactions Imported",
    };
    return labels[action] || action;
  };

  const formatDomain = (domain: string) => {
    return domain.replace(/_/g, " ");
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 text-white">
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold">Sean AI Dashboard</h1>
              <p className="text-blue-100 mt-1">System overview and statistics</p>
            </div>
            <div className="flex gap-4">
              <Link href="/chat" className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition">
                Chat
              </Link>
              <Link href="/codex" className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition">
                Codex
              </Link>
              <Link href="/allocations" className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition">
                Allocations
              </Link>
              <Link href="/paytime" className="px-4 py-2 bg-indigo-500/80 hover:bg-indigo-500 rounded-lg transition font-medium">
                Paytime IRP5
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading dashboard...</div>
        ) : stats ? (
          <>
            {/* Main Stats Cards */}
            <div className="grid grid-cols-4 gap-6 mb-8">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500">Codex Items</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.system.codex.approved}</p>
                  </div>
                  <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                    <span className="text-2xl">📚</span>
                  </div>
                </div>
                <div className="mt-4 text-sm">
                  <span className="text-yellow-600">{stats.system.codex.pending} pending</span>
                  <span className="text-slate-400 mx-2">·</span>
                  <span className="text-slate-500">{stats.system.codex.total} total</span>
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500">Conversations</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.system.conversations}</p>
                  </div>
                  <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                    <span className="text-2xl">💬</span>
                  </div>
                </div>
                <div className="mt-4 text-sm text-slate-500">
                  {stats.system.messages} messages total
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500">Allocation Rules</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.system.allocations.rules}</p>
                  </div>
                  <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                    <span className="text-2xl">🧠</span>
                  </div>
                </div>
                <div className="mt-4 text-sm text-slate-500">
                  {stats.system.allocations.processed}/{stats.system.allocations.total} processed
                </div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500">LLM Bootstraps</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.system.bootstrapCalls}</p>
                  </div>
                  <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
                    <span className="text-2xl">⚡</span>
                  </div>
                </div>
                <div className="mt-4 text-sm text-slate-500">
                  External API calls cached
                </div>
              </div>
            </div>

            {/* Your Stats */}
            <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-xl p-6 mb-8 text-white">
              <h2 className="text-lg font-semibold mb-4">Your Activity</h2>
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="text-slate-400 text-sm">Your Conversations</p>
                  <p className="text-2xl font-bold">{stats.user.conversations}</p>
                </div>
                <div>
                  <p className="text-slate-400 text-sm">Codex Submitted</p>
                  <p className="text-2xl font-bold">{stats.user.codexSubmitted}</p>
                </div>
                <div>
                  <p className="text-slate-400 text-sm">Transactions Processed</p>
                  <p className="text-2xl font-bold">{stats.user.transactions}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-8">
              {/* Codex by Domain */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-4">Codex by Domain</h2>
                {stats.codexByDomain.length > 0 ? (
                  <div className="space-y-3">
                    {stats.codexByDomain
                      .sort((a, b) => b.count - a.count)
                      .map(d => (
                        <div key={d.domain} className="flex items-center gap-3">
                          <div className="flex-1">
                            <div className="flex justify-between text-sm mb-1">
                              <span className="font-medium text-slate-700">{formatDomain(d.domain)}</span>
                              <span className="text-slate-500">{d.count}</span>
                            </div>
                            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full"
                                style={{
                                  width: `${Math.min(100, (d.count / Math.max(...stats.codexByDomain.map(x => x.count))) * 100)}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-slate-500 text-sm">No codex items yet</p>
                )}
              </div>

              {/* Recent Activity */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-4">Recent Activity</h2>
                <div className="space-y-3">
                  {stats.recentActivity.map(activity => (
                    <div key={activity.id} className="flex items-center gap-3 text-sm">
                      <div className="w-2 h-2 bg-blue-500 rounded-full" />
                      <div className="flex-1">
                        <span className="font-medium text-slate-900">{formatAction(activity.action)}</span>
                        <span className="text-slate-400 mx-2">by</span>
                        <span className="text-slate-600">{activity.user}</span>
                      </div>
                      <span className="text-slate-400 text-xs">
                        {new Date(activity.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Quick Links */}
            <div className="mt-8 grid grid-cols-4 gap-4">
              <Link
                href="/chat"
                className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition group"
              >
                <span className="text-3xl mb-3 block">💬</span>
                <h3 className="font-semibold text-slate-900 group-hover:text-blue-600">Chat with Sean</h3>
                <p className="text-sm text-slate-500">Ask questions or add to codex</p>
              </Link>

              <Link
                href="/codex"
                className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition group"
              >
                <span className="text-3xl mb-3 block">📚</span>
                <h3 className="font-semibold text-slate-900 group-hover:text-blue-600">Codex</h3>
                <p className="text-sm text-slate-500">Manage and approve codex items</p>
              </Link>

              <Link
                href="/allocations"
                className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition group"
              >
                <span className="text-3xl mb-3 block">🏦</span>
                <h3 className="font-semibold text-slate-900 group-hover:text-blue-600">Bank Allocations</h3>
                <p className="text-sm text-slate-500">Process transactions</p>
              </Link>

              <Link
                href="/admin/users"
                className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition group"
              >
                <span className="text-3xl mb-3 block">👥</span>
                <h3 className="font-semibold text-slate-900 group-hover:text-blue-600">User Management</h3>
                <p className="text-sm text-slate-500">Manage allowed users</p>
              </Link>
            </div>
          </>
        ) : (
          <div className="text-center py-12 text-slate-500">Failed to load dashboard</div>
        )}
      </div>
    </div>
  );
}
