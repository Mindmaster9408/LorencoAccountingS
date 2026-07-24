"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLanguage } from "@/app/providers";
import { t } from "@/lib/i18n";

interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  clientId?: string | null;
}

interface ClientOption {
  id: string;
  name: string;
  ecoCompanyId?: string | null;
}

interface Message {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export default function ChatPage() {
  const router = useRouter();
  const { language, setLanguage } = useLanguage();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [renameModal, setRenameModal] = useState<{ conversationId: string; newTitle: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [debugMode, setDebugMode] = useState(false);
  const [lastReasonDebug, setLastReasonDebug] = useState<Record<string, unknown> | null>(null);
  const [lastActions, setLastActions] = useState<Record<string, unknown>[]>([]);
  const [approvedActionIds, setApprovedActionIds] = useState<Set<string>>(new Set());
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientUpdating, setClientUpdating] = useState(false);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
        if (data.length > 0 && !currentConversation) {
          setCurrentConversation(data[0]);
        }
      }
    } catch (error) {
      console.error("Failed to load conversations:", error);
    }
  }, [currentConversation]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    fetch("/api/clients")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ClientOption[]) => setClients(data))
      .catch((error) => console.error("Failed to load clients:", error));
  }, []);

  useEffect(() => {
    if (currentConversation) {
      loadMessages(currentConversation.id);
    }
  }, [currentConversation]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const loadMessages = async (conversationId: string) => {
    try {
      const res = await fetch(`/api/chat/messages?conversationId=${conversationId}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (error) {
      console.error("Failed to load messages:", error);
    }
  };

  const createNewConversation = async () => {
    try {
      const res = await fetch("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Conversation" }),
      });
      if (res.ok) {
        const data = await res.json();
        setConversations([data, ...conversations]);
        setCurrentConversation(data);
      }
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !currentConversation || loading) return;

    setLoading(true);
    const userMessage = input;
    setInput("");
    setApprovedActionIds(new Set()); // Clear approved actions on new message

    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentConversation.id,
          content: userMessage,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setMessages([
          ...messages,
          data.userMessage,
          data.assistantMessage,
        ]);

        // Store metadata from response (now includes bootstrap info)
        if (data.metadata) {
          console.log("RESPONSE_METADATA", data.metadata);

          // Set debug info if available and debug mode is on
          if (debugMode && data.metadata) {
            setLastReasonDebug(data.metadata);
          } else {
            setLastReasonDebug(null);
          }
        }

        // Only call reason endpoint for ASK: prefixed messages (optional enhancement)
        // The main processing is now done in /api/chat/messages
        if (userMessage.toUpperCase().startsWith("ASK:")) {
          try {
            const reasonRes = await fetch("/api/reason", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                question: userMessage.substring(4).trim(),
                clientId: null,
                layer: null,
              }),
            });

            if (reasonRes.ok) {
              const reasonData = await reasonRes.json();
              setLastActions(reasonData.actions || []);
              if (debugMode) {
                setLastReasonDebug(reasonData.debug || null);
              }
              console.log("REASON_RESPONSE", reasonData);
            }
          } catch (reasonError) {
            console.error("Reason call failed:", reasonError);
          }
        } else {
          // Clear actions for non-ASK messages
          setLastActions([]);
        }
      }
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setLoading(false);
    }
  };

  const approveAction = async (action: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/actions/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: action.id,
          action,
          conversationId: currentConversation?.id,
          reasonContext: lastReasonDebug,
        }),
      });

      if (res.ok) {
        setApprovedActionIds(new Set([...approvedActionIds, String(action.id || "")]));
        console.log("Action approved:", action.id);
      } else {
        const error = await res.json();
        console.error("Approve failed:", error);
      }
    } catch (error) {
      console.error("Approve action error:", error);
    }
  };

  const rejectAction = async (action: Record<string, unknown>, note?: string) => {
    try {
      const res = await fetch("/api/actions/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: action.id,
          action,
          conversationId: currentConversation?.id,
          note,
          reasonContext: lastReasonDebug,
        }),
      });

      if (res.ok) {
        setApprovedActionIds(new Set([...approvedActionIds, String(action.id || "")])); // Disable buttons after reject too
        console.log("Action rejected:", action.id);
      } else {
        const error = await res.json();
        console.error("Reject failed:", error);
      }
    } catch (error) {
      console.error("Reject action error:", error);
    }
  };

  const renameConversation = async (conversationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const conv = conversations.find(c => c.id === conversationId);
    if (conv) {
      setRenameModal({ conversationId, newTitle: conv.title });
    }
  };

  const submitRename = async () => {
    if (!renameModal || !renameModal.newTitle.trim()) return;

    try {
      const res = await fetch("/api/chat/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: renameModal.conversationId,
          title: renameModal.newTitle,
        }),
      });

      if (res.ok) {
        const updated = await res.json();
        setConversations(conversations.map(c => c.id === updated.id ? updated : c));
        if (currentConversation?.id === updated.id) {
          setCurrentConversation(updated);
        }
        setRenameModal(null);
      } else {
        alert("Failed to rename conversation");
      }
    } catch (error) {
      console.error("Rename error:", error);
      alert("Failed to rename conversation");
    }
  };

  const deleteConversation = async (conversationId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this conversation?")) return;

    try {
      const res = await fetch(`/api/chat/conversations?id=${conversationId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        const newConversations = conversations.filter((c) => c.id !== conversationId);
        setConversations(newConversations);

        if (currentConversation?.id === conversationId) {
          if (newConversations.length > 0) {
            setCurrentConversation(newConversations[0]);
          } else {
            setCurrentConversation(null);
            setMessages([]);
          }
        }
      } else {
        const error = await res.json();
        console.error("Delete failed:", error);
        alert(`Failed to delete: ${error.error}`);
      }
    } catch (error) {
      console.error("Delete conversation error:", error);
      alert("Failed to delete conversation");
    }
  };

  const changeConversationClient = async (clientId: string) => {
    if (!currentConversation) return;
    setClientUpdating(true);
    try {
      const res = await fetch("/api/chat/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentConversation.id,
          clientId, // "" clears the link — the API stores that as null
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setConversations(conversations.map((c) => (c.id === updated.id ? updated : c)));
        setCurrentConversation(updated);
      } else {
        alert("Failed to link client to this conversation");
      }
    } catch (error) {
      console.error("Failed to update conversation client:", error);
      alert("Failed to link client to this conversation");
    } finally {
      setClientUpdating(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <div className="flex h-screen bg-slate-50">
      {/* Sidebar */}
      <div className="w-64 bg-slate-900 text-white flex flex-col border-r border-slate-700">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-xl font-bold">{t("sean.title", language)}</h1>
          <p className="text-xs text-slate-400">{t("sean.subtitle", language)}</p>
        </div>

        <button
          onClick={createNewConversation}
          className="m-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
        >
          + {t("action.new", language)}
        </button>

        <div className="flex-1 overflow-y-auto px-2 space-y-2">
          {conversations.map((conv) => (
            <div key={conv.id} className="group flex gap-2 items-start">
              <button
                onClick={() => setCurrentConversation(conv)}
                className={`flex-1 text-left px-3 py-2 rounded-lg transition ${
                  currentConversation?.id === conv.id
                    ? "bg-blue-600 text-white"
                    : "text-slate-300 hover:bg-slate-700"
                }`}
              >
                <div className="truncate text-sm">{conv.title}</div>
                <div className="text-xs text-slate-400">
                  {new Date(conv.createdAt).toLocaleDateString()}
                </div>
              </button>
              <div className="flex gap-1 mt-2">
                <button
                  onClick={(e) => renameConversation(conv.id, e)}
                  className="px-2 py-1 text-blue-400 hover:bg-blue-600 hover:text-white rounded opacity-0 group-hover:opacity-100 transition text-xs"
                  title="Rename conversation"
                >
                  
                </button>
                <button
                  onClick={(e) => deleteConversation(conv.id, e)}
                  className="px-2 py-1 text-red-400 hover:bg-red-600 hover:text-white rounded opacity-0 group-hover:opacity-100 transition text-xs"
                  title="Delete conversation"
                >
                  
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-700 p-4 space-y-2">
          <div className="mb-3">
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Debug Mode
            </label>
            <button
              onClick={() => setDebugMode(!debugMode)}
              className={`w-full px-3 py-2 rounded-lg transition text-sm font-medium ${
                debugMode
                  ? "bg-orange-600 text-white hover:bg-orange-700"
                  : "bg-slate-700 text-slate-300 hover:bg-slate-600"
              }`}
            >
              {debugMode ? "ON" : "OFF"}
            </button>
          </div>
          <div className="mb-3">
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Language
            </label>
            <select
              id="language-select"
              title="Select language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full px-2 py-1 bg-slate-800 border border-slate-600 text-white rounded text-sm"
              aria-label="Language"
            >
              <option value="EN">English</option>
              <option value="AF">Afrikaans</option>
            </select>
          </div>
          <Link href="/dashboard" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            📊 Dashboard
          </Link>
          <Link href="/codex" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            📚 {t("chat.codex", language)}
          </Link>
          <Link href="/allocations" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            🏦 Bank Allocations
          </Link>
          <Link href="/admin/agent" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            🤖 Sean Agent Control
          </Link>
          <Link href="/admin/clients" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            🏢 Company Management
          </Link>
          <Link href="/admin/users" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            👥 User Management
          </Link>
          <Link href="/admin/audit" className="block px-3 py-2 rounded-lg hover:bg-slate-700 transition text-sm">
            📋 Audit Logs
          </Link>
          <button
            onClick={handleLogout}
            className="w-full px-3 py-2 text-left rounded-lg hover:bg-red-600 transition text-sm"
          >
            🚪 {t("action.logout", language)}
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {currentConversation ? (
          <>
            {/* Client context bar — links this conversation to a client, and
                grounds Sean's answers in that client's live accounting data
                when it's linked to an accounting-ecosystem company. */}
            <div className="flex items-center gap-3 px-6 py-2 border-b border-slate-200 bg-white">
              <label htmlFor="conversation-client-select" className="text-xs font-medium text-slate-500">
                Client:
              </label>
              <select
                id="conversation-client-select"
                value={currentConversation.clientId || ""}
                onChange={(e) => changeConversationClient(e.target.value)}
                disabled={clientUpdating}
                className="text-sm border border-slate-300 rounded-lg px-2 py-1 text-slate-900"
              >
                <option value="">No client linked</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {currentConversation.clientId && (() => {
                const linked = clients.find((c) => c.id === currentConversation.clientId);
                if (!linked) return null;
                return linked.ecoCompanyId ? (
                  <span className="text-xs px-2 py-1 bg-green-100 text-green-800 rounded-full">
                    🏢 {linked.name} — live data
                  </span>
                ) : (
                  <span className="text-xs px-2 py-1 bg-amber-100 text-amber-800 rounded-full">
                    {linked.name} — no accounting link (set one in Company Management)
                  </span>
                );
              })()}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500">
                  <div className="text-center">
                    <p className="text-lg font-semibold mb-2">{t("chat.empty", language)}</p>
                    <p className="text-sm">
                      {t("chat.emptyHint", language)}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div className="flex flex-col gap-1">
                        <div
                          className={`max-w-md px-4 py-2 rounded-lg ${
                            msg.role === "user"
                              ? "bg-blue-600 text-white rounded-br-none"
                              : "bg-slate-200 text-slate-900 rounded-bl-none"
                          }`}
                        >
                          {msg.content}
                        </div>
                        <div className={`text-xs ${msg.role === "user" ? "text-right" : "text-left"} text-slate-500`}>
                          {new Date(msg.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Actions Panel */}
                  {lastActions && lastActions.length > 0 && (
                    <div className="mt-6 pt-4 border-t border-slate-300 bg-blue-50 rounded-lg p-4">
                      <div className="text-sm font-semibold text-slate-800 mb-3">Proposed Actions</div>
                      <div className="space-y-2">
                        {lastActions.map((action) => {
                          const actionId = String(action.id || "");
                          const actionTitle = String(action.title || "Unknown");
                          const actionSummary = String(action.summary || "");
                          const actionConfidence = typeof action.confidence === "number" ? action.confidence : null;
                          const requiresApproval = Boolean(action.requiresApproval);
                          return (
                            <div
                              key={actionId}
                              className="bg-white border border-blue-200 rounded-lg p-3 flex items-start gap-3"
                            >
                              <div className="flex-1">
                                <div className="font-medium text-slate-900 text-sm">{actionTitle}</div>
                                <div className="text-xs text-slate-600 mt-1">{actionSummary}</div>
                                {actionConfidence !== null && (
                                  <div className="text-xs text-slate-500 mt-1">
                                    Confidence: {(actionConfidence * 100).toFixed(0)}%
                                  </div>
                                )}
                              </div>
                              {requiresApproval && !approvedActionIds.has(actionId) && (
                              <div className="flex gap-2 flex-shrink-0">
                                <button
                                  onClick={() => approveAction(action)}
                                  className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 transition"
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={() => rejectAction(action)}
                                  className="px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition"
                                >
                                  Reject
                                </button>
                              </div>
                            )}
                            {approvedActionIds.has(actionId) && (
                              <div className="text-xs text-slate-500 flex-shrink-0">
                                Processed
                              </div>
                            )}
                          </div>
                        );
                        })})
                      </div>
                    </div>
                  )}

                  {/* Debug Panel */}
                  {debugMode && lastReasonDebug && (
                    <div className="mt-4 bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-x-auto">
                      <details className="cursor-pointer">
                        <summary className="font-semibold mb-2 text-gray-300">Debug Info</summary>
                        <pre className="whitespace-pre-wrap break-words text-xs">
                          {JSON.stringify(lastReasonDebug, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={sendMessage} className="border-t border-slate-200 p-4 bg-white">
              <div className="flex gap-2">
                <input
                  id="message-input"
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t("chat.placeholder", language)}
                  title="Type your message here"
                  className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                  aria-label="Message input"
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {loading ? "..." : t("action.send", language)}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-slate-500 mb-4">No conversations yet</p>
              <button
                onClick={createNewConversation}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Create a new conversation
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Rename Modal */}
      {renameModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-lg">
            <h2 className="text-lg font-bold mb-4 text-slate-900">Rename Conversation</h2>
            <input
              id="rename-input"
              type="text"
              value={renameModal.newTitle}
              onChange={(e) => setRenameModal({ ...renameModal, newTitle: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") setRenameModal(null);
              }}
              title="Enter new conversation name"
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 text-slate-900"
              autoFocus
              aria-label="Conversation name"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRenameModal(null)}
                className="px-4 py-2 text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={submitRename}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
