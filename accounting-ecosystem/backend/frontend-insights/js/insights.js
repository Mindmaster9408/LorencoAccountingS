/* ============================================================================
 * Insights — owner dashboard (read-only)
 * ============================================================================
 * Browser storage: ONLY the auth token is read ('insights_token', written by
 * the Eco dashboard's SSO launch). Every figure comes from /api/insights and
 * nothing is stored in the browser (CLAUDE.md Part D). The chosen period and
 * slicers live in memory only.
 * ========================================================================== */
(function () {
    'use strict';

    var TOKEN_KEY = 'insights_token';
    var charts = {};
    var state = { from: null, to: null, filters: { store: '', category: '', paymentMethod: '' }, loading: 0 };

    var money = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
    var money2 = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var count = new Intl.NumberFormat('en-ZA');

    var PALETTE = ['#34d399', '#38bdf8', '#a78bfa', '#fbbf24', '#f472b6', '#fb923c', '#22d3ee', '#94a3b8'];

    function $(id) { return document.getElementById(id); }
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    }

    // ── Dates (local calendar, formatted YYYY-MM-DD) ─────────────────────────
    function ymd(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function presetRange(preset) {
        var now = new Date();
        var y = now.getFullYear(), m = now.getMonth();
        switch (preset) {
            case 'last_month': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
            case 'last_3':     return { from: ymd(new Date(y, m - 3, 1)), to: ymd(new Date(y, m, 0)) };
            case 'ytd':        return { from: ymd(new Date(y, 0, 1)), to: ymd(now) };
            case 'last_12':    return { from: ymd(new Date(y, m - 12, 1)), to: ymd(new Date(y, m, 0)) };
            default:           return { from: ymd(new Date(y, m, 1)), to: ymd(now) };
        }
    }
    function niceDate(s) {
        var p = s.split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function monthLabel(key) {
        var p = key.split('-');
        return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' });
    }

    // ── API ──────────────────────────────────────────────────────────────────
    function api(path) {
        var token = getToken();
        if (!token) return Promise.reject({ status: 401 });
        return fetch(path, { headers: { 'Authorization': 'Bearer ' + token } }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                if (!res.ok) return Promise.reject({ status: res.status, body: body });
                return body;
            });
        });
    }

    function showStatus(msg, isError) {
        var el = $('status');
        el.textContent = msg || '';
        el.className = 'status' + (isError ? ' error' : '');
        el.hidden = !msg;
    }

    function handleError(err) {
        if (err && (err.status === 401 || err.status === 403) && !(err.body && err.body.module)) {
            showStatus('Your session has expired. Open Insights again from the Eco dashboard.', true);
        } else if (err && err.status === 403) {
            showStatus((err.body && err.body.message) || 'Insights is not enabled for this company.', true);
        } else {
            showStatus((err && err.body && err.body.error) || 'Could not load the dashboard. Please try again.', true);
        }
    }

    // ── KPI cards ────────────────────────────────────────────────────────────
    function changeHtml(changePct, label, invert) {
        if (changePct == null) return '<span class="flat">—</span> ' + esc(label);
        var good = invert ? changePct < 0 : changePct > 0;
        var cls = changePct === 0 ? 'flat' : (good ? 'up' : 'down');
        var arrow = changePct > 0 ? '▲' : (changePct < 0 ? '▼' : '■');
        return '<span class="' + cls + '">' + arrow + ' ' + Math.abs(changePct).toFixed(1) + '%</span> ' + esc(label);
    }
    function card(o) {
        return '<div class="kpi" style="--kpi-color:' + o.color + '">' +
            '<div class="kpi-top"><span class="kpi-label">' + esc(o.label) + '</span>' +
            '<span class="info" tabindex="0" data-tip="' + esc(o.tip) + '">i</span></div>' +
            '<div class="kpi-value">' + esc(o.value) + '</div>' +
            '<div class="kpi-change">' + o.change + '</div></div>';
    }

    function renderFinance(f, compareLabel) {
        var k = f.kpis;
        var gm = k.grossMarginPct;
        var gmChange = gm.changePts == null ? '<span class="flat">—</span> ' + esc(compareLabel)
            : '<span class="' + (gm.changePts >= 0 ? 'up' : 'down') + '">' + (gm.changePts >= 0 ? '▲ ' : '▼ ') +
              Math.abs(gm.changePts).toFixed(1) + ' pts</span> ' + esc(compareLabel);
        $('financeSource').textContent = f.source;
        $('financeKpis').innerHTML = [
            card({ label: 'Revenue', value: money.format(k.revenue.value), color: '#34d399',
                change: changeHtml(k.revenue.changePct, compareLabel),
                tip: 'Operating income on the Profit & Loss for the period, excl. VAT. Same figure as Ledger Leo\'s P&L.' }),
            card({ label: 'Gross profit', value: money.format(k.grossProfit.value), color: '#38bdf8',
                change: changeHtml(k.grossProfit.changePct, compareLabel),
                tip: 'Revenue − cost of sales.' }),
            card({ label: 'Gross margin', value: gm.value == null ? '—' : gm.value.toFixed(1) + '%', color: '#22d3ee',
                change: gmChange, tip: 'Gross profit ÷ revenue × 100. Change shown in percentage points.' }),
            card({ label: 'Net profit', value: money.format(k.netProfit.value), color: k.netProfit.value >= 0 ? '#4ade80' : '#f87171',
                change: changeHtml(k.netProfit.changePct, compareLabel),
                tip: 'Gross profit + other income − operating expenses − depreciation − finance costs.' }),
            card({ label: 'Cash in bank', value: money.format(k.cash.value), color: '#a78bfa',
                change: changeHtml(k.cash.changePct, compareLabel),
                tip: 'Net balance of all bank and cash accounts at the end of the period (an overdraft lowers it).' }),
            card({ label: 'Debtors (owed to you)', value: money.format(k.debtors.value), color: '#fbbf24',
                change: changeHtml(k.debtors.changePct, compareLabel, true),
                tip: 'Balance of the debtors control accounts at the end of the period.' }),
            card({ label: 'Creditors (you owe)', value: money.format(k.creditors.value), color: '#fb923c',
                change: changeHtml(k.creditors.changePct, compareLabel, true),
                tip: 'Balance of the creditors control accounts at the end of the period.' }),
        ].join('');

        var ds = f.trend.datasets;
        var find = function (label) { return (ds.find(function (d) { return d.label === label; }) || { data: [] }).data; };
        drawChart('financeTrend', {
            data: {
                labels: f.trend.months.map(monthLabel),
                datasets: [
                    { type: 'bar', label: 'Revenue', data: find('Revenue'), backgroundColor: 'rgba(52,211,153,0.55)', borderRadius: 4, order: 3 },
                    { type: 'line', label: 'Gross profit', data: find('Gross Profit'), borderColor: '#38bdf8', backgroundColor: '#38bdf8', tension: 0.3, order: 1 },
                    { type: 'line', label: 'Net profit', data: find('Net Profit'), borderColor: '#fbbf24', backgroundColor: '#fbbf24', tension: 0.3, order: 2 },
                ],
            },
            options: { scales: { y: moneyAxis() } },
        });
    }

    function renderSales(s, compareLabel) {
        var k = s.kpis;
        $('salesSource').textContent = s.source;
        $('salesKpis').innerHTML = [
            card({ label: 'Till sales', value: money.format(k.sales.value), color: '#34d399',
                change: changeHtml(k.sales.changePct, compareLabel),
                tip: 'Total of completed till sales, incl. VAT, after discounts. Voided sales are excluded; returns are shown separately. Will differ from P&L revenue, which is excl. VAT.' }),
            card({ label: 'Orders', value: count.format(k.orders.value), color: '#38bdf8',
                change: changeHtml(k.orders.changePct, compareLabel),
                tip: 'Number of completed sales (receipts).' }),
            card({ label: 'Avg order value', value: money2.format(k.avgOrderValue.value), color: '#a78bfa',
                change: changeHtml(k.avgOrderValue.changePct, compareLabel),
                tip: 'Till sales ÷ orders.' }),
            card({ label: 'Returns / refunds', value: money.format(s.returns.amount), color: '#f87171',
                change: '<span class="flat">' + count.format(s.returns.count) + '</span> refunds in this period',
                tip: 'Refunds processed in the period (all stores, filters not applied). Not deducted from till sales — same as Checkout Charlie\'s sales summary.' }),
        ].join('');

        drawChart('salesTrend', {
            data: {
                labels: s.trend.months.map(monthLabel),
                datasets: [
                    { type: 'bar', label: 'Sales', data: s.trend.sales, backgroundColor: 'rgba(56,189,248,0.6)', borderRadius: 4, yAxisID: 'y', order: 2 },
                    { type: 'line', label: 'Orders', data: s.trend.orders, borderColor: '#fbbf24', backgroundColor: '#fbbf24', tension: 0.3, yAxisID: 'y1', order: 1 },
                ],
            },
            options: { scales: { y: moneyAxis(), y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#94a3b8', precision: 0 } } } },
        });

        // Category donut — top 7 + "Other"
        var cats = s.byCategory.slice(0, 7);
        var rest = s.byCategory.slice(7).reduce(function (sum, c) { return sum + c.amount; }, 0);
        if (rest > 0) cats.push({ label: 'Other', amount: rest });
        $('categoryEmpty').hidden = cats.length > 0;
        $('categoryChart').parentElement.hidden = cats.length === 0;
        drawChart('categoryChart', {
            type: 'doughnut',
            data: { labels: cats.map(function (c) { return c.label; }),
                datasets: [{ data: cats.map(function (c) { return c.amount; }), backgroundColor: PALETTE, borderColor: '#090d18', borderWidth: 2 }] },
            options: { cutout: '62%', plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: pctLabel } } }, scales: {} },
        });

        $('storeEmpty').hidden = s.byStore.length > 0;
        $('storeChart').parentElement.hidden = s.byStore.length === 0;
        drawChart('storeChart', {
            type: 'bar',
            data: { labels: s.byStore.map(function (x) { return x.label; }),
                datasets: [{ label: 'Sales', data: s.byStore.map(function (x) { return x.amount; }), backgroundColor: PALETTE, borderRadius: 4 }] },
            options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: moneyAxis(), y: { ticks: { color: '#cbd5e1' }, grid: { display: false } } } },
        });

        $('topProducts').innerHTML = s.topProducts.length === 0
            ? '<tr><td colspan="5" class="muted">No sales in this period.</td></tr>'
            : s.topProducts.map(function (p, i) {
                var yoy = p.yoyPct == null ? '<span class="muted">new</span>'
                    : '<span class="' + (p.yoyPct >= 0 ? 'up' : 'down') + '">' + (p.yoyPct >= 0 ? '▲ ' : '▼ ') + Math.abs(p.yoyPct).toFixed(1) + '%</span>';
                return '<tr><td>' + (i + 1) + '</td><td>' + esc(p.productName) + '</td><td class="num">' + count.format(p.quantity) +
                    '</td><td class="num">' + money.format(p.revenue) + '</td><td class="num">' + yoy + '</td></tr>';
            }).join('');

        var payTotal = s.paymentMethods.reduce(function (sum, p) { return sum + p.amount; }, 0);
        $('paymentList').innerHTML = s.paymentMethods.length === 0 ? '' :
            '<div class="kpi-label" style="margin-bottom:6px">Payment methods</div>' +
            s.paymentMethods.map(function (p) {
                var pct = payTotal > 0 ? (p.amount / payTotal) * 100 : 0;
                return '<div class="pay-row"><span>' + esc(p.label) + '</span><span>' + money.format(p.amount) + '</span></div>' +
                    '<div class="pay-bar" style="width:' + pct.toFixed(1) + '%"></div>';
            }).join('');

        $('recentSales').innerHTML = s.recentSales.length === 0
            ? '<tr><td colspan="6" class="muted">No sales in this period.</td></tr>'
            : s.recentSales.map(function (r) {
                var d = new Date(r.createdAt);
                return '<tr><td>' + esc(d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) +
                    '</td><td>' + esc(r.saleNumber || '#' + r.id) + '</td><td>' + esc(r.store) + '</td><td class="muted">' + esc(r.categories) +
                    '</td><td class="num">' + count.format(r.quantity) + '</td><td class="num">' + money2.format(r.amount) + '</td></tr>';
            }).join('');

        fillSelect('fStore', s.filterOptions.stores, state.filters.store);
        fillSelect('fCategory', s.filterOptions.categories, state.filters.category);
        fillSelect('fPayment', s.filterOptions.paymentMethods, state.filters.paymentMethod);
    }

    function fillSelect(id, options, selected) {
        var el = $(id);
        el.innerHTML = '<option value="">All</option>' + options.map(function (o) {
            return '<option value="' + esc(o) + '"' + (o === selected ? ' selected' : '') + '>' + esc(o) + '</option>';
        }).join('');
    }

    // ── Charts ───────────────────────────────────────────────────────────────
    function moneyAxis() {
        return { ticks: { color: '#94a3b8', callback: function (v) { return compactMoney(v); } }, grid: { color: 'rgba(255,255,255,0.06)' } };
    }
    function compactMoney(v) {
        var a = Math.abs(v);
        if (a >= 1e6) return 'R' + (v / 1e6).toFixed(1) + 'm';
        if (a >= 1e3) return 'R' + (v / 1e3).toFixed(0) + 'k';
        return 'R' + v;
    }
    function pctLabel(ctx) {
        var total = ctx.dataset.data.reduce(function (s, v) { return s + v; }, 0);
        var pct = total > 0 ? (ctx.parsed / total) * 100 : 0;
        return ' ' + ctx.label + ': ' + money.format(ctx.parsed) + ' (' + pct.toFixed(1) + '%)';
    }
    function drawChart(id, cfg) {
        if (typeof Chart === 'undefined') return; // CDN blocked: numbers still render
        if (charts[id]) charts[id].destroy();
        var base = {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#cbd5e1', boxWidth: 12 } },
                tooltip: { callbacks: { label: function (ctx) {
                    var v = ctx.parsed && typeof ctx.parsed === 'object' ? (ctx.chart.options.indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y) : ctx.parsed;
                    return ' ' + ctx.dataset.label + ': ' + (ctx.dataset.label === 'Orders' ? count.format(v) : money.format(v));
                } } },
            },
            scales: { x: { ticks: { color: '#94a3b8' }, grid: { display: false } } },
        };
        var opts = cfg.options || {};
        var merged = Object.assign({}, base, opts, {
            plugins: Object.assign({}, base.plugins, opts.plugins || {}),
            scales: opts.scales && Object.keys(opts.scales).length === 0 ? {} : Object.assign({}, base.scales, opts.scales || {}),
        });
        if (opts.plugins && opts.plugins.tooltip) merged.plugins.tooltip = opts.plugins.tooltip;
        charts[id] = new Chart($(id), { type: cfg.type || 'bar', data: cfg.data, options: merged });
    }

    // ── Load ─────────────────────────────────────────────────────────────────
    function load() {
        var q = new URLSearchParams({ from: state.from, to: state.to });
        Object.keys(state.filters).forEach(function (k) { if (state.filters[k]) q.set(k, state.filters[k]); });
        var ticket = ++state.loading;
        showStatus('Loading…');
        api('/api/insights/overview?' + q.toString()).then(function (data) {
            if (ticket !== state.loading) return; // a newer request superseded this one
            showStatus('');
            var note = $('periodNote');
            note.hidden = false;
            note.textContent = niceDate(data.period.from) + ' – ' + niceDate(data.period.to) +
                '  ·  compared with ' + niceDate(data.comparison.from) + ' – ' + niceDate(data.comparison.to);

            var label = data.comparison.label;
            $('financeSection').hidden = !data.finance.available;
            $('salesSection').hidden = !data.sales.available;
            if (data.finance.available) renderFinance(data.finance, label);
            if (data.sales.available) renderSales(data.sales, label);

            var none = !data.finance.available && !data.sales.available;
            $('nothing').hidden = !none;
            if (none) {
                var perm = data.finance.reason === 'no_permission' && data.sales.reason === 'no_permission';
                $('nothingText').textContent = perm
                    ? 'Your role does not include access to financial or sales reports for this company.'
                    : 'This company has no posted accounting entries or till sales yet. Once Ledger Leo or Checkout Charlie is in use, the dashboard fills itself.';
            }
        }).catch(function (err) {
            if (ticket !== state.loading) return;
            handleError(err);
        });
    }

    function applyPreset() {
        var preset = $('preset').value;
        $('customRange').hidden = preset !== 'custom';
        if (preset === 'custom') {
            $('fromDate').value = state.from;
            $('toDate').value = state.to;
            return;
        }
        var r = presetRange(preset);
        state.from = r.from;
        state.to = r.to;
        load();
    }

    function init() {
        if (!getToken()) {
            showStatus('Please open Insights from the Eco dashboard.', true);
            return;
        }
        api('/api/insights/context').then(function (ctx) {
            $('companyName').textContent = ctx.company.name || ('Company ' + ctx.company.id);
            document.title = 'Insights — ' + (ctx.company.name || 'Lorenco Ecosystem');
        }).catch(function () { /* overview call reports the error */ });

        $('preset').addEventListener('change', applyPreset);
        $('applyCustom').addEventListener('click', function () {
            var f = $('fromDate').value, t = $('toDate').value;
            if (!f || !t) { showStatus('Choose both a from and a to date.', true); return; }
            if (f > t) { showStatus('The from date must be on or before the to date.', true); return; }
            state.from = f; state.to = t;
            load();
        });
        [['fStore', 'store'], ['fCategory', 'category'], ['fPayment', 'paymentMethod']].forEach(function (pair) {
            $(pair[0]).addEventListener('change', function (e) { state.filters[pair[1]] = e.target.value; load(); });
        });
        $('clearFilters').addEventListener('click', function () {
            state.filters = { store: '', category: '', paymentMethod: '' };
            load();
        });

        applyPreset();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
