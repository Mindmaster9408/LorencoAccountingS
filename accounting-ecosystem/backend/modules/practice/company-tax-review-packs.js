/* =============================================================
   Practice Company Tax — Review Pack + Draft PDF  (Codebox 33)

   DRAFT / INTERNAL USE ONLY. NOT SARS-final.
   NOT ITR14 submission. NOT eFiling. NOT tax advice.
   All output requires accountant review before any use.

   Routes mounted at /api/practice/company-tax via index.js.
   Route prefix when mounted: all paths are relative to /company-tax.

   Endpoints (specific 3-seg before generic 2-seg):
     POST   /:returnId/review-packs/generate
     GET    /review-packs/:id/report-data          ← 3-seg before 2-seg
     GET    /review-packs/:id/report-html
     GET    /review-packs/:id/report-pdf
     PUT    /review-packs/:id/submit-review
     PUT    /review-packs/:id/approve
     PUT    /review-packs/:id/reject
     GET    /review-packs/:id/events
     GET    /review-packs/:id
     GET    /:returnId/review-packs
   ============================================================= */
'use strict';

const express = require('express');
const router  = express.Router();
const { supabase }     = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (_) { PDFDocument = null; }

// ─── Constants ────────────────────────────────────────────────────────────────

const DONE_RI_STATUSES = ['received', 'captured', 'reviewed', 'waived'];

const ADJ_LABEL = {
    add_back: 'Add Back', deduction: 'Deduction', allowance: 'Allowance',
    disallowance: 'Disallowance', assessed_loss: 'Assessed Loss',
    capital_allowance: 'Capital Allowance', section_24c: 'Section 24C',
    doubtful_debt: 'Doubtful Debt', donation: 'Donation', other: 'Other',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function verifyReturnOwnership(cid, returnId) {
    const { data } = await supabase
        .from('practice_company_tax_returns')
        .select('*')
        .eq('id', returnId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function verifyPackOwnership(cid, packId) {
    const { data } = await supabase
        .from('practice_company_tax_review_packs')
        .select('*')
        .eq('id', packId)
        .eq('company_id', cid)
        .single();
    return data || null;
}

async function logPackEvent(cid, packId, returnId, eventType, extras = {}) {
    try {
        await supabase.from('practice_company_tax_review_pack_events').insert({
            company_id:           cid,
            review_pack_id:       packId,
            company_tax_return_id: returnId,
            event_type:           eventType,
            old_status:           extras.old_status    || null,
            new_status:           extras.new_status    || null,
            actor_user_id:        extras.actor_user_id || null,
            notes:                extras.notes         || null,
            metadata:             extras.metadata      || {},
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

function round2(n) {
    return Math.round(parseFloat(n || 0) * 100) / 100;
}

// ─── Snapshot Builder ─────────────────────────────────────────────────────────
// Pulls all data for the return and creates an immutable snapshot.
// The snapshot drives every subsequent report render — source data changes
// after generation do NOT affect an existing pack.

async function buildSnapshot(cid, taxReturn, calcId) {
    const returnId = taxReturn.id;

    // Client
    const { data: client } = await supabase
        .from('practice_clients')
        .select('id, display_name, company_name, client_type')
        .eq('id', taxReturn.client_id)
        .eq('company_id', cid)
        .single();

    // Taxpayer profile — use registration_number and income_tax_reference
    const { data: profile } = await supabase
        .from('practice_taxpayer_profiles')
        .select('id, taxpayer_type, income_tax_reference, registration_number, financial_year_end, notes')
        .eq('id', taxReturn.taxpayer_profile_id)
        .eq('company_id', cid)
        .single();

    // Tax adjustments
    const { data: adjRows } = await supabase
        .from('practice_company_tax_adjustments')
        .select('id, adjustment_type, description, amount, category, tax_effect, source_reference, notes')
        .eq('company_tax_return_id', returnId)
        .eq('company_id', cid)
        .order('adjustment_type')
        .order('created_at');

    const adjustments = adjRows || [];

    // Readiness items
    const { data: riRows } = await supabase
        .from('practice_company_tax_readiness_items')
        .select('item_type, item_label, item_status, notes')
        .eq('company_tax_return_id', returnId)
        .eq('company_id', cid)
        .order('created_at');

    const readiness_items = riRows || [];

    // Latest calculation — prefer supplied calcId, else latest non-cancelled
    let calculation = null;
    if (calcId) {
        const { data: c } = await supabase
            .from('practice_company_tax_calculations')
            .select('*')
            .eq('id', calcId)
            .eq('company_id', cid)
            .single();
        calculation = c || null;
    }
    if (!calculation) {
        const { data: calcs } = await supabase
            .from('practice_company_tax_calculations')
            .select('*')
            .eq('company_tax_return_id', returnId)
            .eq('company_id', cid)
            .neq('calculation_status', 'cancelled')
            .order('calculation_version', { ascending: false })
            .limit(1);
        calculation = (calcs && calcs.length > 0) ? calcs[0] : null;
    }

    // Readiness scoring from items
    const required  = readiness_items.filter(i => i.item_status !== 'not_applicable');
    const done      = required.filter(i => DONE_RI_STATUSES.includes(i.item_status));
    const blocked   = required.filter(i => i.item_status === 'blocked');
    const score     = required.length > 0 ? Math.round((done.length / required.length) * 100) : null;
    let readiness_status = 'unknown';
    if (required.length > 0) {
        if (blocked.length > 0)   readiness_status = 'blocked';
        else if (score >= 85)     readiness_status = 'ready';
        else if (score >= 50)     readiness_status = 'partial';
        else                      readiness_status = 'incomplete';
    }

    // AFS fields from the return row
    const afs = {
        accounting_profit_loss:         round2(taxReturn.accounting_profit_loss),
        turnover:                        round2(taxReturn.turnover),
        cost_of_sales:                   round2(taxReturn.cost_of_sales),
        gross_profit:                    round2(taxReturn.gross_profit),
        operating_expenses:              round2(taxReturn.operating_expenses),
        finance_costs:                   round2(taxReturn.finance_costs),
        other_income:                    round2(taxReturn.other_income),
        assessed_loss_brought_forward:   round2(taxReturn.assessed_loss_brought_forward),
        assessed_loss_utilised:          round2(taxReturn.assessed_loss_utilised),
        assessed_loss_carried_forward:   round2(taxReturn.assessed_loss_carried_forward),
    };

    // Adjustment totals (must match company-tax-calculations.js logic)
    const add_back_total     = adjustments.filter(a => a.adjustment_type === 'add_back')
        .reduce((s, a) => s + round2(a.amount), 0);
    const disallowance_total = adjustments.filter(a => a.adjustment_type === 'disallowance')
        .reduce((s, a) => s + round2(a.amount), 0);
    const deduction_total    = adjustments.filter(a => a.adjustment_type === 'deduction')
        .reduce((s, a) => s + round2(a.amount), 0);
    const allowance_total    = adjustments.filter(a =>
        ['allowance', 'capital_allowance', 'section_24c', 'doubtful_debt', 'donation'].includes(a.adjustment_type)
    ).reduce((s, a) => s + round2(a.amount), 0);

    return {
        generated_at:      new Date().toISOString(),
        tax_return:        taxReturn,
        client:            client   || null,
        taxpayer_profile:  profile  || null,
        adjustments,
        readiness_items,
        calculation,
        readiness: {
            score,
            readiness_status,
            required_count: required.length,
            done_count:     done.length,
            blocked_count:  blocked.length,
        },
        afs,
        adjustment_totals: {
            add_back_total:     round2(add_back_total),
            disallowance_total: round2(disallowance_total),
            deduction_total:    round2(deduction_total),
            allowance_total:    round2(allowance_total),
        },
        warning_flags:     calculation ? (calculation.warning_flags || []) : ['NO_CALCULATION_AVAILABLE'],
        assumptions:       calculation ? (calculation.assumptions    || []) : [],
        calculation_lines: calculation ? (calculation.calculation_lines || []) : [],
        tax_config_source: calculation ? (calculation.tax_config_version || 'PLACEHOLDER_27PCT') : 'no_calculation',
    };
}

// ─── HTML Report Builder ──────────────────────────────────────────────────────

function buildReportHtml(pack, snapshot) {
    const s   = snapshot;
    const r   = s.readiness    || {};
    const tp  = s.taxpayer_profile || {};
    const cl  = s.client       || {};
    const tr  = s.tax_return   || {};
    const afs = s.afs          || {};
    const at  = s.adjustment_totals || {};
    const calc = s.calculation;

    const clientName   = cl.display_name || cl.company_name || ('Client #' + (tr.client_id || '—'));
    const taxpayerType = tp.taxpayer_type || 'company';
    const taxRef       = tp.income_tax_reference || '—';
    const regNum       = tp.registration_number  || '—';
    const fyStart      = tr.financial_year_start ? tr.financial_year_start.substring(0, 10) : '—';
    const fyEnd        = tr.financial_year_end   ? tr.financial_year_end.substring(0, 10)   : '—';

    const generatedDate = pack.report_generated_at
        ? new Date(pack.report_generated_at).toLocaleString('en-ZA')
        : new Date().toLocaleString('en-ZA');

    // ── Adjustment rows ────────────────────────────────────────────────────────
    const adjRows = (s.adjustments || []).map(a =>
        `<tr>
            <td>${esc(ADJ_LABEL[a.adjustment_type] || a.adjustment_type)}</td>
            <td>${esc(a.description || '—')}</td>
            <td style="text-align:right">${fmt(a.amount)}</td>
            <td style="font-size:11px;color:#888">${esc(a.tax_effect || '—')}</td>
            <td style="font-size:11px">${esc(a.source_reference || '—')}</td>
        </tr>`
    ).join('');

    // ── Calculation lines rows ─────────────────────────────────────────────────
    const calcLineRows = (s.calculation_lines || []).map(l =>
        `<tr${l.is_total ? ' style="font-weight:700;border-top:1px solid #444"' : ''}>
            <td>${esc(l.label)}</td>
            <td style="text-align:right">${l.amount != null ? fmt(l.amount) : (l.note ? '<em style="color:#aaa;font-size:11px">' + esc(l.note) + '</em>' : '—')}</td>
            <td style="font-size:11px;color:#888">${l.amount != null ? esc(l.note || '') : ''}</td>
        </tr>`
    ).join('');

    // ── Warning flag chips ─────────────────────────────────────────────────────
    const warnChips = (s.warning_flags || []).map(w =>
        `<span style="display:inline-block;background:#2d2200;color:#f2c94c;border:1px solid #7a5c00;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:600;margin:2px;letter-spacing:.03em">${esc(w)}</span>`
    ).join('');

    // ── Assumption items ───────────────────────────────────────────────────────
    const assumptionItems = (s.assumptions || []).map(a =>
        `<li style="color:#aaa;font-size:12px;margin-bottom:4px">${esc(a)}</li>`
    ).join('');

    // ── Calculation summary section ────────────────────────────────────────────
    const calcSection = calc
        ? `<section style="margin-bottom:28px">
            <h2>6. Draft Calculation Summary</h2>
            ${(s.calculation_lines || []).length > 0
                ? `<table>
                    <thead><tr>
                        <th>Line</th>
                        <th style="text-align:right">Amount</th>
                        <th>Note</th>
                    </tr></thead>
                    <tbody>${calcLineRows}</tbody>
                </table>`
                : '<p style="color:#f2c94c;font-size:13px">⚠ Calculation lines not available.</p>'
            }
            <div style="margin-top:14px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
                <div style="background:#0d1f2a;border-radius:6px;padding:12px">
                    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Taxable Income Est.</div>
                    <div style="font-size:16px;font-weight:700;color:#eee">${fmt(calc.taxable_income_estimate, '—')}</div>
                </div>
                <div style="background:${parseFloat(calc.estimated_tax_payable || 0) > 0 ? '#3a1a1a' : '#0d2918'};border-radius:6px;padding:12px">
                    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Est. Tax Payable</div>
                    <div style="font-size:16px;font-weight:700;color:${parseFloat(calc.estimated_tax_payable || 0) > 0 ? '#eb5757' : '#27ae60'}">${fmt(calc.estimated_tax_payable, '—')}</div>
                </div>
                <div style="background:${parseFloat(calc.estimated_refund || 0) > 0 ? '#0d2918' : '#1e1e2a'};border-radius:6px;padding:12px">
                    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Est. Refund</div>
                    <div style="font-size:16px;font-weight:700;color:${parseFloat(calc.estimated_refund || 0) > 0 ? '#27ae60' : '#aaa'}">${fmt(calc.estimated_refund, '—')}</div>
                </div>
            </div>
            <div style="margin-top:10px;font-size:11px;color:#888">
                Calc: ${esc(calc.calculation_name)} &nbsp;|&nbsp;
                v${esc(calc.calculation_version)} &nbsp;|&nbsp;
                Status: ${esc(calc.calculation_status)} &nbsp;|&nbsp;
                Rate: ${calc.company_tax_rate != null ? (parseFloat(calc.company_tax_rate) * 100).toFixed(0) + '%' : 'n/a'}
            </div>
        </section>`
        : `<section style="margin-bottom:28px">
            <h2>6. Draft Calculation Summary</h2>
            <p style="color:#f2c94c;font-size:13px">⚠ No calculation has been run for this return yet. Run a draft calculation first, then regenerate this pack to include figures.</p>
        </section>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Draft Company Tax Review Pack — ${esc(clientName)} — ${esc(tr.tax_year)}</title>
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
    .afs-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:8px}
    .afs-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid #1e1e1e}
    .afs-label{font-size:12px;color:#aaa}
    .afs-val{font-size:12px;color:#eee;font-variant-numeric:tabular-nums;font-weight:500}
    @media print{body{background:#fff;color:#000}.report-wrap{padding:0}th,td{border-color:#ccc}h2{color:#1a3a6a}.afs-label,.afs-val{color:#000}}
</style>
</head>
<body>
<div class="report-wrap">

    <!-- ── 1. Header ─────────────────────────────────────────────────── -->
    <div style="background:#1a2540;border:1px solid #2a4080;border-radius:8px;padding:20px 24px;margin-bottom:28px">
        <div style="font-size:10px;color:#7bb8f8;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px">Lorenco Practice Management</div>
        <div style="font-size:22px;font-weight:700;color:#eee;margin-bottom:6px">Draft Company Tax Review Pack</div>
        <div style="font-size:11px;color:#f2c94c;font-weight:600;letter-spacing:.04em;margin-bottom:4px">
            ⚠ DRAFT COMPANY TAX ESTIMATE ONLY — Accountant review required. NOT SARS-final. NOT for submission.
        </div>
        <div style="font-size:11px;color:#888">
            Pack: ${esc(pack.pack_name)} &nbsp;|&nbsp;
            Status: ${esc(pack.pack_status)} &nbsp;|&nbsp;
            Generated: ${esc(generatedDate)}
        </div>
    </div>

    <!-- ── 2. Client / Company Details ───────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>2. Client / Company Details</h2>
        <div class="kv-grid">
            <div><div class="kv-label">Client Name</div><div class="kv-val">${esc(clientName)}</div></div>
            <div><div class="kv-label">Taxpayer Type</div><div class="kv-val">${esc(taxpayerType)}</div></div>
            <div><div class="kv-label">Company Registration No.</div><div class="kv-val">${esc(regNum)}</div></div>
            <div><div class="kv-label">Income Tax Reference</div><div class="kv-val">${esc(taxRef)}</div></div>
            <div><div class="kv-label">Tax Year</div><div class="kv-val">${esc(tr.tax_year)}</div></div>
            <div><div class="kv-label">Return Name</div><div class="kv-val">${esc(tr.return_name || '—')}</div></div>
            <div><div class="kv-label">Financial Year Start</div><div class="kv-val">${esc(fyStart)}</div></div>
            <div><div class="kv-label">Financial Year End</div><div class="kv-val">${esc(fyEnd)}</div></div>
        </div>
    </section>

    <!-- ── 3. Return Readiness ────────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>3. Return Readiness</h2>
        <div class="kv-grid">
            <div><div class="kv-label">Readiness Score</div><div class="kv-val" style="font-size:20px;font-weight:700">${r.score != null ? r.score + '%' : '—'}</div></div>
            <div><div class="kv-label">Readiness Status</div><div class="kv-val" style="font-size:14px;font-weight:600;color:${r.readiness_status === 'ready' ? '#27ae60' : r.readiness_status === 'blocked' ? '#eb5757' : '#f2c94c'}">${esc(r.readiness_status || 'unknown')}</div></div>
            <div><div class="kv-label">Items Required</div><div class="kv-val">${r.required_count || 0}</div></div>
            <div><div class="kv-label">Items Done</div><div class="kv-val">${r.done_count || 0}</div></div>
            ${r.blocked_count > 0 ? `<div><div class="kv-label" style="color:#eb5757">Blocked Items</div><div class="kv-val" style="color:#eb5757">${r.blocked_count}</div></div>` : ''}
            <div><div class="kv-label">Return Status</div><div class="kv-val">${esc(tr.status || '—')}</div></div>
        </div>
        ${(s.readiness_items || []).filter(i => i.item_status === 'blocked').length > 0
            ? `<div style="background:#2a0a0a;border:1px solid #5a1a1a;border-radius:6px;padding:10px 12px;margin-top:8px">
                <div style="font-size:10px;color:#f87171;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Blocked Items</div>
                ${(s.readiness_items || []).filter(i => i.item_status === 'blocked').map(i =>
                    `<div style="font-size:12px;color:#fca5a5;margin-bottom:3px">• ${esc(i.item_label || i.item_type)}: ${esc(i.notes || '—')}</div>`
                ).join('')}
            </div>`
            : ''}
    </section>

    <!-- ── 4. AFS Input Summary ───────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>4. AFS Input Summary</h2>
        <div style="background:#0d1117;border-radius:6px;padding:14px 16px">
            <div class="afs-row"><span class="afs-label">Turnover</span><span class="afs-val">${afs.turnover ? fmt(afs.turnover) : '—'}</span></div>
            <div class="afs-row"><span class="afs-label">Less: Cost of Sales</span><span class="afs-val">${afs.cost_of_sales ? fmt(afs.cost_of_sales) : '—'}</span></div>
            <div class="afs-row" style="font-weight:600"><span class="afs-label" style="color:#eee">Gross Profit</span><span class="afs-val" style="color:#eee">${afs.gross_profit ? fmt(afs.gross_profit) : '—'}</span></div>
            <div class="afs-row"><span class="afs-label">Other Income</span><span class="afs-val">${afs.other_income ? fmt(afs.other_income) : '—'}</span></div>
            <div class="afs-row"><span class="afs-label">Less: Operating Expenses</span><span class="afs-val">${afs.operating_expenses ? fmt(afs.operating_expenses) : '—'}</span></div>
            <div class="afs-row"><span class="afs-label">Less: Finance Costs</span><span class="afs-val">${afs.finance_costs ? fmt(afs.finance_costs) : '—'}</span></div>
            <div class="afs-row" style="font-weight:700;border-bottom:none"><span class="afs-label" style="color:#7bb8f8">Accounting Profit / (Loss)</span><span class="afs-val" style="color:#7bb8f8;font-size:14px">${afs.accounting_profit_loss != null ? fmt(afs.accounting_profit_loss) : '—'}</span></div>
        </div>
        ${afs.accounting_profit_loss == null
            ? `<p style="color:#f2c94c;font-size:12px;margin-top:8px">⚠ Accounting profit/loss not captured. Run a draft calculation after capturing AFS inputs.</p>`
            : ''}

        <div style="margin-top:12px">
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Assessed Loss Schedule</div>
            <div class="afs-row"><span class="afs-label">Assessed Loss Brought Forward</span><span class="afs-val">${afs.assessed_loss_brought_forward ? fmt(afs.assessed_loss_brought_forward) : '—'}</span></div>
            <div class="afs-row"><span class="afs-label">Less: Assessed Loss Utilised</span><span class="afs-val">${afs.assessed_loss_utilised ? fmt(afs.assessed_loss_utilised) : '—'}</span></div>
            <div class="afs-row" style="font-weight:600;border-bottom:none"><span class="afs-label" style="color:#eee">Assessed Loss Carried Forward</span><span class="afs-val" style="color:#eee">${afs.assessed_loss_carried_forward ? fmt(afs.assessed_loss_carried_forward) : '—'}</span></div>
        </div>
    </section>

    <!-- ── 5. Tax Adjustments ────────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>5. Tax Adjustments</h2>
        ${(s.adjustments || []).length > 0
            ? `<table>
                <thead><tr>
                    <th>Type</th><th>Description</th>
                    <th style="text-align:right">Amount</th>
                    <th>Tax Effect</th>
                    <th>Reference</th>
                </tr></thead>
                <tbody>${adjRows}</tbody>
                <tfoot>
                    <tr>
                        <td colspan="2" style="font-weight:600;color:#eee;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.04em">Add-backs</td>
                        <td style="text-align:right;font-weight:700;color:#fcd34d">${fmt(at.add_back_total)}</td>
                        <td colspan="2"></td>
                    </tr>
                    <tr>
                        <td colspan="2" style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.04em">Disallowances</td>
                        <td style="text-align:right;font-weight:700;color:#fca5a5">${fmt(at.disallowance_total)}</td>
                        <td colspan="2"></td>
                    </tr>
                    <tr>
                        <td colspan="2" style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.04em">Deductions</td>
                        <td style="text-align:right;font-weight:700;color:#6ee7b7">${fmt(at.deduction_total)}</td>
                        <td colspan="2"></td>
                    </tr>
                    <tr>
                        <td colspan="2" style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.04em">Allowances</td>
                        <td style="text-align:right;font-weight:700;color:#93c5fd">${fmt(at.allowance_total)}</td>
                        <td colspan="2"></td>
                    </tr>
                </tfoot>
            </table>`
            : `<p style="color:#f2c94c;font-size:13px">⚠ No tax adjustments captured for this return.</p>`}
    </section>

    <!-- ── 6. Draft Calculation Summary ──────────────────────────────── -->
    ${calcSection}

    <!-- ── 7. Warning Flags ───────────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>7. Warning Flags</h2>
        ${(s.warning_flags || []).length > 0
            ? `<div>${warnChips}</div>`
            : `<p style="color:#27ae60;font-size:13px">No warning flags.</p>`}
    </section>

    <!-- ── 8. Assumptions ────────────────────────────────────────────── -->
    <section style="margin-bottom:28px">
        <h2>8. Assumptions &amp; Tax Config</h2>
        <div class="kv-grid">
            <div><div class="kv-label">Tax Config Source</div><div class="kv-val">${esc(s.tax_config_source)}</div></div>
            ${calc
                ? `<div><div class="kv-label">Calculation Name</div><div class="kv-val">${esc(calc.calculation_name)}</div></div>
                   <div><div class="kv-label">Calculation Version</div><div class="kv-val">v${esc(calc.calculation_version)}</div></div>
                   <div><div class="kv-label">Calculation Status</div><div class="kv-val">${esc(calc.calculation_status)}</div></div>
                   <div><div class="kv-label">Normal Tax Rate</div><div class="kv-val">${calc.company_tax_rate != null ? (parseFloat(calc.company_tax_rate) * 100).toFixed(0) + '% (placeholder — verify with SARS)' : '—'}</div></div>`
                : ''}
        </div>
        ${(s.assumptions || []).length > 0
            ? `<div style="margin-top:10px"><div class="kv-label" style="margin-bottom:6px">Assumptions Applied</div><ul style="padding-left:18px">${assumptionItems}</ul></div>`
            : ''}
        <div style="margin-top:12px;font-size:11px;color:#888;line-height:1.7">
            <strong style="color:#aaa">Unsupported areas (not included in this estimate):</strong><br>
            Small Business Corporation (SBC) progressive rates &nbsp;|&nbsp;
            Capital Gains Tax (CGT) &nbsp;|&nbsp;
            Dividends Tax &nbsp;|&nbsp;
            Multi-year assessed loss ring-fencing rules &nbsp;|&nbsp;
            Micro-business rules
        </div>
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
                <div class="kv-val" style="min-height:32px;border-bottom:1px solid #444;padding-bottom:4px">${esc(pack.reviewed_at ? 'See audit log' : '')}</div>
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
            DRAFT COMPANY TAX ESTIMATE ONLY — This document is an internal review pack prepared for accountant use.
            All figures are draft estimates and require full accountant review before any use.
            This document is NOT SARS-final, NOT suitable for ITR14 or eFiling submission, and does NOT constitute
            tax advice. The 27% tax rate used is a placeholder — the actual rate applicable to this entity must
            be verified. All calculations must be verified against SARS published rates, client-specific
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
        res.status(501).json({ error: 'PDFKit not installed. HTML report is available at /report-html instead.' });
        return;
    }

    const s   = snapshot;
    const r   = s.readiness    || {};
    const tp  = s.taxpayer_profile || {};
    const cl  = s.client       || {};
    const tr  = s.tax_return   || {};
    const afs = s.afs          || {};
    const at  = s.adjustment_totals || {};
    const calc = s.calculation;

    const clientName = cl.display_name || cl.company_name || ('Client #' + (tr.client_id || '—'));
    const taxRef     = tp.income_tax_reference || '—';
    const regNum     = tp.registration_number  || '—';
    const genDate    = pack.report_generated_at
        ? new Date(pack.report_generated_at).toLocaleString('en-ZA')
        : new Date().toLocaleString('en-ZA');

    const filename = `draft-co-tax-review-${tr.tax_year}-${(clientName || 'client').replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    const DARK    = '#111111';
    const LIGHT   = '#eeeeee';
    const MUTED   = '#888888';
    const ACCENT  = '#4a9edd';
    const WARN    = '#f2c94c';
    const DANGER  = '#eb5757';
    const SUCCESS = '#27ae60';

    function section(text) {
        doc.moveDown(0.5);
        doc.rect(50, doc.y, doc.page.width - 100, 1).fillColor('#333333').fill();
        doc.moveDown(0.3);
        doc.fontSize(9).fillColor(ACCENT).font('Helvetica-Bold')
            .text(text.toUpperCase(), { characterSpacing: 1 });
        doc.moveDown(0.4);
    }

    function kv(label, value) {
        doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(label, { continued: true, width: 180 });
        doc.fillColor(LIGHT).font('Helvetica').text(String(value || '—'));
    }

    function afsFigure(label, value) {
        doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(label, { continued: true, width: 260 });
        doc.fillColor(LIGHT).text(value != null ? fmt(value) : '—');
    }

    // ── Cover ──────────────────────────────────────────────────────────────────
    doc.rect(50, 50, doc.page.width - 100, 110).fillColor('#1a2540').fill();
    doc.fontSize(8).fillColor('#7bb8f8').font('Helvetica-Bold')
        .text('LORENCO PRACTICE MANAGEMENT', 66, 66, { characterSpacing: 1.5 });
    doc.fontSize(18).fillColor(LIGHT).font('Helvetica-Bold')
        .text('Draft Company Tax Review Pack', 66, 82);
    doc.fontSize(8).fillColor(WARN).font('Helvetica-Bold')
        .text('⚠  DRAFT ESTIMATE ONLY — ACCOUNTANT REVIEW REQUIRED — NOT SARS-FINAL', 66, 108);
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
        .text(`Pack: ${pack.pack_name}   |   Status: ${pack.pack_status}   |   Generated: ${genDate}`, 66, 122);
    doc.y = 175;

    // ── 2. Client details ──────────────────────────────────────────────────────
    section('2. Client / Company Details');
    kv('Client Name',              clientName);
    kv('Taxpayer Type',            tp.taxpayer_type || '—');
    kv('Company Registration No.', regNum);
    kv('Income Tax Reference',     taxRef);
    kv('Tax Year',                 tr.tax_year || '—');
    kv('Return Name',              tr.return_name || '—');
    kv('Financial Year',           `${(tr.financial_year_start || '—').substring(0,10)} to ${(tr.financial_year_end || '—').substring(0,10)}`);

    // ── 3. Readiness ──────────────────────────────────────────────────────────
    section('3. Return Readiness');
    kv('Readiness Score',   r.score != null ? r.score + '%' : '—');
    kv('Readiness Status',  r.readiness_status || '—');
    kv('Items Required',    String(r.required_count || 0));
    kv('Items Done',        String(r.done_count || 0));
    if (r.blocked_count > 0) {
        doc.fontSize(8).fillColor(DANGER).text('Blocked Items: ' + r.blocked_count);
    }
    kv('Return Status', tr.status || '—');

    // ── 4. AFS Input Summary ──────────────────────────────────────────────────
    section('4. AFS Input Summary');
    afsFigure('Turnover',                      afs.turnover);
    afsFigure('Less: Cost of Sales',           afs.cost_of_sales);
    afsFigure('Gross Profit',                  afs.gross_profit);
    afsFigure('Other Income',                  afs.other_income);
    afsFigure('Less: Operating Expenses',      afs.operating_expenses);
    afsFigure('Less: Finance Costs',           afs.finance_costs);
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor(ACCENT).font('Helvetica-Bold').text('Accounting Profit / (Loss)', { continued: true, width: 260 });
    doc.fillColor(LIGHT).text(afs.accounting_profit_loss != null ? fmt(afs.accounting_profit_loss) : '—');
    doc.moveDown(0.4);
    afsFigure('Assessed Loss B/F',              afs.assessed_loss_brought_forward);
    afsFigure('Less: Assessed Loss Utilised',   afs.assessed_loss_utilised);
    afsFigure('Assessed Loss C/F',              afs.assessed_loss_carried_forward);

    // ── 5. Tax Adjustments ────────────────────────────────────────────────────
    section('5. Tax Adjustments');
    const adjs = s.adjustments || [];
    if (adjs.length === 0) {
        doc.fontSize(8).fillColor(WARN).text('No tax adjustments captured.');
    } else {
        adjs.forEach(a => {
            doc.fontSize(8).fillColor(MUTED).font('Helvetica')
                .text((ADJ_LABEL[a.adjustment_type] || a.adjustment_type) + ': ', { continued: true, width: 220 });
            doc.fillColor(LIGHT).text(String(a.description || '—'), { continued: true, width: 160 });
            doc.text('  ' + fmt(a.amount));
        });
        doc.moveDown(0.4);
        kv('Add-backs Total',     fmt(at.add_back_total));
        kv('Disallowances Total', fmt(at.disallowance_total));
        kv('Deductions Total',    fmt(at.deduction_total));
        kv('Allowances Total',    fmt(at.allowance_total));
    }

    // ── 6. Draft Calculation ──────────────────────────────────────────────────
    section('6. Draft Calculation Summary');
    if (!calc) {
        doc.fontSize(8).fillColor(WARN).text('No calculation available — run a draft calculation and regenerate this pack.');
    } else {
        const lines = s.calculation_lines || [];
        lines.forEach(l => {
            const isTotal = l.is_total;
            doc.fontSize(isTotal ? 9 : 8)
               .fillColor(isTotal ? LIGHT : MUTED)
               .font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
               .text(String(l.label), { continued: true, width: 280 });
            const valText = l.amount != null ? fmt(l.amount) : (l.note || '—');
            doc.fillColor(isTotal ? LIGHT : MUTED).text(valText);
        });
        doc.moveDown(0.4);
        kv('Normal Tax Rate',     calc.company_tax_rate != null ? (parseFloat(calc.company_tax_rate) * 100).toFixed(0) + '% (placeholder)' : '—');
        kv('Normal Tax Estimate', fmt(calc.normal_tax_estimate));
        kv('Est. Tax Payable',    fmt(calc.estimated_tax_payable));
        kv('Est. Refund',         fmt(calc.estimated_refund));
    }

    // ── 7. Warning Flags ──────────────────────────────────────────────────────
    section('7. Warning Flags');
    const flags = s.warning_flags || [];
    if (flags.length === 0) {
        doc.fontSize(8).fillColor(SUCCESS).text('No warning flags.');
    } else {
        flags.forEach(f => {
            doc.fontSize(8).fillColor(WARN).font('Helvetica').text('⚠  ' + String(f));
        });
    }

    // ── 8. Assumptions ────────────────────────────────────────────────────────
    section('8. Assumptions & Tax Config');
    kv('Tax Config Source', s.tax_config_source || '—');
    if (calc) {
        kv('Calculation Name',    calc.calculation_name);
        kv('Calculation Version', 'v' + calc.calculation_version);
    }
    const assumptions = s.assumptions || [];
    if (assumptions.length > 0) {
        doc.moveDown(0.3);
        doc.fontSize(8).fillColor(MUTED).text('Assumptions applied:');
        assumptions.forEach(a => {
            doc.fontSize(8).fillColor(MUTED).font('Helvetica').text('• ' + String(a));
        });
    }
    doc.moveDown(0.3);
    doc.fontSize(7).fillColor(MUTED).font('Helvetica').text(
        'Not included: SBC progressive rates | CGT | Dividends Tax | Multi-year assessed loss ring-fencing | Micro-business rules'
    );

    // ── 9. Reviewer Sign-off ──────────────────────────────────────────────────
    if (doc.y > 680) doc.addPage();
    section('9. Reviewer Sign-off');
    kv('Prepared By',  '');
    kv('Date',         '');
    doc.moveDown(0.5);
    kv('Reviewed By',  pack.reviewed_at ? 'See audit log' : '');
    kv('Date Reviewed', pack.reviewed_at ? new Date(pack.reviewed_at).toLocaleString('en-ZA') : '');
    if (pack.approval_notes) {
        doc.moveDown(0.3);
        doc.fontSize(8).fillColor(MUTED).text('Approval Notes: ', { continued: true });
        doc.fillColor(LIGHT).text(String(pack.approval_notes));
    }

    // ── 10. Disclaimer ────────────────────────────────────────────────────────
    if (doc.y > 700) doc.addPage();
    doc.moveDown(1);
    const dY = doc.y;
    doc.rect(50, dY, doc.page.width - 100, 72).fillColor('#2d2200').fill();
    doc.fontSize(7).fillColor(WARN).font('Helvetica-Bold')
        .text('DISCLAIMER', 62, dY + 8, { characterSpacing: 1 });
    doc.fontSize(7).fillColor(WARN).font('Helvetica')
        .text(
            'DRAFT COMPANY TAX ESTIMATE ONLY — internal review pack for accountant use. All figures require full review. ' +
            'NOT SARS-final. NOT suitable for ITR14 or eFiling. NOT tax advice. ' +
            'The 27% rate is a placeholder — verify the applicable rate. ' +
            'Lorenco Practice Management accepts no liability for reliance on this draft output.',
            62, dY + 22, { width: doc.page.width - 124 }
        );

    doc.end();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// CRITICAL: 3-segment routes registered BEFORE 2-segment routes.

// ── POST /:returnId/review-packs/generate ────────────────────────────────────

router.post('/:returnId/review-packs/generate', async (req, res) => {
    const cid      = req.companyId;
    const returnId = parseInt(req.params.returnId);
    const { calculation_id, pack_name } = req.body;

    const taxReturn = await verifyReturnOwnership(cid, returnId);
    if (!taxReturn) return res.status(404).json({ error: 'Company tax return not found' });
    if (taxReturn.status === 'cancelled') return res.status(400).json({ error: 'Cannot generate pack for a cancelled return' });

    // Validate calculation_id belongs to this company + return if supplied
    let resolvedCalcId = calculation_id ? parseInt(calculation_id) : null;
    if (resolvedCalcId) {
        const { data: calcCheck } = await supabase
            .from('practice_company_tax_calculations')
            .select('id')
            .eq('id', resolvedCalcId)
            .eq('company_id', cid)
            .eq('company_tax_return_id', returnId)
            .single();
        if (!calcCheck) return res.status(400).json({ error: 'calculation_id not found for this return' });
    }

    try {
        const snapshot = await buildSnapshot(cid, taxReturn, resolvedCalcId);

        if (!resolvedCalcId && snapshot.calculation) {
            resolvedCalcId = snapshot.calculation.id || null;
        }

        const defaultName = `Company Tax Review Pack — ${taxReturn.return_name} — ${taxReturn.tax_year}`;
        const now = new Date().toISOString();

        const { data: pack, error } = await supabase
            .from('practice_company_tax_review_packs')
            .insert({
                company_id:           cid,
                company_tax_return_id: returnId,
                client_id:            taxReturn.client_id,
                taxpayer_profile_id:  taxReturn.taxpayer_profile_id,
                calculation_id:       resolvedCalcId,
                tax_year:             taxReturn.tax_year,
                pack_name:            (pack_name && pack_name.trim()) || defaultName,
                pack_status:          'generated',
                report_generated_at:  now,
                report_generated_by:  req.user?.id || null,
                warning_flags:        snapshot.warning_flags || [],
                report_snapshot:      snapshot,
                created_by:           req.user?.id || null,
                updated_by:           req.user?.id || null,
            })
            .select()
            .single();
        if (error) throw error;

        await logPackEvent(cid, pack.id, returnId, 'company_tax_review_pack_generated', {
            new_status:    'generated',
            actor_user_id: req.user?.id,
            metadata: {
                tax_year:       taxReturn.tax_year,
                calculation_id: resolvedCalcId,
                warning_count:  (snapshot.warning_flags || []).length,
            },
        });
        await auditFromReq(req, 'company_tax_review_pack_generated', {
            pack_id: pack.id, company_tax_return_id: returnId,
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

    await logPackEvent(cid, pack.id, pack.company_tax_return_id, 'company_tax_review_pack_report_viewed', {
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

    await logPackEvent(cid, pack.id, pack.company_tax_return_id, 'company_tax_review_pack_report_viewed', {
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

    await logPackEvent(cid, pack.id, pack.company_tax_return_id, 'company_tax_review_pack_report_viewed', {
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
        .from('practice_company_tax_review_packs')
        .update({ pack_status: 'ready_for_review', updated_at: now, updated_by: req.user?.id || null })
        .eq('id', packId)
        .eq('company_id', cid)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await logPackEvent(cid, pack.id, pack.company_tax_return_id, 'company_tax_review_pack_submitted_review', {
        old_status: pack.pack_status, new_status: 'ready_for_review',
        actor_user_id: req.user?.id,
    });
    await auditFromReq(req, 'company_tax_review_pack_submitted_review', { pack_id: packId });

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
        .from('practice_company_tax_review_packs')
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

    await logPackEvent(cid, pack.id, pack.company_tax_return_id, 'company_tax_review_pack_approved', {
        old_status: pack.pack_status, new_status: 'approved',
        actor_user_id: req.user?.id,
        notes: approval_notes || null,
    });
    await auditFromReq(req, 'company_tax_review_pack_approved', { pack_id: packId });

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
        .from('practice_company_tax_review_packs')
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

    await logPackEvent(cid, pack.id, pack.company_tax_return_id, 'company_tax_review_pack_rejected', {
        old_status: pack.pack_status, new_status: 'rejected',
        actor_user_id: req.user?.id,
        notes: String(rejection_reason).trim(),
    });
    await auditFromReq(req, 'company_tax_review_pack_rejected', { pack_id: packId });

    res.json({ pack: updated });
});

// ── GET /review-packs/:id/events ─────────────────────────────────────────────

router.get('/review-packs/:id/events', async (req, res) => {
    const cid    = req.companyId;
    const packId = parseInt(req.params.id);

    const pack = await verifyPackOwnership(cid, packId);
    if (!pack) return res.status(404).json({ error: 'Review pack not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_review_pack_events')
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
    if (!taxReturn) return res.status(404).json({ error: 'Company tax return not found' });

    const { data, error } = await supabase
        .from('practice_company_tax_review_packs')
        .select('id, pack_name, pack_status, tax_year, calculation_id, report_generated_at, reviewed_at, warning_flags, created_at, updated_at')
        .eq('company_tax_return_id', returnId)
        .eq('company_id', cid)
        .neq('pack_status', 'cancelled')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ packs: data || [] });
});

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = router;
