"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface AllowedEmail {
  email: string;
  role: string;
  addedBy: string | null;
  createdAt: string;
  isCore: boolean;
}

interface UserStats {
  id: string;
  email: string;
  createdAt: string;
  conversationCount: number;
  knowledgeItemCount: number;
  auditLogCount: number;
}

export default function UsersAdminPage() {
  const [allowedEmails, setAllowedEmails] = useState<AllowedEmail[]>([]);
  const [users, setUsers] = useState<UserStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"SUPER_USER" | "ADMIN">("SUPER_USER");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setAllowedEmails(data.allowedEmails);
        setUsers(data.users);
      } else if (res.status === 403) {
        setMessage({ type: "error", text: "Admin access required" });
      }
    } catch (error) {
      setMessage({ type: "error", text: "Failed to load data" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;

    setAdding(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail.trim(), role: newRole }),
      });

      if (res.ok) {
        setMessage({ type: "success", text: `Added ${newEmail}` });
        setNewEmail("");
        loadData();
      } else {
        const error = await res.json();
        setMessage({ type: "error", text: error.error });
      }
    } catch (error) {
      setMessage({ type: "error", text: "Failed to add email" });
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveEmail = async (email: string) => {
    if (!confirm(`Remove ${email} from allowed list?`)) return;

    try {
      const res = await fetch(`/api/admin/users?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setMessage({ type: "success", text: `Removed ${email}` });
        loadData();
      } else {
        const error = await res.json();
        setMessage({ type: "error", text: error.error });
      }
    } catch (error) {
      setMessage({ type: "error", text: "Failed to remove email" });
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">User Management</h1>
              <p className="text-slate-600 mt-1">Manage super users who can access the Sean app directly</p>
            </div>
            <Link href="/chat" className="text-blue-600 hover:text-blue-700 font-medium">
              ← Back to Chat
            </Link>
          </div>
        </div>
      </div>

      {/* Message Toast */}
      {message && (
        <div className={`fixed top-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${
          message.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white"
        }`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-4 font-bold">×</button>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4 py-8">
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 gap-8">
            {/* Allowed Emails */}
            <div>
              <h2 className="text-xl font-semibold text-slate-900 mb-4">Allowed Emails</h2>

              {/* Add new email form */}
              <form onSubmit={handleAddEmail} className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm"
                  />
                  <select
                    value={newRole}
                    onChange={e => setNewRole(e.target.value as "SUPER_USER" | "ADMIN")}
                    className="px-3 py-2 border border-slate-300 rounded-lg text-sm"
                    title="Select user role"
                  >
                    <option value="SUPER_USER">Super User (Full Sean App Access)</option>
                    <option value="ADMIN">Admin (API Access Only)</option>
                  </select>
                  <button
                    type="submit"
                    disabled={adding || !newEmail.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm"
                  >
                    {adding ? "Adding..." : "Add"}
                  </button>
                </div>
              </form>

              {/* Email list */}
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Email</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Role</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {allowedEmails.map(item => (
                      <tr key={item.email}>
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-slate-900">{item.email}</div>
                          {item.addedBy && (
                            <div className="text-xs text-slate-500">Added by {item.addedBy}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            item.role === "SUPER_USER"
                              ? "bg-red-100 text-red-800"
                              : item.role === "ADMIN"
                              ? "bg-purple-100 text-purple-800"
                              : "bg-slate-100 text-slate-800"
                          }`}>
                            {item.role}
                          </span>
                          {item.isCore && (
                            <span className="ml-2 px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                              Core
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!item.isCore && (
                            <button
                              onClick={() => handleRemoveEmail(item.email)}
                              className="text-red-600 hover:text-red-700 text-sm"
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* User Stats */}
            <div>
              <h2 className="text-xl font-semibold text-slate-900 mb-4">Active Users</h2>
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">User</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Chats</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">KB Items</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-slate-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {users.map(u => (
                      <tr key={u.id}>
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-slate-900">{u.email}</div>
                          <div className="text-xs text-slate-500">
                            Joined {new Date(u.createdAt).toLocaleDateString()}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">
                          {u.conversationCount}
                        </td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">
                          {u.knowledgeItemCount}
                        </td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">
                          {u.auditLogCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
