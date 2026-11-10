import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "module";
import prisma from "@/lib/db";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { generateCitationId, generateSlug } from "@/lib/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const require = createRequire(import.meta.url);

type PdfParseResult = { text: string; numpages?: number };
type PdfParseFn = (buf: Buffer) => Promise<PdfParseResult>;

let pdfParseFn: PdfParseFn | null = null;

async function loadPdfParse(): Promise<PdfParseFn> {
  if (pdfParseFn) return pdfParseFn;

  const attempts: Array<{
    label: string;
    loader: () => Promise<unknown> | unknown;
  }> = [
    {
      label: "import('pdf-parse')",
      loader: async () => await import("pdf-parse"),
    },
    {
      label: "require('pdf-parse')",
      loader: () => require("pdf-parse"),
    },
  ];

  let lastErr: unknown = null;

  for (const a of attempts) {
    try {
      console.log(`[PDF] Trying ${a.label}...`);
      const mod = await a.loader();

      // Normalize CJS/ESM shapes safely
      const m = mod as unknown as { default?: unknown } & Record<string, unknown>;
      const candidate = (m?.default ?? m) as unknown;

      const keys = m ? Object.keys(m) : [];
      console.log(`[PDF] ${a.label} keys:`, keys);

      if (typeof candidate === "function") {
        pdfParseFn = candidate as PdfParseFn;
        console.log(`[PDF] Loaded pdf-parse via ${a.label}`);
        return pdfParseFn;
      }

      // Sometimes export might be nested (rare)
      for (const k of keys) {
        const v = (m as Record<string, unknown>)[k];
        if (typeof v === "function") {
          pdfParseFn = v as PdfParseFn;
          console.log(`[PDF] Loaded pdf-parse via ${a.label} (key=${k})`);
          return pdfParseFn;
        }
      }

      lastErr = new Error(
        `pdf-parse export not a function using ${a.label}. typeof=${typeof candidate}`
      );
    } catch (e) {
      lastErr = e;
      console.log(`[PDF] ${a.label} failed:`, e);
    }
  }

  throw new Error(
    `Failed to load pdf-parse (all strategies). Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

function chunkText(text: string, chunkSize = 1200, overlap = 100): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);

    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

function inferDomainFromText(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("vat") || t.includes("value added")) return "VAT";
  if (t.includes("income tax") || t.includes("taxable income") || t.includes("salary") || t.includes("wage"))
    return "INCOME_TAX";
  if (t.includes("company tax") || t.includes("corporate tax") || t.includes("business tax") || t.includes("profit"))
    return "COMPANY_TAX";
  if (t.includes("payroll") || t.includes("paye")) return "PAYROLL";
  if (t.includes("capital gains") || t.includes("cgt") || t.includes("investment income") || t.includes("property sale"))
    return "CAPITAL_GAINS_TAX";
  if (t.includes("withholding") || t.includes("dividend tax") || t.includes("interest tax"))
    return "WITHHOLDING_TAX";
  return "OTHER";
}

export async function POST(request: NextRequest) {
  try {
    console.log("[ingest-pdf] POST received");

    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();
    const userId = user.id;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    console.log(`[ingest-pdf] file=${file.name} type=${file.type} size=${file.size}`);

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "File must be a PDF" }, { status: 400 });
    }

    const maxSize = 15 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json({ error: "File size exceeds 15MB limit" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    console.log(`[ingest-pdf] buffer length=${buffer.length}`);

    const pdfParse = await loadPdfParse();
    console.log("[ingest-pdf] parsing pdf...");
    const pdfData = await pdfParse(buffer);
    console.log(`[ingest-pdf] parsed pages=${pdfData.numpages ?? "?"} textLen=${(pdfData.text || "").length}`);

    const extractedText = (pdfData.text || "").trim();
    if (extractedText.length < 50) {
      return NextResponse.json(
        { error: "No text found in PDF. It may be scanned. OCR not enabled yet." },
        { status: 400 }
      );
    }

    const safeBaseName = file.name
      .replace(/\.pdf$/i, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "");

    const chunks = chunkText(extractedText, 1200, 100);
    if (chunks.length === 0) {
      return NextResponse.json({ error: "Could not chunk PDF text" }, { status: 400 });
    }

    const domainCounts: Record<string, number> = {};
    const createdIds: number[] = []; // KnowledgeItem.id is Int (sean_knowledge_items.id) — see 2026-08-31 SEVCO migration

    for (let i = 0; i < chunks.length; i++) {
      const chunkNum = i + 1;
      const chunkContent = chunks[i];

      const chunkDomain = inferDomainFromText(chunkContent);
      domainCounts[chunkDomain] = (domainCounts[chunkDomain] || 0) + 1;

      const slug = generateSlug(`${safeBaseName}-chunk-${chunkNum}`);
      const citationId = generateCitationId("FIRM", slug, 1);

      const item = await prisma.knowledgeItem.create({
        data: {
          layer: "FIRM",
          scopeType: "GLOBAL",
          title: `${safeBaseName} - Chunk ${chunkNum} of ${chunks.length}`,
          slug,
          contentText: chunkContent,
          language: "EN",
          tags: ["pdf-ingest", safeBaseName], // native array — see 2026-08-31 SEVCO migration
          primaryDomain: chunkDomain,
          secondaryDomains: JSON.stringify([]),
          status: "PENDING",
          kbVersion: 1,
          citationId,
          submittedByUserId: userId,

          // Keep schema-safe based on your comment
          sourceType: "user",
          sourceUrl: file.name,
          sourceSection: `pdf:chunk:${chunkNum}`,
        },
      });

      createdIds.push(item.id);
    }

    await prisma.auditLog.create({
      data: {
        userId,
        actionType: "KB_INGEST_PDF",
        entityType: "KnowledgeItem",
        detailsJson: JSON.stringify({
          fileName: file.name,
          chunks: chunks.length,
          created: createdIds.length,
          pages: pdfData.numpages ?? null,
          domainCounts,
          itemIds: createdIds,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      fileName: file.name,
      totalChunks: chunks.length,
      createdItems: createdIds.length,
      domainCounts,
      message: `Created ${createdIds.length} PENDING knowledge items from PDF.`,
    });
  } catch (err: unknown) {
    console.error("[ingest-pdf] ERROR:", err);
    return NextResponse.json(
      {
        error: "PDF ingest failed",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
