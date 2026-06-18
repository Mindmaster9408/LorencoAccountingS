// lib/bank-allocations.ts
// Bank Transaction Allocation with Learning

import prisma from "./db";
import { getIndustrySuggestion, contributeToIndustryLearning } from "./industry-learning";
import { findApplicableDecisionEngines, findApplicableTaxRules, DecisionEngineMatch } from "./codex-engine";

// Comprehensive SA accounting categories with extensive vendor/keyword matching
export const ALLOCATION_CATEGORIES = [
  {
    code: "BANK_CHARGES",
    label: "Bank Charges",
    keywords: [
      "bank fee", "service fee", "atm", "card fee", "monthly fee", "admin fee",
      "cash handling", "account fee", "cheque fee", "statement fee", "swift",
      "fnb fee", "absa fee", "nedbank fee", "standard bank fee", "capitec fee",
      "card replacement", "debit order fee", "eft fee", "notification fee",
      "overdraft fee", "stop order fee", "unpaid fee", "dishonour fee",
      "withdrawal fee", "enquiry fee", "balance enquiry"
    ]
  },
  {
    code: "TELEPHONE",
    label: "Telephone & Communications",
    keywords: [
      "telkom", "vodacom", "mtn", "cell c", "fibre", "internet", "airtime",
      "rain", "afrihost", "webafrica", "cool ideas", "vox", "rsaweb",
      "neotel", "liquid telecom", "openserve", "herotel", "frogfoot",
      "data bundle", "mobile", "cellular", "telecoms", "broadband", "adsl",
      "vdsl", "lte", "5g", "wifi", "wi-fi", "telephone line", "voip",
      "microsoft teams", "zoom subscription", "skype"
    ]
  },
  {
    code: "ELECTRICITY",
    label: "Electricity & Utilities",
    keywords: [
      "eskom", "city power", "electricity", "prepaid", "municipal",
      "city of johannesburg", "city of cape town", "city of tshwane",
      "ethekwini", "ekurhuleni", "nelson mandela bay", "buffalo city",
      "mangaung", "power", "kwh", "kilowatt", "electric", "utility",
      "smart meter", "meter reading"
    ]
  },
  {
    code: "WATER",
    label: "Water & Rates",
    keywords: [
      "water", "rates", "municipal", "refuse", "sewage", "sanitation",
      "waste removal", "property rates", "assessment rates", "joburg water",
      "rand water", "umgeni water"
    ]
  },
  {
    code: "RENT",
    label: "Rent & Premises",
    keywords: [
      "rent", "lease", "premises", "property", "rental", "tenancy",
      "landlord", "letting", "office space", "warehouse", "storage",
      "parking", "monthly rent", "commercial rent", "industrial rent"
    ]
  },
  {
    code: "SALARIES",
    label: "Salaries & Wages",
    keywords: [
      "salary", "wage", "payroll", "staff", "employee", "nett pay",
      "net salary", "gross salary", "commission", "bonus", "overtime",
      "leave pay", "thirteenth cheque", "13th cheque"
    ]
  },
  {
    code: "PAYE",
    label: "PAYE & Employee Tax",
    keywords: [
      "paye", "pay as you earn", "employee tax", "sars paye", "efiling paye",
      "tax deduction", "income tax deduction"
    ]
  },
  {
    code: "UIF",
    label: "UIF Contributions",
    keywords: [
      "uif", "unemployment insurance", "uif contribution", "labour department",
      "department of labour"
    ]
  },
  {
    code: "SDL",
    label: "Skills Development Levy",
    keywords: [
      "sdl", "skills development", "skills levy", "seta", "training levy"
    ]
  },
  {
    code: "FUEL",
    label: "Fuel & Motor Expenses",
    keywords: [
      "fuel", "petrol", "diesel", "engen", "shell", "bp", "caltex", "sasol",
      "total", "puma energy", "astron", "virgin active fuel", "ez gas",
      "motorist", "garage", "filling station", "service station",
      "car wash", "oil change", "tyre", "tire", "battery", "motor spares",
      "autozone", "midas", "tiger wheel", "supa quick", "hi-q",
      "dunlop", "goodyear", "bridgestone", "vehicle service", "car service",
      "toll", "n1 toll", "n3 toll", "sanral", "etoll", "e-toll"
    ]
  },
  {
    code: "INSURANCE",
    label: "Insurance",
    keywords: [
      "insurance", "sanlam", "old mutual", "discovery", "outsurance", "santam",
      "hollard", "momentum", "liberty", "pps", "clientele", "telesure",
      "dial direct", "budget insurance", "miway", "king price", "first for women",
      "auto & general", "ooba", "hippo", "policy", "premium", "cover",
      "indemnity", "assurance", "short term", "long term", "life cover",
      "vehicle insurance", "car insurance", "building insurance",
      "contents insurance", "business insurance", "liability insurance"
    ]
  },
  {
    code: "STATIONERY",
    label: "Stationery & Office Supplies",
    keywords: [
      "stationery", "office", "waltons", "makro", "supplies", "paper",
      "toner", "ink", "cartridge", "pen", "printer", "ream", "files",
      "folders", "envelopes", "staples", "clip", "tape", "glue",
      "takealot office", "incredible connection", "game office",
      "cna", "exclusive books", "office national", "konica minolta"
    ]
  },
  {
    code: "PROFESSIONAL_FEES",
    label: "Professional Fees",
    keywords: [
      "attorney", "lawyer", "accountant", "audit", "consulting", "consultant",
      "legal", "advocate", "counsel", "tax practitioner", "bookkeeper",
      "financial advisor", "advisor", "advisory", "professional service",
      "deloitte", "pwc", "kpmg", "ey", "ernst young", "bdo", "mazars",
      "grant thornton", "rsm", "moore", "nolands", "saica", "saipa"
    ]
  },
  {
    code: "ADVERTISING",
    label: "Advertising & Marketing",
    keywords: [
      "advertising", "marketing", "facebook", "google ads", "promo",
      "instagram", "linkedin", "twitter", "social media", "seo",
      "digital marketing", "print media", "radio", "billboard", "signage",
      "flyer", "brochure", "business card", "banner", "promotional",
      "sponsorship", "media24", "naspers", "multichoice", "dstv ad",
      "cape talk", "702", "jacaranda fm", "east coast radio"
    ]
  },
  {
    code: "REPAIRS",
    label: "Repairs & Maintenance",
    keywords: [
      "repair", "maintenance", "service", "fix", "plumber", "electrician",
      "handyman", "contractor", "building maintenance", "aircon",
      "air conditioning", "hvac", "pest control", "cleaning service",
      "garden service", "landscaping", "painting", "renovation",
      "builders warehouse", "cashbuild", "mica", "tile africa"
    ]
  },
  {
    code: "ENTERTAINMENT",
    label: "Entertainment & Meals",
    keywords: [
      "entertainment", "restaurant", "catering", "meal", "lunch", "dinner",
      "breakfast", "coffee", "cafe", "wimpy", "spur", "nandos", "steers",
      "mcdonalds", "kfc", "burger king", "debonairs", "romans", "fishaways",
      "ocean basket", "news cafe", "mugg bean", "vida", "seattle",
      "starbucks", "woolworths food", "client entertainment", "staff function"
    ]
  },
  {
    code: "GROCERIES",
    label: "Groceries & Consumables",
    keywords: [
      "groceries", "food", "pick n pay", "checkers", "shoprite", "spar",
      "woolworths", "food lover", "fruit veg", "makro food", "game food",
      "kitchen", "tea", "coffee", "milk", "sugar", "snacks", "refreshments",
      "staff kitchen", "office supplies food"
    ]
  },
  {
    code: "SUBSCRIPTIONS",
    label: "Subscriptions & Software",
    keywords: [
      "subscription", "software", "license", "microsoft", "adobe", "zoom",
      "dropbox", "google workspace", "office 365", "xero", "sage",
      "quickbooks", "pastel", "payspace", "simplepay", "slack", "asana",
      "monday", "notion", "canva", "mailchimp", "hubspot", "salesforce",
      "netflix", "showmax", "dstv", "apple", "spotify", "youtube premium",
      "linkedin premium", "domain registration", "hosting", "aws", "azure"
    ]
  },
  {
    code: "TRANSPORT",
    label: "Transport & Delivery",
    keywords: [
      "courier", "delivery", "transport", "uber", "bolt", "taxi",
      "the courier guy", "ram", "fastway", "dawn wing", "dhl", "fedex",
      "ups", "postnet", "post office", "aramex", "time freight",
      "super group", "imperial", "flight", "bus ticket", "train",
      "gautrain", "prasa", "greyhound", "intercape", "translux"
    ]
  },
  {
    code: "TRAVEL",
    label: "Travel & Accommodation",
    keywords: [
      "flight", "airline", "saa", "flysafair", "kulula", "mango", "airlink",
      "british airways", "emirates", "qatar", "hotel", "lodge", "bnb",
      "airbnb", "booking.com", "travelstart", "flight centre", "sure travel",
      "accommodation", "guesthouse", "car hire", "avis", "hertz", "budget car",
      "europcar", "first car", "tempest", "travel agent"
    ]
  },
  {
    code: "MEDICAL",
    label: "Medical Expenses",
    keywords: [
      "medical", "doctor", "pharmacy", "clicks", "dischem", "hospital",
      "netcare", "mediclinic", "life healthcare", "nhls", "pathcare",
      "ampath", "lancet", "medical aid", "discovery health", "bonitas",
      "gems", "medihelp", "momentum health", "fedhealth", "bestmed",
      "prescription", "medication", "script", "specialist", "dentist",
      "optometrist", "physiotherapy", "occupational health"
    ]
  },
  {
    code: "SECURITY",
    label: "Security Services",
    keywords: [
      "security", "adt", "fidelity", "chubb", "g4s", "css tactical",
      "armed response", "alarm", "cctv", "surveillance", "access control",
      "guard", "patrol", "monitoring"
    ]
  },
  {
    code: "CLEANING",
    label: "Cleaning Services",
    keywords: [
      "cleaning", "cleaner", "domestic", "janitorial", "hygiene",
      "bidvest steiner", "rentokil", "initial", "sanitary", "waste management",
      "refuse collection"
    ]
  },
  {
    code: "IT_EQUIPMENT",
    label: "IT Equipment & Hardware",
    keywords: [
      "computer", "laptop", "desktop", "server", "monitor", "keyboard",
      "mouse", "hard drive", "ssd", "ram", "memory", "incredible connection",
      "takealot tech", "evetech", "wootware", "rectron", "mustek",
      "dell", "hp", "lenovo", "apple mac", "network", "router", "switch"
    ]
  },
  {
    code: "FURNITURE",
    label: "Furniture & Fittings",
    keywords: [
      "furniture", "desk", "chair", "cabinet", "shelf", "table",
      "mr price home", "home", "@home", "coricraft", "weylandts",
      "furniture city", "lewis", "russells", "bradlows", "joshua doore"
    ]
  },
  {
    code: "VAT_INPUT",
    label: "VAT Input",
    keywords: []
  },
  {
    code: "VAT_OUTPUT",
    label: "VAT Output",
    keywords: []
  },
  {
    code: "VAT_PAYMENT",
    label: "VAT Payment to SARS",
    keywords: [
      "sars vat", "vat payment", "vat201", "efiling vat"
    ]
  },
  {
    code: "PROVISIONAL_TAX",
    label: "Provisional Tax",
    keywords: [
      "provisional tax", "itr6", "sars provisional", "first provisional",
      "second provisional", "third provisional", "top up"
    ]
  },
  {
    code: "COMPANY_TAX",
    label: "Company Tax / Income Tax",
    keywords: [
      "company tax", "corporate tax", "income tax", "sars income",
      "itr14", "assessment", "tax assessment"
    ]
  },
  {
    code: "DRAWINGS",
    label: "Drawings",
    keywords: [
      "drawing", "owner", "personal", "director loan", "member loan",
      "shareholder", "distribution"
    ]
  },
  {
    code: "CAPITAL",
    label: "Capital Contributions",
    keywords: [
      "capital", "investment", "shareholder contribution", "member contribution",
      "capital injection", "equity"
    ]
  },
  {
    code: "LOAN_REPAYMENT",
    label: "Loan Repayment",
    keywords: [
      "loan", "finance", "wesbank", "mfc", "nedbank finance", "absa vehicle",
      "fnb vehicle", "standard bank finance", "sasfin", "bidvest bank",
      "business loan", "term loan", "instalment", "asset finance"
    ]
  },
  {
    code: "INTEREST_RECEIVED",
    label: "Interest Received",
    keywords: [
      "interest credit", "interest earned", "interest income", "savings interest"
    ]
  },
  {
    code: "INTEREST_PAID",
    label: "Interest Paid",
    keywords: [
      "interest debit", "interest charged", "finance charge", "loan interest",
      "overdraft interest"
    ]
  },
  {
    code: "REVENUE",
    label: "Revenue/Income",
    keywords: [
      "payment received", "deposit", "eft in", "credit", "customer payment",
      "debtor payment", "invoice payment", "sales", "income received"
    ]
  },
  {
    code: "STOCK_PURCHASES",
    label: "Stock/Inventory Purchases",
    keywords: [
      "stock", "inventory", "merchandise", "goods", "product purchase",
      "supplier", "wholesale", "makro wholesale", "cash carry"
    ]
  },
  {
    code: "CREDITOR_PAYMENT",
    label: "Creditor/Supplier Payment",
    keywords: [
      "creditor", "supplier payment", "account payment", "vendor payment"
    ]
  },
  {
    code: "DEBTOR_RECEIPT",
    label: "Debtor/Customer Receipt",
    keywords: [
      "debtor", "customer receipt", "client payment", "receivable"
    ]
  },
  {
    code: "REFUND",
    label: "Refund Received/Given",
    keywords: [
      "refund", "reversal", "credit note", "return", "reimburse"
    ]
  },
  {
    code: "DONATION",
    label: "Donations & CSI",
    keywords: [
      "donation", "charity", "ngo", "npc", "section 18a", "csi",
      "corporate social", "gift", "contribution"
    ]
  },
  {
    code: "TRAINING",
    label: "Training & Education",
    keywords: [
      "training", "course", "seminar", "workshop", "conference",
      "education", "cpd", "continuing professional", "certification",
      "unisa", "wits", "uct", "stellenbosch", "up", "ukzn"
    ]
  },
  {
    code: "MEMBERSHIP",
    label: "Memberships & Subscriptions",
    keywords: [
      "membership", "member fee", "annual fee", "registration fee",
      "saica member", "saipa member", "cima", "acca", "professional body",
      "chamber of commerce", "business forum"
    ]
  },
  {
    code: "PENALTIES",
    label: "Penalties & Fines",
    keywords: [
      "penalty", "fine", "late payment", "admin penalty", "sars penalty",
      "traffic fine", "municipal fine", "interest penalty"
    ]
  },
  {
    code: "OTHER",
    label: "Other/Unallocated",
    keywords: []
  },
] as const;

export type AllocationCategoryCode = typeof ALLOCATION_CATEGORIES[number]["code"];

// Normalize description for pattern matching
export function normalizeDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")     // Remove special chars except spaces
    .replace(/\s+/g, " ")             // Normalize spaces
    .replace(/\b(r|zar)?\s*\d+([.,]\d+)?\b/g, "") // Remove amounts like R100 or 100.00
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, "")  // Remove dates
    .replace(/\b\d{6,}\b/g, "")       // Remove long numbers (references)
    .trim();
}

// Extract keywords for fuzzy matching
export function extractKeywords(desc: string): string[] {
  const stopWords = ["the", "and", "for", "from", "with", "ref", "reference", "payment", "debit", "order"];
  const normalized = normalizeDescription(desc);
  return normalized
    .split(" ")
    .filter(w => w.length > 2)
    .filter(w => !stopWords.includes(w));
}

// Suggest category based on learned rules and predefined keywords
// Now supports client-specific rules with multi-tenant and industry patterns
export async function suggestCategory(
  description: string,
  clientId?: string | null
): Promise<{
  category: string | null;
  categoryLabel: string | null;
  confidence: number;
  ruleId: string | null;
  matchType: "exact" | "learned" | "keyword" | "client_keyword" | "industry" | "none";
  alternativeSuggestions: Array<{ code: string; label: string; confidence: number }>;
  industryName?: string;
}> {
  const normalized = normalizeDescription(description);
  const keywords = extractKeywords(description);
  const alternativeSuggestions: Array<{ code: string; label: string; confidence: number }> = [];

  // Step 0: If client specified, check client-specific rules first
  if (clientId) {
    // Check client-specific exact match
    const clientExactMatch = await prisma.allocationRule.findFirst({
      where: {
        normalizedPattern: normalized,
        clientId: clientId,
        isGlobal: false,
      },
      orderBy: { learnedFromCount: "desc" },
    });

    if (clientExactMatch) {
      // Check if it's a custom category
      const customCat = await prisma.clientCategory.findFirst({
        where: { clientId, code: clientExactMatch.category },
      });
      const baseCat = ALLOCATION_CATEGORIES.find(c => c.code === clientExactMatch.category);

      return {
        category: clientExactMatch.category,
        categoryLabel: customCat?.label || baseCat?.label || clientExactMatch.category,
        confidence: Math.min(clientExactMatch.confidence, 0.99),
        ruleId: clientExactMatch.id,
        matchType: "exact",
        alternativeSuggestions: [],
      };
    }

    // Check client custom category keywords
    const clientCategories = await prisma.clientCategory.findMany({
      where: { clientId, isActive: true },
    });

    const descLower = description.toLowerCase();
    for (const clientCat of clientCategories) {
      const clientKeywords = JSON.parse(clientCat.keywords) as string[];
      for (const kw of clientKeywords) {
        if (descLower.includes(kw.toLowerCase())) {
          return {
            category: clientCat.code,
            categoryLabel: clientCat.label,
            confidence: 0.85,
            ruleId: null,
            matchType: "client_keyword",
            alternativeSuggestions: [],
          };
        }
      }
    }
  }

  // Step 1: Try exact pattern match from learned rules (global + client-specific)
  const exactMatchWhere: Record<string, unknown> = { normalizedPattern: normalized };
  if (clientId) {
    exactMatchWhere.OR = [
      { isGlobal: true },
      { clientId: clientId },
    ];
  } else {
    exactMatchWhere.isGlobal = true;
  }

  const exactMatch = await prisma.allocationRule.findFirst({
    where: exactMatchWhere,
    orderBy: { learnedFromCount: "desc" },
  });

  if (exactMatch) {
    const cat = ALLOCATION_CATEGORIES.find(c => c.code === exactMatch.category);
    return {
      category: exactMatch.category,
      categoryLabel: cat?.label || exactMatch.category,
      confidence: Math.min(exactMatch.confidence, 0.99),
      ruleId: exactMatch.id,
      matchType: "exact",
      alternativeSuggestions: [],
    };
  }

  // Step 2: Fuzzy match against learned rules (global + client-specific)
  const rulesWhere: Record<string, unknown> = {};
  if (clientId) {
    rulesWhere.OR = [
      { isGlobal: true },
      { clientId: clientId },
    ];
  } else {
    rulesWhere.isGlobal = true;
  }

  const allRules = await prisma.allocationRule.findMany({
    where: rulesWhere,
    orderBy: { learnedFromCount: "desc" },
    take: 500,
  });

  let bestLearnedMatch: typeof allRules[0] | null = null;
  let bestLearnedScore = 0;

  for (const rule of allRules) {
    const ruleKeywords = rule.normalizedPattern.split(" ").filter(w => w.length > 2);
    if (ruleKeywords.length === 0) continue;

    const overlap = keywords.filter(k => ruleKeywords.some(rk => rk.includes(k) || k.includes(rk))).length;
    const score = overlap / Math.max(keywords.length, ruleKeywords.length);

    if (score > bestLearnedScore && score > 0.4) {
      bestLearnedScore = score;
      bestLearnedMatch = rule;
    }
  }

  if (bestLearnedMatch && bestLearnedScore > 0.6) {
    const cat = ALLOCATION_CATEGORIES.find(c => c.code === bestLearnedMatch!.category);
    return {
      category: bestLearnedMatch.category,
      categoryLabel: cat?.label || bestLearnedMatch.category,
      confidence: bestLearnedScore * bestLearnedMatch.confidence,
      ruleId: bestLearnedMatch.id,
      matchType: "learned",
      alternativeSuggestions: [],
    };
  }

  // Step 2.5: Try industry patterns (anonymized learning from similar businesses)
  // This helps new companies get good suggestions based on their industry
  if (clientId) {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { industryId: true },
    });

    if (client?.industryId) {
      const industrySuggestion = await getIndustrySuggestion({
        description,
        industryId: client.industryId,
      });

      if (industrySuggestion && industrySuggestion.confidence >= 0.5) {
        const cat = ALLOCATION_CATEGORIES.find(c => c.code === industrySuggestion.category);
        return {
          category: industrySuggestion.category,
          categoryLabel: cat?.label || industrySuggestion.category || "Unknown",
          confidence: industrySuggestion.confidence,
          ruleId: null,
          matchType: "industry",
          alternativeSuggestions: [],
          industryName: industrySuggestion.industryName,
        };
      }
    }
  }

  // Step 3: Match against predefined category keywords
  const descLower = description.toLowerCase();
  const categoryScores: Array<{ code: string; label: string; score: number }> = [];

  for (const cat of ALLOCATION_CATEGORIES) {
    if (cat.keywords.length === 0) continue;

    let score = 0;
    for (const kw of cat.keywords) {
      if (descLower.includes(kw)) {
        score += kw.length; // Longer keyword matches are weighted higher
      }
    }

    if (score > 0) {
      categoryScores.push({ code: cat.code, label: cat.label, score });
    }
  }

  if (categoryScores.length > 0) {
    categoryScores.sort((a, b) => b.score - a.score);
    const best = categoryScores[0];
    const maxPossibleScore = Math.max(...ALLOCATION_CATEGORIES.flatMap(c => c.keywords).map(k => k.length)) * 2;
    const confidence = Math.min(best.score / maxPossibleScore, 0.85);

    // Add alternatives
    for (let i = 1; i < Math.min(categoryScores.length, 4); i++) {
      const alt = categoryScores[i];
      alternativeSuggestions.push({
        code: alt.code,
        label: alt.label,
        confidence: Math.min(alt.score / maxPossibleScore, 0.7),
      });
    }

    return {
      category: best.code,
      categoryLabel: best.label,
      confidence,
      ruleId: null,
      matchType: "keyword",
      alternativeSuggestions,
    };
  }

  // No match found
  return {
    category: null,
    categoryLabel: null,
    confidence: 0,
    ruleId: null,
    matchType: "none",
    alternativeSuggestions: [],
  };
}

// Learn from user correction
// Now supports client-specific learning
export async function learnFromCorrection(
  description: string,
  correctCategory: string,
  feedback: string | null,
  userId: string,
  options?: {
    clientId?: string | null;
    isGlobal?: boolean;
  }
): Promise<{ ruleId: string; isNew: boolean }> {
  const normalized = normalizeDescription(description);
  const { clientId, isGlobal = !clientId } = options || {};

  // Check if rule exists for this pattern + category (consider client scope)
  const existingWhere: Record<string, unknown> = {
    normalizedPattern: normalized,
    category: correctCategory,
  };

  if (clientId && !isGlobal) {
    existingWhere.clientId = clientId;
    existingWhere.isGlobal = false;
  } else {
    existingWhere.isGlobal = true;
  }

  const existing = await prisma.allocationRule.findFirst({
    where: existingWhere,
  });

  if (existing) {
    // Increment confidence and count
    await prisma.allocationRule.update({
      where: { id: existing.id },
      data: {
        learnedFromCount: { increment: 1 },
        confidence: Math.min(1.0, existing.confidence + 0.05),
        updatedAt: new Date(),
      },
    });

    // Log the reinforcement
    await prisma.auditLog.create({
      data: {
        userId,
        actionType: "ALLOCATION_REINFORCE",
        entityType: "AllocationRule",
        entityId: existing.id,
        detailsJson: JSON.stringify({
          description: description.substring(0, 100),
          normalized,
          category: correctCategory,
          newCount: existing.learnedFromCount + 1,
          feedback,
          clientId,
          isGlobal,
        }),
      },
    });

    return { ruleId: existing.id, isNew: false };
  }

  // Check if there's a conflicting rule (same pattern, different category, same scope)
  const conflictingWhere: Record<string, unknown> = { normalizedPattern: normalized };
  if (clientId && !isGlobal) {
    conflictingWhere.clientId = clientId;
    conflictingWhere.isGlobal = false;
  } else {
    conflictingWhere.isGlobal = true;
  }

  const conflicting = await prisma.allocationRule.findFirst({
    where: conflictingWhere,
  });

  if (conflicting) {
    // Decrease confidence of conflicting rule
    await prisma.allocationRule.update({
      where: { id: conflicting.id },
      data: {
        confidence: Math.max(0.1, conflicting.confidence - 0.1),
      },
    });
  }

  // Create new rule (with client scope if specified)
  const newRule = await prisma.allocationRule.create({
    data: {
      pattern: description,
      normalizedPattern: normalized,
      category: correctCategory,
      confidence: 0.7, // Start at 70%, build confidence over time
      learnedFromCount: 1,
      createdByUserId: userId,
      clientId: clientId && !isGlobal ? clientId : null,
      isGlobal: isGlobal,
    },
  });

  // Log the learning event
  await prisma.auditLog.create({
    data: {
      userId,
      actionType: "ALLOCATION_LEARN",
      entityType: "AllocationRule",
      entityId: newRule.id,
      detailsJson: JSON.stringify({
        description: description.substring(0, 100),
        normalized,
        category: correctCategory,
        feedback,
        hadConflict: !!conflicting,
        clientId,
        isGlobal,
      }),
    },
  });

  // Contribute to industry learning (anonymized)
  // This helps other companies in the same industry WITHOUT revealing who contributed
  if (clientId) {
    try {
      await contributeToIndustryLearning({
        clientId,
        description,
        category: correctCategory,
        userId,
      });
    } catch (error) {
      // Industry learning is optional - don't fail the main operation
      console.error("[IndustryLearning] Failed to contribute:", error);
    }
  }

  return { ruleId: newRule.id, isNew: true };
}

// Batch suggest categories for multiple transactions
export async function batchSuggestCategories(
  descriptions: string[]
): Promise<Array<{
  description: string;
  suggestion: Awaited<ReturnType<typeof suggestCategory>>;
}>> {
  const results = await Promise.all(
    descriptions.map(async (desc) => ({
      description: desc,
      suggestion: await suggestCategory(desc),
    }))
  );
  return results;
}

// Get allocation learning stats
export async function getAllocationStats() {
  const totalRules = await prisma.allocationRule.count();

  const rulesByCategory = await prisma.allocationRule.groupBy({
    by: ["category"],
    _count: { id: true },
    _sum: { learnedFromCount: true },
  });

  const topRules = await prisma.allocationRule.findMany({
    orderBy: { learnedFromCount: "desc" },
    take: 10,
  });

  return {
    totalRules,
    rulesByCategory: rulesByCategory.map(r => ({
      category: r.category,
      ruleCount: r._count.id,
      totalLearnings: r._sum.learnedFromCount || 0,
    })),
    topRules: topRules.map(r => ({
      id: r.id,
      pattern: r.pattern.substring(0, 50),
      category: r.category,
      confidence: r.confidence,
      learnedFromCount: r.learnedFromCount,
    })),
  };
}

// Export rules for backup/review
export async function exportAllocationRules(): Promise<Array<{
  pattern: string;
  normalizedPattern: string;
  category: string;
  confidence: number;
  learnedFromCount: number;
}>> {
  const rules = await prisma.allocationRule.findMany({
    orderBy: [{ category: "asc" }, { learnedFromCount: "desc" }],
  });

  return rules.map(r => ({
    pattern: r.pattern,
    normalizedPattern: r.normalizedPattern,
    category: r.category,
    confidence: r.confidence,
    learnedFromCount: r.learnedFromCount,
  }));
}

// ==============================================================================
// CODEX-ENHANCED CATEGORIZATION
// Uses decision engines and tax rules from Codex for smarter allocation
// ==============================================================================

export interface CodexCategorySuggestion {
  category: string;
  categoryLabel: string;
  confidence: number;
  reasoning: string;
  decisionEngine?: DecisionEngineMatch;
  taxImplications?: {
    isDeductible: boolean;
    vatClaimable: boolean;
    notes: string;
  };
}

/**
 * Get categorization suggestion using Codex decision engines
 * This is used for complex transactions that need rule-based decisions
 */
export async function suggestCategoryWithCodex(
  description: string,
  amount: number,
  isDebit: boolean,
  clientContext?: {
    clientId?: string;
    industryCode?: string;
    vatRegistered?: boolean;
  }
): Promise<CodexCategorySuggestion | null> {
  // Build a context-rich query for Codex
  const transactionType = isDebit ? "expense" : "income";
  const query = `categorize ${transactionType} transaction: ${description} amount R${Math.abs(amount).toFixed(2)}`;

  // Find applicable decision engines for allocation
  const engines = await findApplicableDecisionEngines(query, "ACCOUNTING_GENERAL");

  if (engines.length === 0) {
    return null; // No codex-based guidance available
  }

  const topEngine = engines[0];
  let suggestedCategory: string | null = null;
  let reasoning = "";

  // Apply the decision engine steps
  for (const step of topEngine.engine.mandatory_decision_order) {
    reasoning += `Step ${step.step}: ${step.action}\n`;

    // Look for category suggestions in the step details
    const categoryMatch = step.details.match(/category[:\s]+([A-Z_]+)/i);
    if (categoryMatch) {
      suggestedCategory = categoryMatch[1].toUpperCase();
    }
  }

  if (!suggestedCategory) {
    // Try to infer from the engine role
    const roleKeywords = topEngine.engine.role.toLowerCase();
    for (const cat of ALLOCATION_CATEGORIES) {
      if (roleKeywords.includes(cat.code.toLowerCase().replace("_", " "))) {
        suggestedCategory = cat.code;
        break;
      }
    }
  }

  if (!suggestedCategory) {
    return null;
  }

  const categoryInfo = ALLOCATION_CATEGORIES.find(c => c.code === suggestedCategory);

  // Check tax implications if this is an expense
  let taxImplications: CodexCategorySuggestion["taxImplications"] = undefined;
  if (isDebit) {
    const taxRules = await findApplicableTaxRules(
      `${description} ${suggestedCategory} deductible`,
      "INCOME_TAX"
    );

    if (taxRules.length > 0) {
      const topRule = taxRules[0];
      const appLogic = topRule.rule.application_logic.toLowerCase();

      taxImplications = {
        isDeductible: !appLogic.includes("not deductible") && !appLogic.includes("prohibited"),
        vatClaimable: clientContext?.vatRegistered ?? false,
        notes: topRule.rule.interpretation,
      };
    }
  }

  return {
    category: suggestedCategory,
    categoryLabel: categoryInfo?.label || suggestedCategory,
    confidence: topEngine.matchScore * 0.9, // Slightly reduce confidence for codex matches
    reasoning,
    decisionEngine: topEngine,
    taxImplications,
  };
}

/**
 * Enhanced suggestion that combines learned rules with Codex knowledge
 */
export async function suggestCategoryEnhanced(
  description: string,
  options?: {
    clientId?: string | null;
    amount?: number;
    isDebit?: boolean;
    useCodex?: boolean;
  }
): Promise<{
  suggestion: Awaited<ReturnType<typeof suggestCategory>>;
  codexSuggestion: CodexCategorySuggestion | null;
  recommendedCategory: string | null;
  recommendedLabel: string | null;
  totalConfidence: number;
}> {
  const { clientId, amount = 0, isDebit = true, useCodex = true } = options || {};

  // Get standard suggestion from learned rules
  const suggestion = await suggestCategory(description, clientId);

  // Get Codex-based suggestion if enabled
  let codexSuggestion: CodexCategorySuggestion | null = null;
  if (useCodex) {
    try {
      codexSuggestion = await suggestCategoryWithCodex(
        description,
        amount,
        isDebit,
        clientId ? { clientId } : undefined
      );
    } catch (error) {
      console.error("[Codex] Category suggestion error:", error);
    }
  }

  // Determine the best recommendation
  let recommendedCategory: string | null = null;
  let recommendedLabel: string | null = null;
  let totalConfidence = 0;

  if (suggestion.category && codexSuggestion) {
    // Both have suggestions - compare
    if (suggestion.category === codexSuggestion.category) {
      // Agreement! Higher confidence
      recommendedCategory = suggestion.category;
      recommendedLabel = suggestion.categoryLabel;
      totalConfidence = Math.min(0.99, suggestion.confidence + codexSuggestion.confidence * 0.3);
    } else if (suggestion.confidence > codexSuggestion.confidence) {
      // Learned rule wins
      recommendedCategory = suggestion.category;
      recommendedLabel = suggestion.categoryLabel;
      totalConfidence = suggestion.confidence;
    } else {
      // Codex wins
      recommendedCategory = codexSuggestion.category;
      recommendedLabel = codexSuggestion.categoryLabel;
      totalConfidence = codexSuggestion.confidence;
    }
  } else if (suggestion.category) {
    recommendedCategory = suggestion.category;
    recommendedLabel = suggestion.categoryLabel;
    totalConfidence = suggestion.confidence;
  } else if (codexSuggestion) {
    recommendedCategory = codexSuggestion.category;
    recommendedLabel = codexSuggestion.categoryLabel;
    totalConfidence = codexSuggestion.confidence;
  }

  return {
    suggestion,
    codexSuggestion,
    recommendedCategory,
    recommendedLabel,
    totalConfidence,
  };
}

// ==============================================================================
// ACCOUNTING ECOSYSTEM SYNC BRIDGE
// Pushes a confirmed allocation from Sean's SQLite store to the accounting-
// ecosystem backend's bank staging pipeline. Called after learnFromCorrection.
// Never throws — the caller's confirmation flow must not be blocked by a
// downstream sync failure.
// ==============================================================================

export async function syncConfirmedToAccountingEco(
  txId: string,
  ecoBaseUrl: string
): Promise<void> {
  const serviceToken = process.env.ECO_SERVICE_TOKEN;
  if (!serviceToken) {
    console.warn("[EcoSync] ECO_SERVICE_TOKEN not set — skipping sync for tx", txId);
    return;
  }

  let tx: Awaited<ReturnType<typeof prisma.bankTransaction.findUnique>>;
  try {
    tx = await prisma.bankTransaction.findUnique({ where: { id: txId } });
  } catch (err) {
    console.error("[EcoSync] Failed to fetch transaction", txId, err);
    return;
  }

  if (!tx) {
    console.warn("[EcoSync] Transaction not found, skipping sync:", txId);
    return;
  }

  if (!tx.confirmedCategory) {
    console.warn("[EcoSync] Transaction has no confirmedCategory, skipping sync:", txId);
    return;
  }

  const payload = {
    externalId: tx.id,
    date: tx.date,
    description: tx.description,
    rawDescription: tx.rawDescription,
    amount: tx.amount,
    isDebit: tx.isDebit,
    confirmedCategory: tx.confirmedCategory,
    suggestedCategory: tx.suggestedCategory,
    suggestedConfidence: tx.suggestedConfidence,
    clientId: tx.clientId,
    bankAccount: tx.bankAccount,
    source: "sean",
  };

  try {
    const response = await fetch(`${ecoBaseUrl}/api/bank-transactions/staging`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log("[EcoSync] Synced tx", txId, "→ accounting-ecosystem staging");
    } else {
      const body = await response.text().catch(() => "(unreadable)");
      console.error("[EcoSync] Staging endpoint rejected tx", txId, response.status, body);
    }
  } catch (err) {
    console.error("[EcoSync] Network error syncing tx", txId, err);
  }
}
