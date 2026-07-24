"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";

// SA Business Types
const BUSINESS_TYPES = [
  { code: "PTY_LTD", label: "(Pty) Ltd - Private Company" },
  { code: "CC", label: "CC - Close Corporation" },
  { code: "SOLE_PROP", label: "Sole Proprietor" },
  { code: "TRUST", label: "Trust" },
  { code: "NPC", label: "NPC - Non-Profit Company" },
  { code: "PARTNERSHIP", label: "Partnership" },
  { code: "COOP", label: "Co-operative" },
  { code: "INC", label: "Incorporated Company" },
];

// Privacy levels
const PRIVACY_LEVELS = [
  { code: "STRICT", label: "Strict - No data sharing", description: "Company data is never used for industry learning" },
  { code: "INDUSTRY_LEARNING", label: "Industry Learning", description: "Anonymized patterns contribute to industry knowledge" },
];

interface Industry {
  id: string;
  code: string;
  name: string;
}

interface Client {
  id: string;
  name: string;
  code: string;
  description?: string;
  isActive: boolean;
  industryId?: string;
  industry?: Industry;
  businessType?: string;
  vatRegistered: boolean;
  vatNumber?: string;
  companyRegNumber?: string;
  businessDescription?: string;
  mainProducts?: string;
  mainServices?: string;
  mainExpenseTypes?: string;
  mainIncomeTypes?: string;
  financialYearEnd?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  dataIsolationLevel: string;
  defaultMinConfidence: number;
  autoAllocateEnabled: boolean;
  ecoCompanyId?: string;
}

export default function ClientProfilePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const router = useRouter();
  const [client, setClient] = useState<Client | null>(null);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Form state
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    industryId: "",
    businessType: "",
    vatRegistered: false,
    vatNumber: "",
    companyRegNumber: "",
    businessDescription: "",
    mainProducts: [] as string[],
    mainServices: [] as string[],
    mainExpenseTypes: [] as string[],
    mainIncomeTypes: [] as string[],
    financialYearEnd: "",
    contactPerson: "",
    contactEmail: "",
    contactPhone: "",
    dataIsolationLevel: "STRICT",
    defaultMinConfidence: 0.8,
    autoAllocateEnabled: true,
    ecoCompanyId: "",
  });

  // Temp inputs for array fields
  const [newProduct, setNewProduct] = useState("");
  const [newService, setNewService] = useState("");
  const [newExpense, setNewExpense] = useState("");
  const [newIncome, setNewIncome] = useState("");

  useEffect(() => {
    fetchData();
  }, [clientId]);

  const fetchData = async () => {
    try {
      const [clientRes, industriesRes] = await Promise.all([
        fetch(`/api/clients?industry=true`),
        fetch("/api/industries"),
      ]);

      if (clientRes.ok) {
        const clients = await clientRes.json();
        const found = clients.find((c: Client) => c.id === clientId);
        if (found) {
          setClient(found);
          setFormData({
            name: found.name || "",
            description: found.description || "",
            industryId: found.industryId || "",
            businessType: found.businessType || "",
            vatRegistered: found.vatRegistered || false,
            vatNumber: found.vatNumber || "",
            companyRegNumber: found.companyRegNumber || "",
            businessDescription: found.businessDescription || "",
            mainProducts: found.mainProducts ? JSON.parse(found.mainProducts) : [],
            mainServices: found.mainServices ? JSON.parse(found.mainServices) : [],
            mainExpenseTypes: found.mainExpenseTypes ? JSON.parse(found.mainExpenseTypes) : [],
            mainIncomeTypes: found.mainIncomeTypes ? JSON.parse(found.mainIncomeTypes) : [],
            financialYearEnd: found.financialYearEnd || "",
            contactPerson: found.contactPerson || "",
            contactEmail: found.contactEmail || "",
            contactPhone: found.contactPhone || "",
            dataIsolationLevel: found.dataIsolationLevel || "STRICT",
            defaultMinConfidence: found.defaultMinConfidence || 0.8,
            autoAllocateEnabled: found.autoAllocateEnabled !== false,
            ecoCompanyId: found.ecoCompanyId || "",
          });
        }
      }

      if (industriesRes.ok) {
        const data = await industriesRes.json();
        setIndustries(data.all || []);
      }
    } catch (err) {
      setError("Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: clientId,
          ...formData,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      setSuccess("Company profile saved successfully!");
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const addToArray = (field: "mainProducts" | "mainServices" | "mainExpenseTypes" | "mainIncomeTypes", value: string) => {
    if (!value.trim()) return;
    setFormData((prev) => ({
      ...prev,
      [field]: [...prev[field], value.trim()],
    }));
  };

  const removeFromArray = (field: "mainProducts" | "mainServices" | "mainExpenseTypes" | "mainIncomeTypes", index: number) => {
    setFormData((prev) => ({
      ...prev,
      [field]: prev[field].filter((_, i) => i !== index),
    }));
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">Loading company profile...</div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="p-8">
        <div className="text-red-600">Company not found</div>
        <button onClick={() => router.back()} className="mt-4 text-blue-600 hover:underline">
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-700 mb-2">
              &larr; Back to Clients
            </button>
            <h1 className="text-2xl font-bold text-gray-800">Company Profile: {client.name}</h1>
            <p className="text-gray-500">Code: {client.code}</p>
          </div>
          <div className={`px-3 py-1 rounded-full text-sm ${client.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
            {client.isActive ? "Active" : "Inactive"}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">{error}</div>
        )}
        {success && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg">{success}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800">Basic Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Business Type</label>
                <select
                  value={formData.businessType}
                  onChange={(e) => setFormData({ ...formData, businessType: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                >
                  <option value="">Select type...</option>
                  {BUSINESS_TYPES.map((bt) => (
                    <option key={bt.code} value={bt.code}>{bt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Industry</label>
                <select
                  value={formData.industryId}
                  onChange={(e) => setFormData({ ...formData, industryId: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                >
                  <option value="">Select industry...</option>
                  {industries.map((ind) => (
                    <option key={ind.id} value={ind.id}>{ind.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Reg Number</label>
                <input
                  type="text"
                  value={formData.companyRegNumber}
                  onChange={(e) => setFormData({ ...formData, companyRegNumber: e.target.value })}
                  placeholder="e.g., 2020/123456/07"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Accounting Ecosystem Company ID</label>
                <input
                  type="text"
                  value={formData.ecoCompanyId}
                  onChange={(e) => setFormData({ ...formData, ecoCompanyId: e.target.value })}
                  placeholder="e.g., 2"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Links this client to its company record in the accounting-ecosystem app.
                  When set, Sean chat conversations for this client are grounded in its live
                  trial balance / bank / VAT data.
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.vatRegistered}
                    onChange={(e) => setFormData({ ...formData, vatRegistered: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-gray-700">VAT Registered</span>
                </label>
              </div>
              {formData.vatRegistered && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">VAT Number</label>
                  <input
                    type="text"
                    value={formData.vatNumber}
                    onChange={(e) => setFormData({ ...formData, vatNumber: e.target.value })}
                    placeholder="e.g., 4123456789"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Financial Year End</label>
                <select
                  value={formData.financialYearEnd}
                  onChange={(e) => setFormData({ ...formData, financialYearEnd: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                >
                  <option value="">Select month...</option>
                  {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* About the Business - Teach Sean */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-2 text-gray-800">Teach Sean About This Company</h2>
            <p className="text-sm text-gray-500 mb-4">This information helps Sean understand the business and make better allocation suggestions.</p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">What does this company do?</label>
                <textarea
                  value={formData.businessDescription}
                  onChange={(e) => setFormData({ ...formData, businessDescription: e.target.value })}
                  placeholder="Describe the company's main business activities..."
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
              </div>

              {/* Products */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Main Products (if any)</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newProduct}
                    onChange={(e) => setNewProduct(e.target.value)}
                    placeholder="Add a product..."
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                    onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addToArray("mainProducts", newProduct), setNewProduct(""))}
                  />
                  <button
                    type="button"
                    onClick={() => { addToArray("mainProducts", newProduct); setNewProduct(""); }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.mainProducts.map((p, i) => (
                    <span key={i} className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm flex items-center gap-2">
                      {p}
                      <button type="button" onClick={() => removeFromArray("mainProducts", i)} className="text-blue-600 hover:text-blue-800">&times;</button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Services */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Main Services (if any)</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newService}
                    onChange={(e) => setNewService(e.target.value)}
                    placeholder="Add a service..."
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                    onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addToArray("mainServices", newService), setNewService(""))}
                  />
                  <button
                    type="button"
                    onClick={() => { addToArray("mainServices", newService); setNewService(""); }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.mainServices.map((s, i) => (
                    <span key={i} className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm flex items-center gap-2">
                      {s}
                      <button type="button" onClick={() => removeFromArray("mainServices", i)} className="text-green-600 hover:text-green-800">&times;</button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Expected Expenses */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Expected Expense Types</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newExpense}
                    onChange={(e) => setNewExpense(e.target.value)}
                    placeholder="e.g., Raw materials, Fuel, Software subscriptions..."
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                    onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addToArray("mainExpenseTypes", newExpense), setNewExpense(""))}
                  />
                  <button
                    type="button"
                    onClick={() => { addToArray("mainExpenseTypes", newExpense); setNewExpense(""); }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.mainExpenseTypes.map((e, i) => (
                    <span key={i} className="px-3 py-1 bg-orange-100 text-orange-800 rounded-full text-sm flex items-center gap-2">
                      {e}
                      <button type="button" onClick={() => removeFromArray("mainExpenseTypes", i)} className="text-orange-600 hover:text-orange-800">&times;</button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Expected Income */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Expected Income Types</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newIncome}
                    onChange={(e) => setNewIncome(e.target.value)}
                    placeholder="e.g., Product sales, Service fees, Rental income..."
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                    onKeyPress={(e) => e.key === "Enter" && (e.preventDefault(), addToArray("mainIncomeTypes", newIncome), setNewIncome(""))}
                  />
                  <button
                    type="button"
                    onClick={() => { addToArray("mainIncomeTypes", newIncome); setNewIncome(""); }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.mainIncomeTypes.map((inc, i) => (
                    <span key={i} className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-sm flex items-center gap-2">
                      {inc}
                      <button type="button" onClick={() => removeFromArray("mainIncomeTypes", i)} className="text-purple-600 hover:text-purple-800">&times;</button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Contact Info */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800">Contact Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contact Person</label>
                <input
                  type="text"
                  value={formData.contactPerson}
                  onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.contactEmail}
                  onChange={(e) => setFormData({ ...formData, contactEmail: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="tel"
                  value={formData.contactPhone}
                  onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-gray-900"
                />
              </div>
            </div>
          </div>

          {/* Privacy & Sean Settings */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800">Privacy & Sean Agent Settings</h2>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Data Privacy Level</label>
              <div className="space-y-2">
                {PRIVACY_LEVELS.map((level) => (
                  <label key={level.code} className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="dataIsolationLevel"
                      value={level.code}
                      checked={formData.dataIsolationLevel === level.code}
                      onChange={(e) => setFormData({ ...formData, dataIsolationLevel: e.target.value })}
                      className="mt-1"
                    />
                    <div>
                      <div className="font-medium text-gray-800">{level.label}</div>
                      <div className="text-sm text-gray-500">{level.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Minimum Confidence for Auto-Allocate</label>
                <input
                  type="range"
                  min="0.5"
                  max="0.99"
                  step="0.05"
                  value={formData.defaultMinConfidence}
                  onChange={(e) => setFormData({ ...formData, defaultMinConfidence: parseFloat(e.target.value) })}
                  className="w-full"
                />
                <div className="text-sm text-gray-500 text-center">{Math.round(formData.defaultMinConfidence * 100)}%</div>
              </div>
              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.autoAllocateEnabled}
                    onChange={(e) => setFormData({ ...formData, autoAllocateEnabled: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-gray-700">Enable Auto-Allocation for this company</span>
                </label>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end gap-4">
            <button
              type="button"
              onClick={() => router.back()}
              className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Company Profile"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
