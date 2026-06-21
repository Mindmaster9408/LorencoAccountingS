/* =============================================================
   Practice Individual Tax — Review Pack + Draft PDF  (Codebox 30)

   DRAFT / INTERNAL USE ONLY. NOT SARS-final.
   NOT eFiling submission. NOT tax advice.
   All output requires accountant review before any use.

   Routes mounted at /api/practice/individual-tax via index.js.
   Route prefix when mounted: all paths are relative to /individual-tax.

   Endpoints:
     GET    /:returnId/review-packs
     POST   /:returnId/review-packs/generate
     GET    /review-packs/:id/report-data          ← 3-seg before 2-seg
     GET    /review-packs/:id/report-html
     GET    /review-packs/:id/report-pdf
     PUT    /review-packs/:id/submit-review
     PUT    /review-packs/:id/approve
     PUT    /review-packs/:id/reject
     GET    /review-packs/:id/events
     GET    /review-packs/:id
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (_) { PDFDocument = null; }

// ─── Constants ────────────────────────────────────────────────────────────────

const PACK_STATUSES = [
    'draft', 'generated', 'ready_for_review', 'reviewed',
    'approved', 'rejected', 'cancelled',
];

const DONE_STATUSES = ['received', 'captured', 'reviewed', 'waived'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyReturnOwnership(cid, returnId) {
    const { data } = await supabase
        .from('practice_individual_tax_returns')
        .select('*')
        .eq('id', returnId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifyPackOwnership(cid, packId) {
    const { data } = await supabase
        .from('practice_individual_tax_review_packs')
        .select('*')
        .eq('id', packId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function logPackEvent(cid, packId, returnId, eventType, extras = {}) {
    try {
        await supabase.from('practice_individual_tax_review_pack_events').insert({
            company_id:     cid,
            review_pack_id: packId,
            tax_return_id:  returnId,
            event_type:     eventType,
            old_status:     extras.old_status    || null,
            new_status:     extras.new_status    || null,
            actor_user_id:  extras.actor_user_id || null,
            notes:          extras.notes         || null,
            metadata:       extras.metadata      || {},
        });
    } catch (_) { /* non-fatal */ }
}

function fmt(n, nullLabel) {
    if (n == null) return nullLabel || '—';
    return 'R ' + parseFloat(n).toLocaleString('en-ZA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Snapshot Builder ─────────────────────────────────────────────────────────
// Pulls all relevant data for the return and creates an immutable snapshot.
// The snapshot is what drives every subsequent report render — source data
// changes after generation do NOT affect the pack.

async function buildSnapshot(cid, taxReturn, calcId) {
    const returnId = taxReturn.id;

    // Client
    const { data: client } = await supabase
        .from('practice_clients')
        .select('id, display_name, company_name, client_type, income_tax_number, id_number, passport_number')
        .eq('id', taxReturn.client_id)
        .eq('company_id', cid)
        .single();

    // Taxpayer profile
    const { data: profile } = await supabase
        .from('practice_taxpayer_profiles')
        .select('id, taxpayer_type, income_tax_number, id_number, passport_number, date_of_birth, marital_status, age_at_year_end, notes')
        .eq('id', taxReturn.taxpayer_profile_id)
        .eq('company_id', cid)
        .single();

    // Checklist items
    const { data: items } = await supabase
        .from('practice_individual_tax_items')
        .select('item_type, item_label, item_status, amount, source_reference, notes')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('created_at');

    // Income entries
    const { data: income } = await supabase
        .from('practice_individual_tax_income_entries')
        .select('income_type, description, gross_amount, tax_withheld, source_reference, notes')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('income_type');

    // Deduction entries
    const { data: deductions } = await supabase
        .from('practice_individual_tax_deduction_entries')
        .select('deduction_type, description, amount, source_reference, notes')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .order('deduction_type');

    // Latest calculation — prefer supplied calcId, else latest approved/draft
    let calculation = null;
    if (calcId) {
        const { data: c } = await supabase
            .from('practice_individual_tax_calculations')
            .select('*')
            .eq('id', calcId)
            .eq('company_id', cid)
            .single();
        calculation = c || null;
    }
    if (!calculation) {
        // Fall back to latest non-cancelled calculation
        const { data: calcs } = await supabase
            .from('practice_individual_tax_calculations')
            .select('*')
            .eq('tax_return_id', returnId)
            .eq('company_id', cid)
            .neq('calculation_status', 'cancelled')
            .order('calculation_version', { ascending: false })
            .limit(1);
        calculation = (calcs && calcs.length > 0) ? calcs[0] : null;
    }

    // Readiness scoring (re-derived from items in snapshot)
    const itemList = items || [];
    const required  = itemList.filter(i => i.item_status !== 'not_applicable');
    const done      = required.filter(i => DONE_STATUSES.includes(i.item_status));
    const blocked   = required.filter(i => i.item_status === 'blocked');
    const score     = required.length > 0 ? Math.round((done.length / required.length) * 100) : null;
    let readiness_status = 'unknown';
    if (required.length > 0) {
        if (blocked.length > 0)   readiness_status = 'blocked';
        else if (score >= 85)     readiness_status = 'ready';
        else if (score >= 50)     readiness_status = 'partial';
        else                      readiness_status = 'incomplete';
    }

    // Income totals
    const incomeList = income || [];
    const dedList    = deductions || [];
    const gross_income      = incomeList.reduce((s, e) => s + parseFloat(e.gross_amount  || 0), 0);
    const total_withheld    = incomeList.reduce((s, e) => s + parseFloat(e.tax_withheld  || 0), 0);
    const total_deductions  = dedList.reduce((s, e)   => s + parseFloat(e.amount        || 0), 0);

    return {
        generated_at: new Date().toISOString(),
        tax_return:        taxReturn,
        client:            client    || null,
        taxpayer_profile:  profile   || null,
        items:             itemList,
        income_entries:    incomeList,
        deduction_entries: dedList,
        calculation:       calculation,
        readiness: { score, readiness_status, required_count: required.length, done_count: done.length, blocked_count: blocked.length },
        totals: {
            gross_income:          Math.round(gross_income     * 100) / 100,
            total_withheld:        Math.round(total_withheld   * 100) / 100,
            total_deductions:      Math.round(total_deductions * 100) / 100,
            taxable_after_deductions: calculation ? parseFloat(calculation.taxable_after_deductions || 0) : null,
            normal_tax_before_rebates: calculation ? parseFloat(calculation.normal_tax_before_rebates || 0) : null,
            primary_rebate:        calculation ? parseFloat(calculation.primary_rebate || 0) : null,
            tax_after_rebates:     calculation ? parseFloat(calculation.tax_after_rebates || 0) : null,
            paye_withheld:         calculation ? parseFloat(calculation.paye_withheld || 0) : null,
            estimated_tax_payable: calculation ? parseFloat(calculation.estimated_tax_payable || 0) : null,
            estimated_refund:      calculation ? parseFloat(calculation.estimated_refund      || 0) : null,
        },
        tax_config_source:  calculation ? (calculation.tax_table_version || 'unknown') : 'no_calculation',
        warning_flags:      calculation ? (calculation.warning_flags || []) : ['NO_CALCULATION_AVAILABLE'],
        assumptions:        calculation ? (calculation.assumptions     || []) : [],
        calculation_lines:  calculation ? (calculation.calculation_lines || []) : [],
    };
}

// ─── HTML Report Builder ──────────────────────────────────────────────────────

function buildReportHtml(pack, snapshot) {
    const s  = snapshot;
    const t  = s.totals || {};
    const r  = s.readiness || {};
    const tp = s.taxpayer_profile || {};
    const cl = s.client || {};
    const tr = s.tax_return || {};
    const calc = s.calculation;

    const clientName = cl.display_name || cl.company_name || ('Client #' + tr.client_id);
    const taxpayerType = tp.taxpayer_type || tr.taxpayer_type || 'individual';
    const taxRef = tp.income_tax_number || cl.income_tax_number || '—';
    const idNum  = tp.id_number || cl.id_number || tp.passport_number || cl.passport_number || '—';

    const incomeRows = (s.income_entries || []).map(e =>
        `<tr>
            <td>${esc(e.income_type)}</td>
            <td>${esc(e.description || '—')}</td>
            <td style="text-align:right">${fmt(e.gross_amount, '—')}</td>
            <td style="text-align:right">${fmt(e.tax_withheld, '—')}</td>
            <td>${esc(e.source_reference || '—')}</td>
        </tr>`
    ).join('');

    const dedRows = (s.deduction_entries || []).map(e =>
        `<tr>
            <td>${esc(e.deduction_type)}</td>
            <td>${esc(e.description || '—')}</td>
            <td style="text-align:right">${fmt(e.amount, '—')}</td>
            <td>${esc(e.source_reference || '—')}</td>
        </tr>`
    ).join('');

    const checklistRows = (s.items || []).map(i =>
        `<tr>
            <td>${esc(i.item_type)}</td>
            <td>${esc(i.item_label)}</td>
            <td><span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#1e1e2a;color:#aaa">${esc(i.item_status)}</span></td>
            <td>${fmt(i.amount, '')}</td>
            <td>${esc(i.notes || '')}</td>
        </tr>`
    ).join('');

    const calcLinesRows = (s.calculation_lines || []).map(l =>
        `<tr>
            <td>${esc(l.label)}</td>
            <td style="text-align:right">${l.amount != null ? fmt(l.amount) : '—'}</td>
            <td style="font-size:11px;color:#888">${esc(l.note || '')}</td>
        </tr>`
    ).join('');

    const warnChips = (s.warning_flags || []).map(w =>
        `<span style="display:inline-block;background:#2d2200;color:#f2c94c;border:1px solid #7a5c00;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:600;margin:2px;letter-spacing:.03em">${esc(w)}</span>`
    ).join('');

    const assumptionItems = (s.assumptions || []).map(a =>
        `<li style="color:#aaa;font-size:12px;margin-bottom:4px">${esc(a)}</li>`
    ).join('');

    const generatedDate = pack.report_generated_at
        ? new Date(pack.report_generated_at).toLocaleString('en-ZA')
        : new Date().toLocaleString('en-ZA');

    const calcSection = calc
        ? `<section style="margin-bottom:28px">
            <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#7bb8f8;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:14px">6. Draft Calculation Summary</h2>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                    <tr>
                        <th style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;padding:6px 0;border-bottom:1px solid #333">Line</th>
                        <th style="text-align:right;color:#888;font-size:11px;text-transform:uppercase;padding:6px 0;border-bottom:1px solid #333">Amount</th>
                        <th style="text-align:left;color:#888;font-size:11px;text-transform:uppercase;padding:6px 0;border-bottom:1px solid #333;padding-left:12px">Note</th>
                    </tr>
                </thead>
                <tbody>${calcLinesRows}</tbody>
            </table>
            <div style="margin-top:14px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
                <div style="background:#0d2918;border-radius:6px;padding:12px">
                    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Taxable Income</div>
                    <div style="font-size:16px;font-weight:700;color:#eee">${fmt(t.taxable_after_deductions, '—')}</div>
                </div>
                <div style="background:${t.estimated_tax_payable > 0 ? '#3a1a1a' : '#0d2918'};border-radius:6px;padding:12px">
                    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Est. Tax Payable</div>
                    <div style="font-size:16px;font-weight:700;color:${t.estimated_tax_payable > 0 ? '#eb5757' : '#27ae60'}">${fmt(t.estimated_tax_payable, '—')}</div>
                </div>
                <div style="background:${t.estimated_refund > 0 ? '#0d2918' : '#1e1e2a'};border-radius:6px;padding:12px">
                    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Est. Refund</div>
                    <div style="font-size:16px;font-weight:700;color:${t.estimated_refund > 0 ? '#27ae60' : '#aaa'}">${fmt(t.estimated_refund, '—')}</div>
                </div>
            </div>
        </section>`
        : `<section style="margin-bottom:28px">
            <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#7bb8f8;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:14px">6. Draft Calculation Summary</h2>
            <p style="color:#f2c94c;font-size:13px">⚠ No calculation has been run for this tax return yet. Run a draft calculation first, then regenerate this pack to include figures.</p>
        </section>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Draft Individual Tax Review Pack — ${esc(clientName)} — ${esc(tr.tax_year)}</title>
<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#111;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.6;padding:0}
    .report-wrap{max-width:900px;margin:0 auto;padding:32px 24px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid #333}
    td{padding:8px 10px;border-bottom:1px solid #222;color:#ddd;vertical-align:top}
    tr:hover td{background:rgba(255,255,255,.02)}
    h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#7bb8f8;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:14px}
    .kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-bottom:14px}
    .kv-label{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
    .kv-val{font-size:13px;color:#eee}
    @media print{body{background:#fff;color:#000}.report-wrap{padding:0}th,td{border-color:#ccc}h2{color:#1a3a6a}}
</style>
</head>
<body>
<div class="report-wrap">

    <!-- ── 1. Header ─────────────────────────────────────────────────── -->
    <div style="background:#1a2540;border:1px solid #2a4080;border-radius:8px;padding:20px 24px;margin-bottom:28px">
        <div style="font-size:10px;color:#7bb8f8;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px">Lorenco Practice Management</div>
        <div style="font-size:22px;font-weight:700;color:#eee;margin-bottom:6px">Draft Individual Tax Review Pack</div>
        <div style="font-size:11px;color:#f2c94c;font-weight:600;letter-spacing:.04em;margin-bottom:4px">
            ⚠ DRAFT ESTIMATE ONLY — Accountant review required. NOT SARS-final. NOT for submission.
        </div>
        <div style="font-size:11px;color:#888">
            Pack: ${esc(pack.pack_name)} &nbsp;|&nbsp;
            Status: ${esc(pack.pack_status)} &nbsp;|&nbsp;
            Generated: ${esc(generatedDate)}
        </div>
    </div>

    <!-- ── 2. Client / Taxpayer Details ──────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>2. Client / Taxpayer Details</h2>
        <div class="kv-grid">
            <div><div class="kv-label">Client Name</div><div class="kv-val">${esc(clientName)}</div></div>
            <div><div class="kv-label">Taxpayer Type</div><div class="kv-val">${esc(taxpayerType)}</div></div>
            <div><div class="kv-label">ID / Passport Number</div><div class="kv-val">${esc(idNum)}</div></div>
            <div><div class="kv-label">Income Tax Reference</div><div class="kv-val">${esc(taxRef)}</div></div>
            <div><div class="kv-label">Tax Year</div><div class="kv-val">${esc(tr.tax_year)}</div></div>
            <div><div class="kv-label">Return Name</div><div class="kv-val">${esc(tr.return_name || '—')}</div></div>
        </div>
    </section>

    <!-- ── 3. Tax Return Readiness ────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>3. Tax Return Readiness</h2>
        <div class="kv-grid">
            <div><div class="kv-label">Readiness Score</div><div class="kv-val" style="font-size:20px;font-weight:700">${r.score != null ? r.score + '%' : '—'}</div></div>
            <div><div class="kv-label">Readiness Status</div><div class="kv-val" style="font-size:14px;font-weight:600;color:${r.readiness_status === 'ready' ? '#27ae60' : r.readiness_status === 'blocked' ? '#eb5757' : '#f2c94c'}">${esc(r.readiness_status || 'unknown')}</div></div>
            <div><div class="kv-label">Items Required</div><div class="kv-val">${r.required_count || 0}</div></div>
            <div><div class="kv-label">Items Done</div><div class="kv-val">${r.done_count || 0}</div></div>
            ${r.blocked_count > 0 ? `<div><div class="kv-label" style="color:#eb5757">Blocked Items</div><div class="kv-val" style="color:#eb5757">${r.blocked_count}</div></div>` : ''}
            <div><div class="kv-label">Return Status</div><div class="kv-val">${esc(tr.status || '—')}</div></div>
        </div>
    </section>

    <!-- ── 4. Captured Income ─────────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>4. Captured Income</h2>
        ${(s.income_entries || []).length > 0
            ? `<table>
                <thead><tr>
                    <th>Type</th><th>Description</th>
                    <th style="text-align:right">Gross Amount</th>
                    <th style="text-align:right">Tax Withheld</th>
                    <th>Reference</th>
                </tr></thead>
                <tbody>${incomeRows}</tbody>
                <tfoot><tr>
                    <td colspan="2" style="font-weight:600;color:#eee">Total</td>
                    <td style="text-align:right;font-weight:700;color:#eee">${fmt(t.gross_income)}</td>
                    <td style="text-align:right;font-weight:700;color:#eee">${fmt(t.total_withheld)}</td>
                    <td></td>
                </tr></tfoot>
            </table>`
            : `<p style="color:#f2c94c;font-size:13px">⚠ No income entries captured for this return.</p>`}
    </section>

    <!-- ── 5. Captured Deductions ─────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>5. Captured Deductions</h2>
        ${(s.deduction_entries || []).length > 0
            ? `<table>
                <thead><tr>
                    <th>Type</th><th>Description</th>
                    <th style="text-align:right">Amount</th>
                    <th>Reference</th>
                </tr></thead>
                <tbody>${dedRows}</tbody>
                <tfoot><tr>
                    <td colspan="2" style="font-weight:600;color:#eee">Total Deductions</td>
                    <td style="text-align:right;font-weight:700;color:#eee">${fmt(t.total_deductions)}</td>
                    <td></td>
                </tr></tfoot>
            </table>`
            : `<p style="color:#aaa;font-size:13px">No deduction entries captured.</p>`}
    </section>

    <!-- ── 6. Draft Calculation Summary ──────────────────────────────── -->
    ${calcSection}

    <!-- ── Supporting Checklist ──────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>Supporting Checklist</h2>
        ${(s.items || []).length > 0
            ? `<table>
                <thead><tr>
                    <th>Type</th><th>Item</th><th>Status</th><th>Amount</th><th>Notes</th>
                </tr></thead>
                <tbody>${checklistRows}</tbody>
            </table>`
            : `<p style="color:#aaa;font-size:13px">No checklist items generated.</p>`}
    </section>

    <!-- ── 7. Warning Flags ───────────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>7. Warning Flags</h2>
        ${(s.warning_flags || []).length > 0
            ? `<div>${warnChips}</div>`
            : `<p style="color:#27ae60;font-size:13px">No warning flags.</p>`}
    </section>

    <!-- ── 8. Tax Config Source ───────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>8. Tax Config Source</h2>
        <div class="kv-grid">
            <div><div class="kv-label">Tax Table Version</div><div class="kv-val">${esc(s.tax_config_source)}</div></div>
            ${calc ? `<div><div class="kv-label">Calculation Name</div><div class="kv-val">${esc(calc.calculation_name)}</div></div>
            <div><div class="kv-label">Calculation Version</div><div class="kv-val">v${esc(calc.calculation_version)}</div></div>
            <div><div class="kv-label">Calculation Status</div><div class="kv-val">${esc(calc.calculation_status)}</div></div>` : ''}
        </div>
        ${(s.assumptions || []).length > 0
            ? `<div style="margin-top:10px"><div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Assumptions Applied</div><ul style="padding-left:18px">${assumptionItems}</ul></div>`
            : ''}
    </section>

    <!-- ── 9. Reviewer Sign-off ───────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>9. Reviewer Sign-off</h2>
        <div class="kv-grid">
            <div>
                <div class="kv-label">Prepared By</div>
                <div class="kv-val" style="min-height:32px;border-bottom:1px solid #444;padding-bottom:4px">&nbsp;</div>
            </div>
            <div>
                <div class="kv-label">Date Prepared</div>
                <div class="kv-val" style="min-height:32px;border-bottom:1px solid #444;padding-bottom:4px">&nbsp;</div>
            </div>
            <div>
                <div class="kv-label">Reviewed By</div>
                <div class="kv-val" style="min-height:32px;border-bottom:1px solid #444;padding-bottom:4px">${esc(pack.reviewed_by ? 'User #' + pack.reviewed_by : (pack.reviewed_at ? 'See audit log' : ''))}</div>
            </div>
            <div>
                <div class="kv-label">Date Reviewed</div>
                <div class="kv-val" style="min-height:32px;border-bottom:1px solid #444;padding-bottom:4px">${esc(pack.reviewed_at ? new Date(pack.reviewed_at).toLocaleString('en-ZA') : '')}</div>
            </div>
        </div>
        ${pack.approval_notes
            ? `<div style="margin-top:10px"><div class="kv-label">Approval Notes</div><div style="color:#eee;margin-top:4px;padding:10px;background:#1e1e2a;border-radius:4px">${esc(pack.approval_notes)}</div></div>`
            : ''}
    </section>

    <!-- ── 10. Disclaimer ────────────────────────────────────────────── -->
    <div style="background:#2d2200;border:1px solid #7a5c00;border-radius:6px;padding:14px 16px;margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;color:#f2c94c;letter-spacing:.04em;margin-bottom:4px">DISCLAIMER</div>
        <p style="font-size:12px;color:#f2c94c;line-height:1.6">
            DRAFT ESTIMATE ONLY — This document is an internal review pack prepared for accountant use.
            All figures are draft estimates and require full accountant review before any use.
            This document is NOT SARS-final, NOT suitable for eFiling submission, and does NOT constitute
            tax advice. All calculations must be verified against SARS published rates, client-specific
            circumstances, and applicable legislation. Lorenco Practice Management accepts no liability
            for reliance on this draft output.
        </p>
    </div>

</div>
</body>
</html>`;
}

// ─── PDF Builder ──────────────────────────────────────────────────────────────

function streamReportPdf(pack, snapshot, res) {
    if (!PDFDocument) {
        res.status(501).json({ error: 'PDFKit not installed. HTML report is available instead.' });
        return;
    }

    const s  = snapshot;
    const t  = s.totals || {};
    const r  = s.readiness || {};
    const tp = s.taxpayer_profile || {};
    const cl = s.client || {};
    const tr = s.tax_return || {};
    const calc = s.calculation;

    const clientName = cl.display_name || cl.company_name || ('Client #' + tr.client_id);
    const taxRef = tp.income_tax_number || cl.income_tax_number || '—';
    const idNum  = tp.id_number || cl.id_number || tp.passport_number || cl.passport_number || '—';
    const genDate = pack.report_generated_at
        ? new Date(pack.report_generated_at).toLocaleString('en-ZA')
        : new Date().toLocaleString('en-ZA');

    const filename = `draft-tax-review-${tr.tax_year}-${(clientName || 'client').replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    const DARK     = '#111111';
    const LIGHT    = '#eeeeee';
    const MUTED    = '#888888';
    const ACCENT   = '#4a9edd';
    const WARN     = '#f2c94c';
    const DANGER   = '#eb5757';
    const SUCCESS  = '#27ae60';

    function heading(text, y) {
        doc.rect(50, doc.y, doc.page.width - 100, 1).fillColor('#333333').fill();
        doc.moveDown(0.3);
        doc.fontSize(9).fillColor(ACCENT).font('Helvetica-Bold')
            .text(text.toUpperCase(), { characterSpacing: 1 });
        doc.moveDown(0.4);
    }

    function kvRow(label, value) {
        doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(label, { continued: true, width: 160 });
        doc.fillColor(LIGHT).font('Helvetica').text(value || '—');
    }

    // ── Cover ──────────────────────────────────────────────────────────────────
    doc.rect(50, 50, doc.page.width - 100, 110).fillColor('#1a2540').fill();
    doc.fontSize(8).fillColor('#7bb8f8').font('Helvetica-Bold')
        .text('LORENCO PRACTICE MANAGEMENT', 66, 66, { characterSpacing: 1.5 });
    doc.fontSize(18).fillColor(LIGHT).font('Helvetica-Bold')
        .text('Draft Individual Tax Review Pack', 66, 82);
    doc.fontSize(8).fillColor(WARN).font('Helvetica-Bold')
        .text('⚠  DRAFT ESTIMATE ONLY — ACCOUNTANT REVIEW REQUIRED — NOT SARS-FINAL', 66, 108);
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
        .text(`Pack: ${pack.pack_name}   |   Status: ${pack.pack_status}   |   Generated: ${genDate}`, 66, 122);
    doc.y = 180;
    doc.moveDown(1);

    // ── 2. Client / Taxpayer ──────────────────────────────────────────────────
    heading('2. Client / Taxpayer Details');
    kvRow('Client Name', clientName);
    kvRow('Taxpayer Type', tp.taxpayer_type || '—');
    kvRow('ID / Passport', idNum);
    kvRow('Income Tax Ref', taxRef);
    kvRow('Tax Year', String(tr.tax_year || '—'));
    kvRow('Return Name', tr.return_name || '—');
    doc.moveDown(0.8);

    // ── 3. Readiness ──────────────────────────────────────────────────────────
    heading('3. Tax Return Readiness');
    kvRow('Readiness Score', r.score != null ? r.score + '%' : '—');
    kvRow('Readiness Status', (r.readiness_status || 'unknown').toUpperCase());
    kvRow('Items Required', String(r.required_count || 0));
    kvRow('Items Done', String(r.done_count || 0));
    if (r.blocked_count > 0) kvRow('Blocked Items', String(r.blocked_count));
    kvRow('Return Status', tr.status || '—');
    doc.moveDown(0.8);

    // ── 4. Income ─────────────────────────────────────────────────────────────
    heading('4. Captured Income');
    if ((s.income_entries || []).length === 0) {
        doc.fontSize(9).fillColor(WARN).text('⚠  No income entries captured.');
    } else {
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold');
        const colW = [90, 140, 90, 90, 100];
        const cols = ['Type', 'Description', 'Gross Amount', 'Tax Withheld', 'Reference'];
        let x = 50;
        cols.forEach((c, i) => { doc.text(c, x, doc.y, { width: colW[i] }); x += colW[i]; });
        doc.moveDown(0.4);
        doc.rect(50, doc.y, doc.page.width - 100, 0.5).fillColor('#333').fill();
        doc.moveDown(0.3);

        (s.income_entries || []).forEach(e => {
            doc.fontSize(8).fillColor(LIGHT).font('Helvetica');
            x = 50;
            const row = [e.income_type, e.description || '—', fmt(e.gross_amount, '—'), fmt(e.tax_withheld, '—'), e.source_reference || '—'];
            row.forEach((v, i) => { doc.text(v, x, doc.y, { width: colW[i] }); x += colW[i]; });
            doc.moveDown(0.2);
        });

        doc.rect(50, doc.y, doc.page.width - 100, 0.5).fillColor('#333').fill();
        doc.moveDown(0.3);
        doc.fontSize(8).fillColor(LIGHT).font('Helvetica-Bold')
            .text(`Total Gross:  ${fmt(t.gross_income)}   |   Total Withheld:  ${fmt(t.total_withheld)}`);
    }
    doc.moveDown(0.8);

    // ── 5. Deductions ─────────────────────────────────────────────────────────
    heading('5. Captured Deductions');
    if ((s.deduction_entries || []).length === 0) {
        doc.fontSize(9).fillColor(MUTED).text('No deduction entries captured.');
    } else {
        const colW2 = [90, 170, 90, 140];
        const cols2 = ['Type', 'Description', 'Amount', 'Reference'];
        let x = 50;
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold');
        cols2.forEach((c, i) => { doc.text(c, x, doc.y, { width: colW2[i] }); x += colW2[i]; });
        doc.moveDown(0.4);
        (s.deduction_entries || []).forEach(e => {
            doc.fontSize(8).fillColor(LIGHT).font('Helvetica');
            x = 50;
            [e.deduction_type, e.description || '—', fmt(e.amount, '—'), e.source_reference || '—'].forEach((v, i) => {
                doc.text(v, x, doc.y, { width: colW2[i] }); x += colW2[i];
            });
            doc.moveDown(0.2);
        });
        doc.fontSize(8).fillColor(LIGHT).font('Helvetica-Bold')
            .text(`Total Deductions:  ${fmt(t.total_deductions)}`);
    }
    doc.moveDown(0.8);

    // ── 6. Calculation Summary ────────────────────────────────────────────────
    if (doc.y > 650) doc.addPage();
    heading('6. Draft Calculation Summary');
    if (!calc) {
        doc.fontSize(9).fillColor(WARN).text('⚠  No calculation available. Run a draft calculation first.');
    } else {
        (s.calculation_lines || []).forEach(l => {
            doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(l.label, 50, doc.y, { continued: true, width: 280 });
            doc.fillColor(LIGHT).font('Helvetica-Bold')
                .text(l.amount != null ? fmt(l.amount) : '—', { align: 'right', width: 120, continued: false });
        });
        doc.moveDown(0.4);
        doc.fontSize(9).fillColor(LIGHT).font('Helvetica-Bold')
            .text(`Est. Tax Payable:  ${fmt(t.estimated_tax_payable, '—')}   |   Est. Refund:  ${fmt(t.estimated_refund, '—')}`);
    }
    doc.moveDown(0.8);

    // ── 7. Warning Flags ──────────────────────────────────────────────────────
    heading('7. Warning Flags');
    const warns = s.warning_flags || [];
    if (warns.length === 0) {
        doc.fontSize(8).fillColor(SUCCESS).text('No warning flags.');
    } else {
        warns.forEach(w => {
            doc.fontSize(8).fillColor(WARN).font('Helvetica').text('• ' + w);
        });
    }
    doc.moveDown(0.8);

    // ── 8. Tax Config Source ──────────────────────────────────────────────────
    heading('8. Tax Config Source');
    kvRow('Tax Table Version', s.tax_config_source || '—');
    if (calc) {
        kvRow('Calculation Name', calc.calculation_name || '—');
        kvRow('Calculation Version', 'v' + (calc.calculation_version || '?'));
    }
    if ((s.assumptions || []).length > 0) {
        doc.moveDown(0.4);
        doc.fontSize(8).fillColor(MUTED).font('Helvetica-Bold').text('Assumptions:');
        (s.assumptions || []).forEach(a => {
            doc.fontSize(7).fillColor(MUTED).font('Helvetica').text('• ' + a);
        });
    }
    doc.moveDown(0.8);

    // ── 9. Reviewer Sign-off ──────────────────────────────────────────────────
    if (doc.y > 600) doc.addPage();
    heading('9. Reviewer Sign-off');
    const signY = doc.y + 10;
    doc.fontSize(8).fillColor(MUTED).text('Prepared By:', 50, signY);
    doc.rect(50, signY + 14, 200, 20).strokeColor('#444').stroke();
    doc.text('Date:', 280, signY);
    doc.rect(280, signY + 14, 140, 20).strokeColor('#444').stroke();
    doc.text('Reviewed By:', 50, signY + 40);
    doc.rect(50, signY + 54, 200, 20).strokeColor('#444').stroke();
    doc.text('Date:', 280, signY + 40);
    doc.rect(280, signY + 54, 140, 20).strokeColor('#444').stroke();

    if (pack.approval_notes) {
        doc.y = signY + 90;
        doc.fontSize(8).fillColor(MUTED).text('Approval Notes:');
        doc.fontSize(8).fillColor(LIGHT).text(pack.approval_notes);
    }
    doc.moveDown(2);

    // ── Disclaimer ────────────────────────────────────────────────────────────
    if (doc.y > 680) doc.addPage();
    doc.rect(50, doc.y, doc.page.width - 100, 70).fillColor('#2d2200').fill();
    const dY = doc.y + 8;
    doc.fontSize(8).fillColor(WARN).font('Helvetica-Bold')
        .text('DISCLAIMER', 58, dY);
    doc.fontSize(7).fillColor(WARN).font('Helvetica')
        .text(
            'DRAFT ESTIMATE ONLY — This document is an internal review pack for accountant use. ' +
            'All figures are draft estimates requiring full accountant review. ' +
            'NOT SARS-final, NOT for eFiling. NOT tax advice. Lorenco Practice Management accepts no liability for reliance on this draft output.',
            58, dY + 12, { width: doc.page.width - 116 }
        );

    doc.end();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// CRITICAL: 3-segment routes registered BEFORE 2-segment routes.

// ── POST /:returnId/review-packs/generate ─────────────────────────────────────

router.post('/:returnId/review-packs/generate', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);
    const { calculation_id, pack_name } = req.body;

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });
    if (taxReturn.status === 'cancelled') return res.status(400).json({ error: 'Cannot generate pack for a cancelled return' });

    // Validate calculation_id belongs to this company + return if supplied
    let resolvedCalcId = calculation_id ? parseInt(calculation_id) : null;
    if (resolvedCalcId) {
        const { data: calcCheck } = await supabase
            .from('practice_individual_tax_calculations')
            .select('id')
            .eq('id', resolvedCalcId)
            .eq('company_id', cid)
            .eq('tax_return_id', returnId)
            .single();
        if (!calcCheck) return res.status(400).json({ error: 'calculation_id not found for this return' });
    }

    try {
        const snapshot = await buildSnapshot(cid, taxReturn, resolvedCalcId);

        // Use supplied calc id or the one resolved from snapshot
        if (!resolvedCalcId && snapshot.calculation) {
            resolvedCalcId = snapshot.calculation.id || null;
        }

        const defaultName = `Review Pack — ${taxReturn.return_name} — ${taxReturn.tax_year}`;
        const now = new Date().toISOString();

        const { data: pack, error } = await supabase
            .from('practice_individual_tax_review_packs')
            .insert({
                company_id:          cid,
                tax_return_id:       returnId,
                client_id:           taxReturn.client_id,
                taxpayer_profile_id: taxReturn.taxpayer_profile_id,
                calculation_id:      resolvedCalcId,
                tax_year:            taxReturn.tax_year,
                pack_name:           (pack_name && pack_name.trim()) || defaultName,
                pack_status:         'generated',
                report_generated_at: now,
                report_generated_by: req.user?.id || null,
                warning_flags:       snapshot.warning_flags || [],
                report_snapshot:     snapshot,
                created_by:          req.user?.id || null,
                updated_by:          req.user?.id || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logPackEvent(cid, pack.id, returnId, 'individual_tax_review_pack_generated', {
            new_status:    'generated',
            actor_user_id: req.user?.id,
            metadata: {
                tax_year:       taxReturn.tax_year,
                calculation_id: resolvedCalcId,
                warning_count:  (snapshot.warning_flags || []).length,
            },
        });
        await auditFromReq(req, 'individual_tax_review_pack_generated', {
            pack_id: pack.id, tax_return_id: returnId,
        });

        res.status(201).json({ pack });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /review-packs/:id/report-data ────────────────────────────────────────

router.get('/review-packs/:id/report-data', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });

    await logPackEvent(cid, pack.id, pack.tax_return_id, 'individual_tax_review_pack_report_viewed', {
        actor_user_id: req.user?.id,
        metadata: { format: 'data' },
    });

    res.json({ pack, snapshot: pack.report_snapshot });
});

// ── GET /review-packs/:id/report-html ────────────────────────────────────────

router.get('/review-packs/:id/report-html', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });

    const snapshot = pack.report_snapshot || {};
    const html = buildReportHtml(pack, snapshot);

    await logPackEvent(cid, pack.id, pack.tax_return_id, 'individual_tax_review_pack_report_viewed', {
        actor_user_id: req.user?.id,
        metadata: { format: 'html' },
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ── GET /review-packs/:id/report-pdf ─────────────────────────────────────────

router.get('/review-packs/:id/report-pdf', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });

    const snapshot = pack.report_snapshot || {};

    await logPackEvent(cid, pack.id, pack.tax_return_id, 'individual_tax_review_pack_report_viewed', {
        actor_user_id: req.user?.id,
        metadata: { format: 'pdf' },
    });

    streamReportPdf(pack, snapshot, res);
});

// ── PUT /review-packs/:id/submit-review ──────────────────────────────────────

router.put('/review-packs/:id/submit-review', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });
    if (!['generated', 'draft', 'rejected'].includes(pack.pack_status))
        return res.status(400).json({ error: `Cannot submit for review — current status is "${pack.pack_status}"` });

    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
        .from('practice_individual_tax_review_packs')
        .update({ pack_status: 'ready_for_review', updated_at: now, updated_by: req.user?.id || null })
        .eq('id', packId)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, pack.id, pack.tax_return_id, 'individual_tax_review_pack_submitted_review', {
        old_status: pack.pack_status, new_status: 'ready_for_review',
        actor_user_id: req.user?.id,
    });
    await auditFromReq(req, 'individual_tax_review_pack_submitted_review', { pack_id: packId });

    res.json({ pack: updated });
});

// ── PUT /review-packs/:id/approve ────────────────────────────────────────────

router.put('/review-packs/:id/approve', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);
    const { approval_notes } = req.body;

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });
    if (!['ready_for_review', 'reviewed'].includes(pack.pack_status))
        return res.status(400).json({ error: `Cannot approve — status must be ready_for_review or reviewed, got "${pack.pack_status}"` });

    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
        .from('practice_individual_tax_review_packs')
        .update({
            pack_status:    'approved',
            reviewed_at:    now,
            reviewed_by:    req.user?.id || null,
            approval_notes: approval_notes || null,
            updated_at:     now,
            updated_by:     req.user?.id || null,
        })
        .eq('id', packId)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, pack.id, pack.tax_return_id, 'individual_tax_review_pack_approved', {
        old_status: pack.pack_status, new_status: 'approved',
        actor_user_id: req.user?.id,
        notes: approval_notes || null,
    });
    await auditFromReq(req, 'individual_tax_review_pack_approved', { pack_id: packId });

    res.json({ pack: updated });
});

// ── PUT /review-packs/:id/reject ─────────────────────────────────────────────

router.put('/review-packs/:id/reject', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);
    const { rejection_reason } = req.body;

    if (!rejection_reason || !String(rejection_reason).trim())
        return res.status(400).json({ error: 'rejection_reason is required' });

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });
    if (!['ready_for_review', 'reviewed'].includes(pack.pack_status))
        return res.status(400).json({ error: `Cannot reject — status must be ready_for_review or reviewed, got "${pack.pack_status}"` });

    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
        .from('practice_individual_tax_review_packs')
        .update({
            pack_status:      'rejected',
            rejection_reason: String(rejection_reason).trim(),
            updated_at:       now,
            updated_by:       req.user?.id || null,
        })
        .eq('id', packId)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, pack.id, pack.tax_return_id, 'individual_tax_review_pack_rejected', {
        old_status: pack.pack_status, new_status: 'rejected',
        actor_user_id: req.user?.id,
        notes: String(rejection_reason).trim(),
    });
    await auditFromReq(req, 'individual_tax_review_pack_rejected', { pack_id: packId });

    res.json({ pack: updated });
});

// ── GET /review-packs/:id/events ─────────────────────────────────────────────

router.get('/review-packs/:id/events', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_review_pack_events')
        .select('*')
        .eq('review_pack_id', packId)
        .eq('company_id', cid)
        .order('created_at', { ascending: false })
        .limit(100);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ events: data || [] });
});

// ── GET /review-packs/:id ─────────────────────────────────────────────────────

router.get('/review-packs/:id', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });

    res.json({ pack });
});

// ── GET /:returnId/review-packs ───────────────────────────────────────────────

router.get('/:returnId/review-packs', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Tax return not found' });

    const { data, error } = await supabase
        .from('practice_individual_tax_review_packs')
        .select('id, pack_name, pack_status, tax_year, calculation_id, report_generated_at, reviewed_at, warning_flags, created_at, updated_at')
        .eq('tax_return_id', returnId)
        .eq('company_id', cid)
        .neq('pack_status', 'cancelled')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ packs: data || [] });
});

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = router;
