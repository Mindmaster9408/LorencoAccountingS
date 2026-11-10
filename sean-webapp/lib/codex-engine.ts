// lib/codex-engine.ts
// Codex Rules Engine - Apply structured codex rules to questions and transactions
import prisma from "./db";

// ==============================================================================
// TYPES
// ==============================================================================

// Tax Rule structure (from codex_pack format)
export interface TaxRule {
  section: string;
  type: string;
  law_says: string;
  interpretation: string;
  application_logic: string;
}

export interface TaxRuleCodex {
  codex_pack: string;
  jurisdiction: string;
  authority: string;
  rules: TaxRule[];
}

// VAT Cross-Reference structure
export interface VATRule {
  scenario: string;
  vat_act: string;
  income_tax_interaction: string;
  sean_instruction: string;
}

export interface VATCrossReference {
  vat_cross_reference: {
    principle: string;
    rules: VATRule[];
  };
}

// Decision Engine structure
export interface DecisionStep {
  step: number;
  action: string;
  details: string;
}

export interface DecisionEngine {
  role: string;
  mandatory_decision_order: DecisionStep[];
  output_requirements: string[];
  forbidden_behaviour: string[];
}

// Lookup Table structure
export interface LookupEntry {
  key: string;
  value: string;
  notes?: string;
}

export interface LookupTable {
  lookup_table: {
    name: string;
    description: string;
    entries: LookupEntry[];
  };
}

// Parsed Codex Item
export interface ParsedCodexItem {
  id: number; // KnowledgeItem.id is Int (sean_knowledge_items.id) — see 2026-08-31 SEVCO migration
  citationId: string;
  title: string;
  type: "tax_rule" | "vat_cross_reference" | "decision_engine" | "lookup_table" | "general";
  content: TaxRuleCodex | VATCrossReference | DecisionEngine | LookupTable | Record<string, unknown>;
  primaryDomain: string;
  layer: string;
}

// ==============================================================================
// PARSING CODEX ITEMS
// ==============================================================================

/**
 * Parse a codex item's contentText and determine its type
 */
export function parseCodexItem(item: {
  id: number;
  citationId: string | null;
  title: string;
  contentText: string | null;
  primaryDomain: string;
  layer: string;
}): ParsedCodexItem | null {
  // contentText/citationId are nullable columns on the shared sean_knowledge_items
  // table (legacy rows from the pre-sean-webapp codex pipeline may have neither) —
  // nothing to parse and no citation to attach without both.
  if (!item.contentText || !item.citationId) return null;
  try {
    const content = JSON.parse(item.contentText);
    let type: ParsedCodexItem["type"] = "general";

    // Detect type based on structure
    if (content.codex_pack && content.rules && Array.isArray(content.rules)) {
      type = "tax_rule";
    } else if (content.vat_cross_reference && content.vat_cross_reference.rules) {
      type = "vat_cross_reference";
    } else if (content.mandatory_decision_order && content.output_requirements) {
      type = "decision_engine";
    } else if (content.lookup_table && content.lookup_table.entries) {
      type = "lookup_table";
    }

    return {
      id: item.id,
      citationId: item.citationId,
      title: item.title,
      type,
      content,
      primaryDomain: item.primaryDomain,
      layer: item.layer,
    };
  } catch {
    // Not JSON - treat as plain text
    return null;
  }
}

// ==============================================================================
// QUERYING CODEX
// ==============================================================================

/**
 * Get all structured codex items for a specific domain
 */
export async function getCodexItemsByDomain(
  domain: string,
  types?: ParsedCodexItem["type"][]
): Promise<ParsedCodexItem[]> {
  const items = await prisma.knowledgeItem.findMany({
    where: {
      status: "APPROVED",
      OR: [
        { primaryDomain: domain },
        { primaryDomain: "OTHER" },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const parsed: ParsedCodexItem[] = [];
  for (const item of items) {
    const p = parseCodexItem(item);
    if (p && (!types || types.includes(p.type))) {
      parsed.push(p);
    }
  }

  return parsed;
}

/**
 * Search codex items by keywords
 */
export async function searchCodexItems(
  keywords: string[],
  domain?: string
): Promise<ParsedCodexItem[]> {
  const where: {
    status: string;
    OR?: Array<{ primaryDomain: string }>;
    primaryDomain?: string;
  } = { status: "APPROVED" };

  if (domain) {
    where.OR = [
      { primaryDomain: domain },
      { primaryDomain: "OTHER" },
    ];
  }

  const items = await prisma.knowledgeItem.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const parsed: ParsedCodexItem[] = [];
  const normalizedKeywords = keywords.map(k => k.toLowerCase());

  for (const item of items) {
    const searchText = `${item.title} ${item.contentText}`.toLowerCase();
    const matchCount = normalizedKeywords.filter(k => searchText.includes(k)).length;

    if (matchCount > 0) {
      const p = parseCodexItem(item);
      if (p) {
        parsed.push(p);
      }
    }
  }

  return parsed;
}

// ==============================================================================
// APPLYING TAX RULES
// ==============================================================================

export interface TaxRuleMatch {
  rule: TaxRule;
  codexPack: string;
  jurisdiction: string;
  authority: string;
  citationId: string;
  matchScore: number;
}

/**
 * Find applicable tax rules for a question
 */
export async function findApplicableTaxRules(
  question: string,
  domain: string
): Promise<TaxRuleMatch[]> {
  const codexItems = await getCodexItemsByDomain(domain, ["tax_rule"]);
  const matches: TaxRuleMatch[] = [];
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  for (const item of codexItems) {
    const taxCodex = item.content as TaxRuleCodex;

    for (const rule of taxCodex.rules) {
      // Score based on keyword matches in law_says, interpretation, application_logic
      const ruleText = `${rule.section} ${rule.type} ${rule.law_says} ${rule.interpretation} ${rule.application_logic}`.toLowerCase();
      const matchCount = keywords.filter(k => ruleText.includes(k)).length;
      const score = matchCount / keywords.length;

      if (score >= 0.3) {
        matches.push({
          rule,
          codexPack: taxCodex.codex_pack,
          jurisdiction: taxCodex.jurisdiction,
          authority: taxCodex.authority,
          citationId: item.citationId,
          matchScore: score,
        });
      }
    }
  }

  // Sort by match score
  return matches.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);
}

/**
 * Format tax rules for inclusion in AI response
 */
export function formatTaxRulesContext(matches: TaxRuleMatch[]): string {
  if (matches.length === 0) return "";

  let context = "📜 **Applicable Tax Rules:**\n\n";

  for (const match of matches) {
    context += `**${match.codexPack} - ${match.rule.section}** (${match.rule.type})\n`;
    context += `*Authority: ${match.authority}, ${match.jurisdiction}*\n\n`;
    context += `**The Law Says:** ${match.rule.law_says}\n\n`;
    context += `**Interpretation:** ${match.rule.interpretation}\n\n`;
    context += `**Application:** ${match.rule.application_logic}\n\n`;
    context += `📚 *[${match.citationId}]*\n\n---\n\n`;
  }

  return context;
}

// ==============================================================================
// APPLYING VAT CROSS-REFERENCE
// ==============================================================================

export interface VATRuleMatch {
  rule: VATRule;
  principle: string;
  citationId: string;
  matchScore: number;
}

/**
 * Find applicable VAT rules for a question
 */
export async function findApplicableVATRules(
  question: string
): Promise<VATRuleMatch[]> {
  const codexItems = await getCodexItemsByDomain("VAT", ["vat_cross_reference"]);
  const matches: VATRuleMatch[] = [];
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  for (const item of codexItems) {
    const vatCodex = item.content as VATCrossReference;

    for (const rule of vatCodex.vat_cross_reference.rules) {
      // Score based on keyword matches
      const ruleText = `${rule.scenario} ${rule.vat_act} ${rule.income_tax_interaction} ${rule.sean_instruction}`.toLowerCase();
      const matchCount = keywords.filter(k => ruleText.includes(k)).length;
      const score = matchCount / keywords.length;

      if (score >= 0.3) {
        matches.push({
          rule,
          principle: vatCodex.vat_cross_reference.principle,
          citationId: item.citationId,
          matchScore: score,
        });
      }
    }
  }

  return matches.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);
}

/**
 * Format VAT rules for inclusion in AI response
 */
export function formatVATRulesContext(matches: VATRuleMatch[]): string {
  if (matches.length === 0) return "";

  let context = "📊 **VAT Cross-Reference:**\n\n";

  for (const match of matches) {
    context += `**Scenario:** ${match.rule.scenario}\n`;
    context += `**VAT Act:** ${match.rule.vat_act}\n`;
    context += `**Income Tax Interaction:** ${match.rule.income_tax_interaction}\n`;
    context += `**Sean's Instruction:** ${match.rule.sean_instruction}\n\n`;
    context += `📚 *[${match.citationId}]*\n\n---\n\n`;
  }

  return context;
}

// ==============================================================================
// APPLYING DECISION ENGINES
// ==============================================================================

export interface DecisionEngineMatch {
  engine: DecisionEngine;
  citationId: string;
  title: string;
  matchScore: number;
}

/**
 * Find applicable decision engines for a task
 */
export async function findApplicableDecisionEngines(
  question: string,
  domain?: string
): Promise<DecisionEngineMatch[]> {
  const codexItems = await searchCodexItems(
    question.split(/\s+/).filter(w => w.length > 2),
    domain
  );

  const engines: DecisionEngineMatch[] = [];
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  for (const item of codexItems) {
    if (item.type !== "decision_engine") continue;

    const engine = item.content as DecisionEngine;
    const engineText = `${engine.role} ${engine.mandatory_decision_order.map(s => s.action).join(" ")}`.toLowerCase();
    const matchCount = keywords.filter(k => engineText.includes(k)).length;
    const score = matchCount / keywords.length;

    if (score >= 0.2) {
      engines.push({
        engine,
        citationId: item.citationId,
        title: item.title,
        matchScore: score,
      });
    }
  }

  return engines.sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);
}

/**
 * Format decision engine steps for AI guidance
 */
export function formatDecisionEngineContext(matches: DecisionEngineMatch[]): string {
  if (matches.length === 0) return "";

  let context = "🎯 **Decision Framework:**\n\n";

  for (const match of matches) {
    context += `**${match.engine.role}**\n\n`;
    context += "**Mandatory Steps:**\n";
    for (const step of match.engine.mandatory_decision_order) {
      context += `${step.step}. **${step.action}**: ${step.details}\n`;
    }
    context += "\n**Output Requirements:**\n";
    for (const req of match.engine.output_requirements) {
      context += `- ${req}\n`;
    }
    if (match.engine.forbidden_behaviour.length > 0) {
      context += "\n**Forbidden:**\n";
      for (const fb of match.engine.forbidden_behaviour) {
        context += `- ❌ ${fb}\n`;
      }
    }
    context += `\n📚 *[${match.citationId}]*\n\n---\n\n`;
  }

  return context;
}

// ==============================================================================
// LOOKUP TABLES
// ==============================================================================

export interface LookupMatch {
  key: string;
  value: string;
  notes?: string;
  tableName: string;
  citationId: string;
}

/**
 * Search lookup tables for a specific key
 */
export async function searchLookupTables(
  searchKey: string
): Promise<LookupMatch[]> {
  const codexItems = await getCodexItemsByDomain("OTHER", ["lookup_table"]);
  const matches: LookupMatch[] = [];
  const normalizedKey = searchKey.toLowerCase();

  for (const item of codexItems) {
    const lookup = item.content as LookupTable;

    for (const entry of lookup.lookup_table.entries) {
      if (entry.key.toLowerCase().includes(normalizedKey) ||
          entry.value.toLowerCase().includes(normalizedKey)) {
        matches.push({
          key: entry.key,
          value: entry.value,
          notes: entry.notes,
          tableName: lookup.lookup_table.name,
          citationId: item.citationId,
        });
      }
    }
  }

  return matches;
}

// ==============================================================================
// DEDUCTIBILITY CHECKER
// ==============================================================================

export interface DeductibilityResult {
  isDeductible: boolean;
  percentage: number;
  reason: string;
  conditions: string[];
  citations: string[];
  vatImplication?: string;
}

/**
 * Check if an expense is deductible based on Codex rules
 */
export async function checkDeductibility(
  expenseType: string,
  expenseDescription: string,
  businessContext?: string
): Promise<DeductibilityResult | null> {
  // Find relevant tax rules for income tax deductions
  const taxRules = await findApplicableTaxRules(
    `${expenseType} ${expenseDescription} deductible expense section 11`,
    "INCOME_TAX"
  );

  // Find relevant VAT rules
  const vatRules = await findApplicableVATRules(
    `${expenseType} input tax claim`
  );

  if (taxRules.length === 0) {
    return null; // No relevant rules found
  }

  // Analyze the most relevant rule
  const topRule = taxRules[0];
  const applicationLogic = topRule.rule.application_logic.toLowerCase();

  // Determine deductibility from application logic
  let isDeductible = true;
  let percentage = 100;
  const conditions: string[] = [];
  const citations: string[] = [topRule.citationId];

  // Check for common restrictions
  if (applicationLogic.includes("not deductible") || applicationLogic.includes("prohibited")) {
    isDeductible = false;
    percentage = 0;
  } else if (applicationLogic.includes("limited") || applicationLogic.includes("partial")) {
    // Check for percentage limits
    const percentMatch = applicationLogic.match(/(\d+)%/);
    if (percentMatch) {
      percentage = parseInt(percentMatch[1]);
    } else {
      percentage = 50; // Default partial deduction
    }
  }

  // Extract conditions
  if (applicationLogic.includes("if ") || applicationLogic.includes("provided ")) {
    conditions.push(topRule.rule.interpretation);
  }

  // Check VAT implications
  let vatImplication: string | undefined;
  if (vatRules.length > 0) {
    vatImplication = vatRules[0].rule.sean_instruction;
    citations.push(vatRules[0].citationId);
  }

  return {
    isDeductible,
    percentage,
    reason: topRule.rule.interpretation,
    conditions,
    citations,
    vatImplication,
  };
}

// ==============================================================================
// MAIN CODEX QUERY FUNCTION
// ==============================================================================

export interface CodexQueryResult {
  taxRules: TaxRuleMatch[];
  vatRules: VATRuleMatch[];
  decisionEngines: DecisionEngineMatch[];
  formattedContext: string;
  hasCodifiedKnowledge: boolean;
}

/**
 * Query all codex sources for a question
 */
export async function queryCodex(
  question: string,
  domain: string
): Promise<CodexQueryResult> {
  // Run all queries in parallel
  const [taxRules, vatRules, decisionEngines] = await Promise.all([
    findApplicableTaxRules(question, domain),
    domain === "VAT" ? findApplicableVATRules(question) : Promise.resolve([]),
    findApplicableDecisionEngines(question, domain),
  ]);

  // Build formatted context
  let formattedContext = "";

  if (decisionEngines.length > 0) {
    formattedContext += formatDecisionEngineContext(decisionEngines);
  }

  if (taxRules.length > 0) {
    formattedContext += formatTaxRulesContext(taxRules);
  }

  if (vatRules.length > 0) {
    formattedContext += formatVATRulesContext(vatRules);
  }

  const hasCodifiedKnowledge = taxRules.length > 0 || vatRules.length > 0 || decisionEngines.length > 0;

  return {
    taxRules,
    vatRules,
    decisionEngines,
    formattedContext,
    hasCodifiedKnowledge,
  };
}
