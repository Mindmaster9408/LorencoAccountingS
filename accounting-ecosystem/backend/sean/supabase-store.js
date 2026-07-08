/**
 * ============================================================================
 * SEAN AI — Supabase Data Store
 * ============================================================================
 * Production data store for SEAN using Supabase/PostgreSQL.
 * Implements the same interface as the former mock store so the decision
 * engine and routes are completely database-agnostic.
 * ============================================================================
 */

const { supabase } = require('../config/database');

const supabaseSeanStore = {

  // ── Codex (encrypted private entries) ──

  async getCodexEntry(companyId, contextHash) {
    const { data } = await supabase
      .from('sean_codex_entries')
      .select('*')
      .eq('company_id', companyId)
      .eq('context_hash', contextHash)
      .single();
    return data || null;
  },

  async updateCodexUsage(entryId) {
    await supabase
      .from('sean_codex_entries')
      .update({
        times_used: supabase.rpc ? undefined : 1, // fallback
        last_used: new Date().toISOString()
      })
      .eq('id', entryId);
    // Increment times_used via raw update
    await supabase.rpc('increment_codex_usage', { entry_id: entryId }).catch(() => {
      // If RPC not available, do a manual read+write
      supabase.from('sean_codex_entries').select('times_used').eq('id', entryId).single()
        .then(({ data }) => {
          if (data) {
            supabase.from('sean_codex_entries')
              .update({ times_used: (data.times_used || 0) + 1, last_used: new Date().toISOString() })
              .eq('id', entryId);
          }
        });
    });
  },

  async updateCodexEntry(entryId, updates) {
    await supabase
      .from('sean_codex_entries')
      .update(updates)
      .eq('id', entryId);
  },

  async createCodexEntry(data) {
    const { data: entry, error } = await supabase
      .from('sean_codex_entries')
      .insert({ ...data, created_at: new Date().toISOString() })
      .select()
      .single();
    if (error) {
      console.error('createCodexEntry error:', error.message);
      return { id: null, ...data };
    }
    return entry;
  },

  async getCodexStats(companyId) {
    const { data: entries } = await supabase
      .from('sean_codex_entries')
      .select('times_used, confidence')
      .eq('company_id', companyId);
    const list = entries || [];
    return {
      totalEntries: list.length,
      totalUsages: list.reduce((sum, e) => sum + (e.times_used || 0), 0),
      avgConfidence: list.length > 0
        ? Math.round(list.reduce((sum, e) => sum + (e.confidence || 0), 0) / list.length)
        : 0
    };
  },

  // ── Global Patterns ──

  async getGlobalPatterns(merchant, amountRange) {
    const { data: patterns } = await supabase
      .from('sean_global_patterns')
      .select('*')
      .order('confidence_score', { ascending: false });

    if (!patterns) return [];

    const merchantLower = (merchant || '').toLowerCase();
    return patterns.filter(p => {
      const pats = (p.merchant_pattern || '').split('|').map(s => s.toLowerCase().trim());
      const merchantMatch = pats.some(pat => merchantLower.includes(pat) || pat.includes(merchantLower));
      const rangeMatch = p.amount_range === 'any' || p.amount_range === amountRange;
      return merchantMatch && rangeMatch;
    });
  },

  async upsertGlobalPattern(patternKey, data) {
    const { data: existing } = await supabase
      .from('sean_global_patterns')
      .select('*')
      .eq('pattern_key', patternKey)
      .single();

    if (existing) {
      const dist = existing.outcome_distribution || {};
      dist[data.outcome] = (dist[data.outcome] || 0) + 1;
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      for (const key in dist) {
        dist[key] = Math.round((dist[key] / total) * 100);
      }
      await supabase
        .from('sean_global_patterns')
        .update({
          outcome_distribution: dist,
          total_occurrences: (existing.total_occurrences || 0) + 1,
          last_updated: new Date().toISOString()
        })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('sean_global_patterns')
        .insert({
          pattern_type: data.pattern_type,
          pattern_key: patternKey,
          amount_range: data.amount_range,
          merchant_pattern: data.merchant_pattern,
          companies_contributed: 1,
          total_occurrences: 1,
          outcome_distribution: { [data.outcome]: 100 },
          confidence_score: 50,
          reasoning: 'Pattern learned from user allocations',
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString()
        });
    }
  },

  // ── Knowledge Items ──

  async getKnowledgeItems(companyId) {
    const { data } = await supabase
      .from('sean_knowledge_items')
      .select('*')
      .eq('status', 'APPROVED')
      .or(`company_id.is.null,company_id.eq.${companyId}`);
    return data || [];
  },

  async addKnowledgeItem(data) {
    const item = {
      ...data,
      citation_id: data.citation_id || `KB:${data.layer}:${Date.now()}:v1`,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const { data: inserted, error } = await supabase
      .from('sean_knowledge_items')
      .insert(item)
      .select()
      .single();
    if (error) {
      console.error('addKnowledgeItem error:', error.message);
      return { id: null, ...item };
    }
    return inserted;
  },

  async searchKnowledgeItems(query, domain) {
    let q = supabase
      .from('sean_knowledge_items')
      .select('*')
      .eq('status', 'APPROVED');

    if (domain) {
      q = q.or(`domain.eq.${domain},domain.eq.OTHER`);
    }

    const { data: items } = await q;
    if (!items) return [];

    // Client-side keyword filtering (same logic as before)
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return items
      .filter(item => {
        const text = `${item.title} ${typeof item.content === 'string' ? item.content : JSON.stringify(item.content)}`.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      })
      .sort((a, b) => {
        const textA = `${a.title} ${typeof a.content === 'string' ? a.content : ''}`.toLowerCase();
        const textB = `${b.title} ${typeof b.content === 'string' ? b.content : ''}`.toLowerCase();
        const scoreA = keywords.filter(kw => textA.includes(kw)).length;
        const scoreB = keywords.filter(kw => textB.includes(kw)).length;
        return scoreB - scoreA;
      });
  },

  // ── Allocation Rules ──

  async getAllocationRules(companyId) {
    const { data } = await supabase
      .from('sean_allocation_rules')
      .select('*')
      .or(`is_global.eq.true,company_id.eq.${companyId}`);
    return data || [];
  },

  async upsertAllocationRule(companyId, normalizedPattern, category) {
    const catValue = typeof category === 'string' ? category : category.category || category;

    const { data: existing } = await supabase
      .from('sean_allocation_rules')
      .select('*')
      .eq('company_id', companyId)
      .eq('normalized_pattern', normalizedPattern)
      .single();

    if (existing) {
      await supabase
        .from('sean_allocation_rules')
        .update({
          category: catValue,
          learned_from_count: (existing.learned_from_count || 0) + 1,
          confidence: Math.min(0.99, (existing.confidence || 0.8) + 0.02),
          last_matched: new Date().toISOString()
        })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('sean_allocation_rules')
        .insert({
          company_id: companyId,
          is_global: false,
          normalized_pattern: normalizedPattern,
          category: catValue,
          confidence: 0.80,
          learned_from_count: 1,
          last_matched: new Date().toISOString(),
          created_at: new Date().toISOString()
        });
    }
  },

  // ── Bank Transactions ──

  async getBankTransactions(companyId, filters = {}) {
    let q = supabase
      .from('sean_bank_transactions')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: false });

    if (filters.unallocated) {
      q = q.is('confirmed_category', null);
    }
    if (filters.category) {
      q = q.eq('confirmed_category', filters.category);
    }

    const { data } = await q;
    return data || [];
  },

  async addBankTransaction(data) {
    const { data: txn, error } = await supabase
      .from('sean_bank_transactions')
      .insert({ ...data, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) {
      console.error('addBankTransaction error:', error.message);
      return { id: null, ...data };
    }
    return txn;
  },

  async updateBankTransaction(id, companyId, updates) {
    const { data: txn, error } = await supabase
      .from('sean_bank_transactions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single();
    if (error) {
      console.error('updateBankTransaction error:', error.message);
      return null;
    }
    return txn;
  },

  // ── Learning Log ──

  async addLearningLog(data) {
    const { data: log, error } = await supabase
      .from('sean_learning_log')
      .insert({ ...data, created_at: new Date().toISOString() })
      .select()
      .single();
    if (error) {
      console.error('addLearningLog error:', error.message);
      return { id: null, ...data };
    }
    return log;
  },

  async getLearningLog(companyId, limit = 50) {
    const { data } = await supabase
      .from('sean_learning_log')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data || [];
  },

  // ── Stats ──

  async getSeanStats(companyId) {
    // Run queries in parallel for performance
    const [codexRes, rulesRes, txnsRes, logsRes, knowledgeRes, patternsRes, importsRes] = await Promise.all([
      supabase.from('sean_codex_entries').select('times_used, confidence').eq('company_id', companyId),
      supabase.from('sean_allocation_rules').select('id, is_global, company_id'),
      supabase.from('sean_bank_transactions').select('confirmed_category, allocated_by').eq('company_id', companyId),
      supabase.from('sean_learning_log').select('id').eq('company_id', companyId),
      supabase.from('sean_knowledge_items').select('id, company_id').or(`company_id.is.null,company_id.eq.${companyId}`),
      supabase.from('sean_global_patterns').select('id'),
      supabase.from('sean_import_logs').select('id, status').eq('company_id', companyId),
    ]);

    const codexEntries = codexRes.data || [];
    const allRules = rulesRes.data || [];
    const txns = txnsRes.data || [];
    const logs = logsRes.data || [];
    const knowledge = knowledgeRes.data || [];
    const patterns = patternsRes.data || [];
    const imports = importsRes.data || [];

    const companyRules = allRules.filter(r => r.company_id === companyId && !r.is_global);
    const globalRules = allRules.filter(r => r.is_global);
    const allocated = txns.filter(t => t.confirmed_category);
    const autoAllocated = txns.filter(t => t.allocated_by === 'sean');
    const unallocated = txns.filter(t => !t.confirmed_category);

    return {
      codex: {
        totalEntries: codexEntries.length,
        totalUsages: codexEntries.reduce((s, e) => s + (e.times_used || 0), 0),
        avgConfidence: codexEntries.length > 0
          ? Math.round(codexEntries.reduce((s, e) => s + (e.confidence || 0), 0) / codexEntries.length)
          : 0
      },
      rules: {
        companyRules: companyRules.length,
        globalRules: globalRules.length
      },
      transactions: {
        total: txns.length,
        allocated: allocated.length,
        autoAllocated: autoAllocated.length,
        unallocated: unallocated.length,
        allocationRate: txns.length > 0 ? Math.round((allocated.length / txns.length) * 100) : 0
      },
      knowledgeBase: {
        totalItems: knowledge.length,
        globalItems: knowledge.filter(i => i.company_id === null).length,
        companyItems: knowledge.filter(i => i.company_id === companyId).length
      },
      globalPatterns: patterns.length,
      learningEvents: logs.length,
      imports: {
        total: imports.length,
        completed: imports.filter(l => l.status === 'completed').length
      }
    };
  },

  // ── Import Logs ──

  async addImportLog(data) {
    const { data: log, error } = await supabase
      .from('sean_import_logs')
      .insert({ ...data, created_at: new Date().toISOString() })
      .select()
      .single();
    if (error) {
      console.error('addImportLog error:', error.message);
      return { id: null, ...data };
    }
    return log;
  },

  async getImportLogs(companyId) {
    const { data } = await supabase
      .from('sean_import_logs')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    return data || [];
  },

  async getImportLog(companyId, importId) {
    const { data } = await supabase
      .from('sean_import_logs')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_id', importId)
      .single();
    return data || null;
  },

  // ── Inter-Company Invoices ──

  async addInterCompanyInvoice(data) {
    const { data: inv, error } = await supabase
      .from('inter_company_invoices')
      .insert({ ...data, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) {
      console.error('addInterCompanyInvoice error:', error.message);
      return { id: null, ...data };
    }
    return inv;
  },

  async getInterCompanyInvoices(companyId, direction = 'all') {
    let q = supabase.from('inter_company_invoices').select('*');

    if (direction === 'sent') {
      q = q.eq('sender_company_id', companyId);
    } else if (direction === 'received') {
      q = q.eq('receiver_company_id', companyId);
    } else {
      q = q.or(`sender_company_id.eq.${companyId},receiver_company_id.eq.${companyId}`);
    }

    const { data } = await q.order('created_at', { ascending: false });
    return data || [];
  },

  async getInterCompanyInvoice(invoiceId) {
    const { data } = await supabase
      .from('inter_company_invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();
    return data || null;
  },

  async updateInterCompanyInvoice(invoiceId, updates) {
    const { data: inv } = await supabase
      .from('inter_company_invoices')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .select()
      .single();
    return inv || null;
  },

  // ── Inter-Company Relationships ──

  async addRelationship(data) {
    const { data: rel, error } = await supabase
      .from('inter_company_relationships')
      .insert({ ...data, status: data.status || 'active', created_at: new Date().toISOString() })
      .select()
      .single();
    if (error) {
      console.error('addRelationship error:', error.message);
      return { id: null, ...data };
    }
    return rel;
  },

  async getRelationships(companyId) {
    const { data } = await supabase
      .from('inter_company_relationships')
      .select('*')
      .eq('status', 'active')
      .or(`company_a_id.eq.${companyId},company_b_id.eq.${companyId}`);
    return data || [];
  },

  async findRelationship(companyAId, companyBId) {
    const { data } = await supabase
      .from('inter_company_relationships')
      .select('*')
      .or(
        `and(company_a_id.eq.${companyAId},company_b_id.eq.${companyBId}),` +
        `and(company_a_id.eq.${companyBId},company_b_id.eq.${companyAId})`
      )
      .limit(1)
      .single();
    return data || null;
  },

  // getRelationships() above only returns status='active' rows — correct for
  // its original invoice-sync use, but it means a still-pending relationship
  // is invisible to both sides. getAllRelationships() returns every status
  // (pending/active/revoked) so callers that need to show pending/revoked
  // state (Workstream 78 supplier/customer company linking) can do so.
  async getAllRelationships(companyId) {
    const { data } = await supabase
      .from('inter_company_relationships')
      .select('*')
      .or(`company_a_id.eq.${companyId},company_b_id.eq.${companyId}`);
    return data || [];
  },

  async getRelationshipById(relationshipId) {
    const { data } = await supabase
      .from('inter_company_relationships')
      .select('*')
      .eq('id', relationshipId)
      .single();
    return data || null;
  },

  async updateRelationship(relationshipId, updates) {
    const { data, error } = await supabase
      .from('inter_company_relationships')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', relationshipId)
      .select()
      .single();
    if (error) {
      console.error('updateRelationship error:', error.message);
      return null;
    }
    return data;
  }
};

module.exports = { supabaseSeanStore };
