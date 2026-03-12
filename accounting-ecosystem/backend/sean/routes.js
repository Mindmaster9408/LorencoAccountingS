/**
 * ============================================================================
 * SEAN AI — Express API Routes
 * ============================================================================
 * REST endpoints for the SEAN AI module. All routes are prefixed with
 * /api/sean and protected by authenticateToken + requireModule('sean').
 *
 * Endpoints:
 *   POST   /suggest         — Get allocation/question suggestion
 *   POST   /learn           — Learn from user correction
 *   POST   /chat            — General SEAN chat (intent classification)
 *   POST   /calculate       — SA tax/VAT calculations
 *   GET    /categories      — List allocation categories
 *   GET    /stats           — SEAN usage statistics
 *   GET    /codex           — List company codex entries
 *   POST   /codex/teach     — Teach SEAN new knowledge
 *   GET    /codex/search    — Search knowledge base
 *   GET    /transactions    — List bank transactions
 *   POST   /transactions    — Add bank transaction(s)
 *   PATCH  /transactions/:id — Update transaction allocation
 * ============================================================================
 */

const express = require('express');
const router = express.Router();

const SeanDecisionEngine = require('./decision-engine');
const SeanEncryption = require('./encryption');
const { ALLOCATION_CATEGORIES, suggestCategoryLocal, getAlternativeSuggestions, normalizeDescription } = require('./allocations');
const { processCalculation, parseCalculationRequest, formatZAR } = require('./calculations');
const { parseTeachMessage } = require('./knowledge-base');

// ─── Data Store ─────────────────────────────────────────────────────────────

const { supabaseSeanStore } = require('./supabase-store');
const dataStore = supabaseSeanStore;

// ─── Helper: Get Engine for Request ──────────────────────────────────────────

function getEngine(req) {
  const companyId = req.companyId || req.user?.companyId || 1;
  const key = process.env.SEAN_DEFAULT_KEY || SeanEncryption.generateCompanyKey(String(companyId));
  return new SeanDecisionEngine(companyId, key, dataStore);
}

function getCompanyId(req) {
  return req.companyId || req.user?.companyId || 1;
}

// ─── POST /suggest — Get Allocation Suggestion ──────────────────────────────

router.post('/suggest', async (req, res) => {
  try {
    const { description, amount, type, merchant } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'description is required' });
    }

    const engine = getEngine(req);
    const context = {
      type: 'allocation',
      description: description,
      amount: amount || 0,
      transactionType: type || (amount < 0 ? 'debit' : 'credit'),
      merchant: merchant || description,
      question: null
    };

    const decision = await engine.makeDecision(context);

    // Add alternative suggestions for low confidence
    let alternatives = [];
    if (decision.confidence < 80) {
      alternatives = getAlternativeSuggestions(description, amount);
    }

    res.json({
      suggestion: decision.suggestion,
      confidence: decision.confidence,
      method: decision.method,
      reasoning: decision.reasoning,
      citations: decision.citations || [],
      alternatives: alternatives,
      requiresConfirmation: decision.confidence < 80,
      meta: {
        pipeline: decision.pipeline || [],
        processingTime: decision.processingTime
      }
    });
  } catch (err) {
    console.error('SEAN /suggest error:', err.message);
    res.status(500).json({ error: 'Failed to generate suggestion' });
  }
});

// ─── POST /learn — Learn from User Correction ──────────────────────────────

router.post('/learn', async (req, res) => {
  try {
    const { description, amount, category, merchant, wasCorrect, originalSuggestion } = req.body;

    if (!description || !category) {
      return res.status(400).json({ error: 'description and category are required' });
    }

    const engine = getEngine(req);
    const context = {
      type: 'allocation',
      description,
      amount: amount || 0,
      merchant: merchant || description
    };

    const userDecision = {
      category,
      originalSuggestion: originalSuggestion || null
    };

    await engine.learn(context, userDecision, wasCorrect !== false);

    res.json({
      success: true,
      message: `Learned: "${normalizeDescription(description)}" → ${category}`,
      note: 'SEAN will remember this for future transactions'
    });
  } catch (err) {
    console.error('SEAN /learn error:', err.message);
    res.status(500).json({ error: 'Failed to learn from correction' });
  }
});

// ─── POST /chat — General SEAN Chat ─────────────────────────────────────────

router.post('/chat', async (req, res) => {
  try {
    const { message, conversationContext } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const engine = getEngine(req);

    // Classify intent first
    const intent = engine.classifyIntent({ question: message, description: message });

    let context;
    switch (intent) {
      case 'CALCULATION':
        context = { type: 'question', question: message };
        break;
      case 'TEACH':
        context = { type: 'teach', question: message };
        break;
      case 'ALLOCATION':
        context = { type: 'allocation', description: message, amount: 0, merchant: message };
        break;
      default:
        context = { type: 'question', question: message };
    }

    const decision = await engine.makeDecision(context);

    // Build a human-readable answer string from the decision
    let answer;
    const sugg = decision.suggestion;
    if (typeof sugg === 'string' && sugg) {
      answer = sugg;
    } else if (sugg && typeof sugg === 'object') {
      // Format calculation result objects into readable text
      const fmt = (n) => typeof n === 'number' ? `R ${n.toFixed(2)}` : n;
      if (sugg.paye !== undefined) {
        // PAYE / income tax result
        answer = `PAYE: ${fmt(sugg.paye)}\nAnnual Tax: ${fmt(sugg.annualTax)}\nMonthly Tax: ${fmt(sugg.monthlyTax ?? sugg.paye)}\nUIF: ${fmt(sugg.uif ?? sugg.employeeUIF)}\nNet Pay: ${fmt(sugg.netPay ?? sugg.monthlyNet)}`;
      } else if (sugg.vat !== undefined && sugg.including !== undefined) {
        // VAT result
        answer = `Excl. VAT: ${fmt(sugg.excluding)}\nVAT (15%): ${fmt(sugg.vat)}\nIncl. VAT: ${fmt(sugg.including)}`;
      } else if (sugg.vatBack !== undefined) {
        // VAT back-calculation
        answer = `Incl. VAT: ${fmt(sugg.including)}\nVAT portion: ${fmt(sugg.vatBack ?? sugg.vat)}\nExcl. VAT: ${fmt(sugg.excluding)}`;
      } else {
        // Generic object — render as key: value lines
        answer = Object.entries(sugg)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => `${k.replace(/_/g,' ')}: ${typeof v === 'number' ? fmt(v) : v}`)
          .join('\n');
      }
    } else {
      answer = decision.reasoning || 'I\'m not sure about that. Can you teach me?';
    }

    res.json({
      intent,
      answer,
      rawResult: typeof sugg === 'object' ? sugg : null,
      confidence: decision.confidence,
      method: decision.method,
      citations: decision.citations || [],
      requiresAction: intent === 'TEACH' || (intent === 'ALLOCATION' && decision.confidence < 80),
      meta: {
        pipeline: decision.pipeline || [],
        detectedType: context.type
      }
    });
  } catch (err) {
    console.error('SEAN /chat error:', err.message);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// ─── POST /calculate — SA Tax/VAT Calculations ─────────────────────────────

router.post('/calculate', async (req, res) => {
  try {
    const { query, type, amount, params } = req.body;

    // If a natural language query is provided, parse it
    if (query) {
      const parsed = parseCalculationRequest(query);
      if (parsed) {
        const result = processCalculation(parsed);
        return res.json({
          success: true,
          query,
          parsed,
          result,
          formatted: typeof result === 'number' ? formatZAR(result) : result
        });
      }
      return res.status(400).json({ error: 'Could not parse calculation request', hint: 'Try: "VAT on R1000 excl" or "PAYE salary R25000 30 years old"' });
    }

    // Structured calculation
    if (type && amount !== undefined) {
      const parsed = { type, amount, ...params };
      const result = processCalculation(parsed);
      return res.json({
        success: true,
        type,
        amount,
        result,
        formatted: typeof result === 'number' ? formatZAR(result) : result
      });
    }

    res.status(400).json({ error: 'Provide query (natural language) or type + amount' });
  } catch (err) {
    console.error('SEAN /calculate error:', err.message);
    res.status(500).json({ error: 'Calculation failed' });
  }
});

// ─── GET /categories — List Allocation Categories ───────────────────────────

router.get('/categories', (req, res) => {
  const categories = ALLOCATION_CATEGORIES.map(cat => ({
    code: cat.code,
    label: cat.label,
    taxCategory: cat.taxCategory,
    vatClaimable: cat.vatClaimable,
    description: cat.description || null
  }));

  res.json({
    count: categories.length,
    categories
  });
});

// ─── GET /stats — SEAN Usage Statistics ─────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const stats = dataStore.getSeanStats(companyId);

    res.json({
      companyId,
      ...stats,
      version: '1.0.0',
      mode: 'live'
    });
  } catch (err) {
    console.error('SEAN /stats error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

// ─── GET /codex — List Company Codex Entries ────────────────────────────────

router.get('/codex', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const items = dataStore.getKnowledgeItems(companyId);

    res.json({
      count: items.length,
      items: items.map(item => ({
        id: item.id,
        title: item.title,
        domain: item.domain,
        layer: item.layer,
        contentType: item.content_type,
        citationId: item.citation_id,
        status: item.status,
        tags: item.tags || [],
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }))
    });
  } catch (err) {
    console.error('SEAN /codex error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve codex entries' });
  }
});

// ─── POST /codex/teach — Teach SEAN New Knowledge ───────────────────────────

router.post('/codex/teach', async (req, res) => {
  try {
    const { message, domain, title } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required. Format: "LEER: ..." or "TEACH: ..." or "SAVE TO CODEX: ..."' });
    }

    const companyId = getCompanyId(req);
    const engine = getEngine(req);

    // Use the teach handler
    const context = { type: 'teach', question: message };
    const decision = await engine.makeDecision(context);

    if (decision.method === 'codex_teach' || decision.method === 'teach') {
      res.json({
        success: true,
        message: decision.suggestion || 'Knowledge saved to codex',
        citation: decision.citations?.[0] || null,
        meta: {
          domain: domain || decision.domain || 'OTHER',
          method: decision.method
        }
      });
    } else {
      res.json({
        success: false,
        message: 'Could not parse as teach command. Use format: "LEER: [title] | [content]" or "TEACH: [knowledge]"',
        hint: decision.reasoning
      });
    }
  } catch (err) {
    console.error('SEAN /codex/teach error:', err.message);
    res.status(500).json({ error: 'Failed to teach SEAN' });
  }
});

// ─── GET /codex/search — Search Knowledge Base ──────────────────────────────

router.get('/codex/search', async (req, res) => {
  try {
    const { q, domain } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'q (query) parameter is required' });
    }

    const companyId = getCompanyId(req);
    const results = dataStore.searchKnowledgeItems(q, domain);

    res.json({
      query: q,
      domain: domain || 'all',
      count: results.length,
      items: results.map(item => ({
        id: item.id,
        title: item.title,
        domain: item.domain,
        contentType: item.content_type,
        citationId: item.citation_id,
        tags: item.tags || []
      }))
    });
  } catch (err) {
    console.error('SEAN /codex/search error:', err.message);
    res.status(500).json({ error: 'Failed to search knowledge base' });
  }
});

// ─── GET /transactions — List Bank Transactions ─────────────────────────────

router.get('/transactions', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { unallocated, category, limit } = req.query;

    const filters = {};
    if (unallocated === 'true') filters.unallocated = true;
    if (category) filters.category = category;

    let txns = dataStore.getBankTransactions(companyId, filters);
    if (limit) txns = txns.slice(0, parseInt(limit));

    res.json({
      count: txns.length,
      transactions: txns.map(t => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amount: t.amount,
        type: t.type,
        merchant: t.merchant,
        suggestedCategory: t.suggested_category,
        confirmedCategory: t.confirmed_category,
        confidence: t.confidence,
        matchType: t.match_type,
        allocatedBy: t.allocated_by
      }))
    });
  } catch (err) {
    console.error('SEAN /transactions error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

// ─── POST /transactions — Add Bank Transaction(s) ──────────────────────────

router.post('/transactions', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const transactions = Array.isArray(req.body) ? req.body : [req.body];
    const engine = getEngine(req);

    const results = [];

    for (const txn of transactions) {
      if (!txn.description || txn.amount === undefined) {
        results.push({ error: 'description and amount are required', input: txn });
        continue;
      }

      // Auto-suggest category for each transaction
      const context = {
        type: 'allocation',
        description: txn.description,
        amount: txn.amount,
        merchant: txn.merchant || txn.description,
        transactionType: txn.type || (txn.amount < 0 ? 'debit' : 'credit')
      };

      const decision = await engine.makeDecision(context);

      const saved = dataStore.addBankTransaction({
        company_id: companyId,
        date: txn.date || new Date().toISOString().split('T')[0],
        description: txn.description,
        amount: txn.amount,
        type: txn.type || (txn.amount < 0 ? 'debit' : 'credit'),
        merchant: txn.merchant || null,
        suggested_category: decision.suggestion?.category || decision.suggestion || null,
        confirmed_category: decision.confidence >= 95 ? (decision.suggestion?.category || decision.suggestion) : null,
        confidence: decision.confidence,
        match_type: decision.method,
        allocated_by: decision.confidence >= 95 ? 'sean' : null
      });

      results.push({
        id: saved.id,
        description: txn.description,
        amount: txn.amount,
        suggestedCategory: decision.suggestion?.category || decision.suggestion,
        confidence: decision.confidence,
        autoAllocated: decision.confidence >= 95,
        reasoning: decision.reasoning,
        method: decision.method
      });
    }

    res.json({
      processed: results.length,
      autoAllocated: results.filter(r => r.autoAllocated).length,
      needsReview: results.filter(r => !r.autoAllocated && !r.error).length,
      results
    });
  } catch (err) {
    console.error('SEAN /transactions error:', err.message);
    res.status(500).json({ error: 'Failed to process transactions' });
  }
});

// ─── PATCH /transactions/:id — Update Transaction Allocation ────────────────

router.patch('/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category, learn } = req.body;
    const companyId = getCompanyId(req);

    if (!category) {
      return res.status(400).json({ error: 'category is required' });
    }

    const txn = dataStore.updateBankTransaction(parseInt(id), companyId, {
      confirmed_category: category,
      allocated_by: 'user'
    });

    if (!txn) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Optionally learn from this correction
    if (learn !== false) {
      const engine = getEngine(req);
      const wasCorrect = txn.suggested_category === category;
      await engine.learn(
        { type: 'allocation', description: txn.description, amount: txn.amount, merchant: txn.merchant },
        { category, originalSuggestion: txn.suggested_category },
        wasCorrect
      );
    }

    res.json({
      success: true,
      transaction: {
        id: txn.id,
        description: txn.description,
        confirmedCategory: txn.confirmed_category,
        learned: learn !== false
      }
    });
  } catch (err) {
    console.error('SEAN /transactions/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// ─── GET /learning-log — View Learning History ──────────────────────────────

router.get('/learning-log', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const limit = parseInt(req.query.limit) || 50;
    const logs = dataStore.getLearningLog(companyId, limit);

    res.json({
      count: logs.length,
      logs: logs.map(l => ({
        id: l.id,
        type: l.interaction_type,
        input: l.input_context,
        response: l.response_given,
        wasCorrect: l.was_correct,
        createdAt: l.created_at
      }))
    });
  } catch (err) {
    console.error('SEAN /learning-log error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve learning log' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL CASH BOOK IMPORTER ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const UniversalImporter = require('./universal-importer/index');

// Multer config — store in memory for processing, limit to 20MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExt = ['.xlsx', '.xls', '.csv', '.xlsm', '.xlsb'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowedExt.join(', ')}`));
    }
  }
});

// ─── POST /import/upload — Upload & Import Cash Book ────────────────────────

router.post('/import/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Send as multipart/form-data with field name "file".' });
    }

    const companyId = getCompanyId(req);
    const engine = getEngine(req);
    const options = {
      companyId,
      decisionEngine: engine,
      dataStore,
      autoConfirmThreshold: parseInt(req.body.threshold) || 85,
      extractVAT: req.body.extractVAT !== 'false',
      createJournals: req.body.createJournals !== 'false',
      checkDuplicates: req.body.checkDuplicates !== 'false'
    };

    const importer = new UniversalImporter(options);
    const result = await importer.import(req.file.buffer, req.file.originalname);

    const statusCode = result.success ? 200 : 422;
    res.status(statusCode).json(result);
  } catch (err) {
    console.error('SEAN /import/upload error:', err.message);
    if (err.message.includes('Unsupported file type')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ─── POST /import/preview — Preview file without importing ──────────────────

router.post('/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const companyId = getCompanyId(req);
    const importer = new UniversalImporter({ companyId, dataStore });
    const preview = await importer.preview(req.file.buffer, req.file.originalname);

    res.json(preview);
  } catch (err) {
    console.error('SEAN /import/preview error:', err.message);
    res.status(500).json({ error: 'Preview failed: ' + err.message });
  }
});

// ─── POST /import/confirm — Confirm user allocations for review items ───────

router.post('/import/confirm', async (req, res) => {
  try {
    const { importId, transactions } = req.body;

    if (!importId || !transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'importId and transactions array required' });
    }

    const companyId = getCompanyId(req);
    const engine = getEngine(req);
    const importer = new UniversalImporter({
      companyId,
      decisionEngine: engine,
      dataStore,
      extractVAT: true,
      createJournals: true
    });

    const result = await importer.confirmAllocations(importId, transactions);
    res.json(result);
  } catch (err) {
    console.error('SEAN /import/confirm error:', err.message);
    res.status(500).json({ error: 'Confirmation failed: ' + err.message });
  }
});

// ─── GET /import/history — Import history ───────────────────────────────────

router.get('/import/history', async (req, res) => {
  try {
    const companyId = getCompanyId(req);

    if (dataStore && dataStore.getImportLogs) {
      const logs = dataStore.getImportLogs(companyId);
      res.json({ count: logs.length, imports: logs });
    } else {
      res.json({ count: 0, imports: [] });
    }
  } catch (err) {
    console.error('SEAN /import/history error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve import history' });
  }
});

// ─── GET /import/:importId — Get specific import details ────────────────────

router.get('/import/:importId', async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { importId } = req.params;

    if (dataStore && dataStore.getImportLog) {
      const log = dataStore.getImportLog(companyId, importId);
      if (!log) {
        return res.status(404).json({ error: 'Import not found' });
      }

      // Get transactions from this import
      const allTxns = dataStore.getBankTransactions(companyId);
      const importTxns = allTxns.filter(t => t.import_id === importId);

      res.json({
        import: log,
        transactions: importTxns.map(t => ({
          id: t.id,
          date: t.date,
          description: t.description,
          amount: t.amount,
          type: t.type,
          suggestedCategory: t.suggested_category,
          confirmedCategory: t.confirmed_category,
          confidence: t.confidence,
          allocatedBy: t.allocated_by
        }))
      });
    } else {
      res.status(404).json({ error: 'Import not found' });
    }
  } catch (err) {
    console.error('SEAN /import/:importId error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve import details' });
  }
});

// ─── Mount Paytime IRP5 Learning Routes ─────────────────────────────────────
// All routes prefixed with /paytime (so full path: /api/sean/paytime/...)
const irp5Routes = require('./irp5-routes');
router.use('/paytime', irp5Routes);

module.exports = router;
