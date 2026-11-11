/**
 * ============================================================================
 * App help assistant — shared chat widget (SEVCO brain, 2026-11-11)
 * ============================================================================
 * The same idea as Paytime's Pip (frontend-payroll/js/help-chat.js), made
 * reusable so every app gets its help bot from one file. Ledger Leo is the
 * first user; Paytime can move onto it later (Paytime is stability-locked).
 *
 * Configure BEFORE loading this script:
 *   window.APP_HELP_CHAT = {
 *     app: 'leo',                  // key in backend/sean/help/knowledge.js APPS
 *     tokenKey: 'token',           // native localStorage key of the app's JWT
 *     icon: '/accounting/...png',  // optional; emoji fallback
 *     emoji: '🦁', accent: '#f59e0b', accentSoft: 'rgba(245,158,11,.55)',
 *     bottom: 20,                  // px from the bottom (lift it above another widget)
 *     text: { AF: {...}, EN: {...} }  // labels — see DEFAULT_TEXT for the keys
 *   };
 *
 * Asks POST /api/help/ask: matching APPROVED help articles come back at once
 * (no AI needed); when the local AI is online it also writes a short answer.
 * The button only appears once SEVCO has approved at least one article for the app.
 * The conversation lives in page memory only (CLAUDE.md Part D) — nothing is
 * written to browser storage; the token is only read.
 * ============================================================================
 */
(function () {
    'use strict';
    var cfg = window.APP_HELP_CHAT || {};
    if (!cfg.app || window.__appHelpChat) return;
    window.__appHelpChat = true;

    var APP = cfg.app;
    var ICON = cfg.icon || '';
    var EMOJI = cfg.emoji || '🤖';
    var ACCENT = cfg.accent || '#7c3aed';
    var ACCENT_SOFT = cfg.accentSoft || 'rgba(168,85,247,.55)';
    var BOTTOM = typeof cfg.bottom === 'number' ? cfg.bottom : 20;

    var DEFAULT_TEXT = {
        AF: { title: 'Hulp-assistent', hint: 'Hallo! Vra my hoe om iets in die app te doen.', placeholder: 'Tik jou vraag…', send: 'Stuur',
              open: 'Maak die skerm oop', none: 'Ek het nog nie \'n hulpartikel hieroor nie. Jou vraag is aangeteken sodat ons dit kan byvoeg.',
              thinking: 'Ek skryf ook \'n kort antwoord…', offline: 'Die AI-helper is tans af — hier is die hulpartikel wat die beste pas.',
              advice: 'Dit klink na \'n adviesvraag. Ek help met hoe die app werk. Vir advies, vra jou rekenmeester.',
              helpful: 'Was dit nuttig?', thanks: 'Dankie!', error: 'Kon nie nou antwoord nie. Probeer weer.', source: 'Bron', aria: 'Hulp-assistent' },
        EN: { title: 'Help assistant', hint: 'Hi! Ask me how to do something in the app.', placeholder: 'Type your question…', send: 'Send',
              open: 'Open the screen', none: 'I don\'t have a help article about this yet. Your question was noted so we can add one.',
              thinking: 'Also writing a short answer…', offline: 'The AI helper is offline right now — here is the help article that fits best.',
              advice: 'That sounds like an advice question. I help with how the app works. For advice, ask your accountant.',
              helpful: 'Was this helpful?', thanks: 'Thank you!', error: 'Could not answer right now. Please try again.', source: 'Source', aria: 'Help assistant' }
    };
    var T = {
        AF: Object.assign({}, DEFAULT_TEXT.AF, (cfg.text && cfg.text.AF) || {}),
        EN: Object.assign({}, DEFAULT_TEXT.EN, (cfg.text && cfg.text.EN) || {})
    };
    var lang = 'EN';   // each reply follows the language of the question (server detects it)

    function token() {
        try { return window.localStorage.getItem(cfg.tokenKey || 'token'); } catch (e) { return null; }
    }
    function api(method, url, body) {
        var h = { 'Content-Type': 'application/json' };
        var t = token();
        if (t) h.Authorization = 'Bearer ' + t;
        return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function textHtml(s) { return esc(s).replace(/\n/g, '<br>'); }
    // Only same-site links from articles (screen_url is written by super users, but stay safe).
    function safeUrl(u) { return /^\/[a-z0-9]/i.test(String(u || '')) ? String(u) : ''; }

    var css = '' +
        '#ahc-btn{position:fixed;right:20px;bottom:' + BOTTOM + 'px;width:60px;height:60px;border-radius:50%;border:none;padding:0;cursor:pointer;z-index:99990;' +
        'background:#0b0a12;box-shadow:0 0 0 2px ' + ACCENT + ',0 0 22px ' + ACCENT_SOFT + ';overflow:hidden}' +
        '#ahc-btn img{width:100%;height:100%;object-fit:cover}#ahc-btn span{font-size:30px;line-height:60px;color:#fff}' +
        '#ahc-panel{position:fixed;right:20px;bottom:' + (BOTTOM + 76) + 'px;width:380px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - ' + (BOTTOM + 100) + 'px);z-index:99991;' +
        'display:none;flex-direction:column;background:#0d0c14;color:#ece9f5;border:1px solid #33304a;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.5);font-family:inherit}' +
        '#ahc-panel.open{display:flex}' +
        '.ahc-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #26233a}' +
        '.ahc-head img{width:34px;height:34px;border-radius:50%}.ahc-head b{flex:1;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.ahc-x{background:none;border:none;color:#bdb8d6;font-size:20px;cursor:pointer}' +
        '.ahc-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13.5px;line-height:1.45}' +
        '.ahc-msg{max-width:88%;padding:9px 11px;border-radius:12px}' +
        '.ahc-me{align-self:flex-end;background:' + ACCENT + ';color:#0b0a12;border-bottom-right-radius:4px}' +
        '.ahc-bot{align-self:flex-start;background:#16141f;border:1px solid #26233a;border-bottom-left-radius:4px}' +
        '.ahc-art{margin-top:6px;padding-top:6px;border-top:1px dashed #33304a}.ahc-art h4{margin:0 0 4px;font-size:13px;color:' + ACCENT + '}' +
        '.ahc-link{display:inline-block;margin-top:6px;color:#67e8f9;text-decoration:none;font-size:12.5px}' +
        '.ahc-note{font-size:12px;color:#a6a1c2;font-style:italic}' +
        '.ahc-fb{margin-top:6px;font-size:12px;color:#a6a1c2}.ahc-fb button{background:none;border:none;cursor:pointer;font-size:15px}' +
        '.ahc-in{display:flex;gap:8px;padding:10px;border-top:1px solid #26233a}' +
        '.ahc-in input{flex:1;background:#16141f;border:1px solid #33304a;color:#fff;border-radius:10px;padding:9px 10px;font-size:13.5px}' +
        '.ahc-in button{background:' + ACCENT + ';border:none;color:#0b0a12;font-weight:600;border-radius:10px;padding:0 14px;cursor:pointer}';

    function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

    function build() {
        var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
        var inner = ICON ? '<img src="' + esc(ICON) + '" alt="">' : '<span>' + EMOJI + '</span>';
        var btn = el('<button id="ahc-btn" type="button" aria-label="' + esc(T.EN.aria) + '">' + inner + '</button>');
        var img = btn.querySelector('img');
        if (img) img.onerror = function () { btn.innerHTML = '<span>' + EMOJI + '</span>'; };
        var panel = el('<div id="ahc-panel" role="dialog" aria-label="' + esc(T.EN.aria) + '">' +
            '<div class="ahc-head">' + (ICON ? '<img src="' + esc(ICON) + '" alt="" onerror="this.style.display=\'none\'">' : '<span style="font-size:24px">' + EMOJI + '</span>') +
            '<b id="ahc-title"></b><button class="ahc-x" type="button" aria-label="Close">×</button></div>' +
            '<div class="ahc-log" id="ahc-log"></div>' +
            '<form class="ahc-in" id="ahc-form"><input id="ahc-q" maxlength="1000" autocomplete="off"><button type="submit" id="ahc-send"></button></form></div>');
        document.body.appendChild(btn);
        document.body.appendChild(panel);
        btn.addEventListener('click', function () { panel.classList.toggle('open'); if (panel.classList.contains('open')) panel.querySelector('#ahc-q').focus(); });
        panel.querySelector('.ahc-x').addEventListener('click', function () { panel.classList.remove('open'); });
        panel.querySelector('#ahc-form').addEventListener('submit', function (e) { e.preventDefault(); ask(); });
        applyLang();
        say('bot', textHtml(T[lang].hint));
    }

    function applyLang() {
        var t = T[lang];
        document.getElementById('ahc-title').textContent = t.title;
        document.getElementById('ahc-q').placeholder = t.placeholder;
        document.getElementById('ahc-send').textContent = t.send;
    }

    function say(who, html) {
        var log = document.getElementById('ahc-log');
        var m = el('<div class="ahc-msg ' + (who === 'me' ? 'ahc-me' : 'ahc-bot') + '">' + html + '</div>');
        log.appendChild(m);
        log.scrollTop = log.scrollHeight;
        return m;
    }

    function articleHtml(a) {
        var t = T[lang];
        var url = safeUrl(a.screen_url);
        return '<div class="ahc-art"><h4>' + esc(a.title) + '</h4>' + textHtml(a.body) +
            (url ? '<br><a class="ahc-link" href="' + esc(url) + '">→ ' + esc(t.open) + (a.screen_name ? ': ' + esc(a.screen_name) : '') + '</a>' : '') + '</div>';
    }

    function feedback(msg, qid) {
        var t = T[lang];
        var fb = el('<div class="ahc-fb">' + esc(t.helpful) + ' <button type="button" data-f="up">👍</button><button type="button" data-f="down">👎</button></div>');
        fb.querySelectorAll('button').forEach(function (b) {
            b.addEventListener('click', function () {
                api('POST', '/api/help/questions/' + qid + '/feedback', { feedback: b.getAttribute('data-f') });
                fb.textContent = t.thanks;
            });
        });
        msg.appendChild(fb);
    }

    function ask() {
        var input = document.getElementById('ahc-q');
        var q = input.value.trim();
        if (q.length < 2) return;
        input.value = '';
        say('me', esc(q));
        var t = T[lang];
        api('POST', '/api/help/ask', { app: APP, question: q, language: lang }).then(function (r) {
            if (!r.ok) { say('bot', esc((r.data && r.data.error) || t.error)); return; }
            var d = r.data;
            if (d.language === 'AF' || d.language === 'EN') { lang = d.language; t = T[lang]; applyLang(); }
            if (d.advice) { say('bot', textHtml(t.advice)); return; }
            if (!d.articles || !d.articles.length) { var m0 = say('bot', esc(t.none)); feedback(m0, d.question_id); return; }
            var lead = d.ai && d.ai.status === 'queued'
                ? (d.ai.online ? '<div class="ahc-note">' + esc(t.thinking) + '</div>' : '<div class="ahc-note">' + esc(t.offline) + '</div>')
                : '';
            var msg = say('bot', lead + d.articles.map(articleHtml).join(''));
            feedback(msg, d.question_id);
            if (d.ai && d.ai.status === 'queued' && d.ai.online) poll(d.question_id, msg, 0);
        }).catch(function () { say('bot', esc(t.error)); });
    }

    // The local AI computer answers in roughly 10–60 s; stop after ~3 minutes.
    function poll(qid, msg, tries) {
        if (tries > 36) return;
        setTimeout(function () {
            api('GET', '/api/help/questions/' + qid).then(function (r) {
                if (!r.ok) return;
                if (r.data.ai_status === 'done' && r.data.ai_answer) {
                    var note = msg.querySelector('.ahc-note');
                    var ans = el('<div><b>' + EMOJI + '</b> ' + textHtml(r.data.ai_answer) + '<div class="ahc-note">' + esc(T[lang].source) + ':</div></div>');
                    if (note) note.replaceWith(ans); else msg.insertBefore(ans, msg.firstChild);
                    document.getElementById('ahc-log').scrollTop = 1e9;
                } else if (r.data.ai_status === 'queued' && r.data.online !== false) {
                    poll(qid, msg, tries + 1);
                } else {
                    var n = msg.querySelector('.ahc-note'); if (n) n.remove();
                }
            });
        }, 5000);
    }

    // Only show the assistant once SEVCO has approved help articles for this app.
    function start() {
        if (!token()) return;
        api('GET', '/api/help/available?app=' + encodeURIComponent(APP)).then(function (r) {
            if (r.ok && r.data && r.data.available) build();
        }).catch(function () { /* stay hidden */ });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
