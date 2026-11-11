/**
 * ============================================================================
 * Paytime help assistant — chat widget (SEVCO brain, Ruan 2026-11-10)
 * ============================================================================
 * Every Paytime user. Asks POST /api/help/ask: the matching help articles come
 * back at once (no AI needed — works even when the AI computer is off); when the
 * local AI (Ollama on Ruan's computer) is online it also writes a short answer
 * from those articles, which this widget picks up a little later.
 * The conversation lives in page memory only (CLAUDE.md Part D).
 * ============================================================================
 */
(function () {
    'use strict';
    if (window.__paytimeHelpChat) return;
    window.__paytimeHelpChat = true;

    var APP = 'paytime';
    var ICON = 'assets/branding/paytime-bot.png';
    var T = {
        AF: { title: 'PIP — Paytime\'s Intelligent Pal', hint: 'Hallo! Ek is Pip, jou Paytime-assistent.\nVra my hoe om iets in Paytime te doen, bv. "Hoe sit ek oortyd op \'n payslip?"',
              placeholder: 'Tik jou vraag…', send: 'Stuur', open: 'Maak die skerm oop', none: 'Ek het nog nie \'n hulpartikel hieroor nie. Jou vraag is aangeteken sodat ons dit kan byvoeg.',
              thinking: 'Pip skryf ook \'n kort antwoord…', offline: 'Pip se AI-helper is tans af — hier is die hulpartikel wat die beste pas.',
              helpful: 'Was dit nuttig?', thanks: 'Dankie!', error: 'Kon nie nou antwoord nie. Probeer weer.', source: 'Bron' },
        EN: { title: 'PIP — Paytime\'s Intelligent Pal', hint: 'Hi! I\'m Pip, your Paytime assistant.\nAsk me how to do something in Paytime, e.g. "How do I add overtime to a payslip?"\nJy kan ook in Afrikaans vra.',
              placeholder: 'Type your question…', send: 'Send', open: 'Open the screen', none: 'I don\'t have a help article about this yet. Your question was noted so we can add one.',
              thinking: 'Pip is also writing a short answer…', offline: 'Pip\'s AI helper is offline right now — here is the help article that fits best.',
              helpful: 'Was this helpful?', thanks: 'Thank you!', error: 'Could not answer right now. Please try again.', source: 'Source' }
    };
    var lang = 'EN';   // English first (Ruan 2026-11-11); no switch — each reply follows the language of the question

    function token() {
        try { return (window.safeLocalStorage || window.localStorage).getItem('token'); } catch (e) { return null; }
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

    var css = '' +
        '#phc-btn{position:fixed;right:20px;bottom:20px;width:64px;height:64px;border-radius:50%;border:none;padding:0;cursor:pointer;z-index:9998;' +
        'background:#0b0716;box-shadow:0 0 0 2px #7c3aed,0 0 22px rgba(168,85,247,.65);overflow:hidden}' +
        '#phc-btn img{width:100%;height:100%;object-fit:cover}#phc-btn span{font-size:30px;line-height:64px;color:#fff}' +
        '#phc-panel{position:fixed;right:20px;bottom:96px;width:380px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);z-index:9999;' +
        'display:none;flex-direction:column;background:#0d0a18;color:#e9e4ff;border:1px solid #3b2a6b;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.5),0 0 30px rgba(124,58,237,.25);font-family:inherit}' +
        '#phc-panel.open{display:flex}' +
        '.phc-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #2a1f4d}' +
        '.phc-head img{width:34px;height:34px;border-radius:50%}.phc-head b{flex:1;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.phc-x{background:none;border:none;color:#bfb3ef;font-size:20px;cursor:pointer}' +
        '.phc-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13.5px;line-height:1.45}' +
        '.phc-msg{max-width:88%;padding:9px 11px;border-radius:12px}' +
        '.phc-me{align-self:flex-end;background:#5b21b6;color:#fff;border-bottom-right-radius:4px}' +
        '.phc-bot{align-self:flex-start;background:#17122b;border:1px solid #2a1f4d;border-bottom-left-radius:4px}' +
        '.phc-art{margin-top:6px;padding-top:6px;border-top:1px dashed #33285a}.phc-art h4{margin:0 0 4px;font-size:13px;color:#d8b4fe}' +
        '.phc-link{display:inline-block;margin-top:6px;color:#67e8f9;text-decoration:none;font-size:12.5px}' +
        '.phc-note{font-size:12px;color:#a59cc9;font-style:italic}' +
        '.phc-fb{margin-top:6px;font-size:12px;color:#a59cc9}.phc-fb button{background:none;border:none;cursor:pointer;font-size:15px}' +
        '.phc-in{display:flex;gap:8px;padding:10px;border-top:1px solid #2a1f4d}' +
        '.phc-in input{flex:1;background:#17122b;border:1px solid #3b2a6b;color:#fff;border-radius:10px;padding:9px 10px;font-size:13.5px}' +
        '.phc-in button{background:#7c3aed;border:none;color:#fff;border-radius:10px;padding:0 14px;cursor:pointer}';

    function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

    function build() {
        var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
        var btn = el('<button id="phc-btn" type="button" aria-label="Pip, your Paytime assistant"><img src="' + ICON + '" alt=""></button>');
        btn.querySelector('img').onerror = function () { btn.innerHTML = '<span>🤖</span>'; };
        var panel = el('<div id="phc-panel" role="dialog" aria-label="Pip, your Paytime assistant">' +
            '<div class="phc-head"><img src="' + ICON + '" alt="" onerror="this.style.display=\'none\'"><b id="phc-title"></b>' +
            '<button class="phc-x" type="button" aria-label="Close">×</button></div>' +
            '<div class="phc-log" id="phc-log"></div>' +
            '<form class="phc-in" id="phc-form"><input id="phc-q" maxlength="1000" autocomplete="off"><button type="submit" id="phc-send"></button></form></div>');
        document.body.appendChild(btn);
        document.body.appendChild(panel);
        btn.addEventListener('click', function () { panel.classList.toggle('open'); if (panel.classList.contains('open')) panel.querySelector('#phc-q').focus(); });
        panel.querySelector('.phc-x').addEventListener('click', function () { panel.classList.remove('open'); });
        panel.querySelector('#phc-form').addEventListener('submit', function (e) { e.preventDefault(); ask(); });
        applyLang();
        say('bot', textHtml(T[lang].hint));
    }

    function applyLang() {
        var t = T[lang];
        document.getElementById('phc-title').textContent = t.title;
        document.getElementById('phc-q').placeholder = t.placeholder;
        document.getElementById('phc-send').textContent = t.send;
    }

    function say(who, html) {
        var log = document.getElementById('phc-log');
        var m = el('<div class="phc-msg ' + (who === 'me' ? 'phc-me' : 'phc-bot') + '">' + html + '</div>');
        log.appendChild(m);
        log.scrollTop = log.scrollHeight;
        return m;
    }

    function articleHtml(a) {
        var t = T[lang];
        return '<div class="phc-art"><h4>' + esc(a.title) + '</h4>' + textHtml(a.body) +
            (a.screen_url ? '<br><a class="phc-link" href="' + esc(a.screen_url) + '">→ ' + esc(t.open) + (a.screen_name ? ': ' + esc(a.screen_name) : '') + '</a>' : '') + '</div>';
    }

    function feedback(msg, qid) {
        var t = T[lang];
        var fb = el('<div class="phc-fb">' + esc(t.helpful) + ' <button type="button" data-f="up">👍</button><button type="button" data-f="down">👎</button></div>');
        fb.querySelectorAll('button').forEach(function (b) {
            b.addEventListener('click', function () {
                api('POST', '/api/help/questions/' + qid + '/feedback', { feedback: b.getAttribute('data-f') });
                fb.textContent = t.thanks;
            });
        });
        msg.appendChild(fb);
    }

    function ask() {
        var input = document.getElementById('phc-q');
        var q = input.value.trim();
        if (q.length < 2) return;
        input.value = '';
        say('me', esc(q));
        var t = T[lang];
        api('POST', '/api/help/ask', { app: APP, question: q, language: lang }).then(function (r) {
            if (!r.ok) { say('bot', esc((r.data && r.data.error) || t.error)); return; }
            var d = r.data;
            // The server works out the language of the question; follow it for the reply and the labels.
            if (d.language === 'AF' || d.language === 'EN') { lang = d.language; t = T[lang]; applyLang(); }
            if (!d.articles || !d.articles.length) { var m0 = say('bot', esc(t.none)); feedback(m0, d.question_id); return; }
            var lead = d.ai && d.ai.status === 'queued'
                ? (d.ai.online ? '<div class="phc-note">' + esc(t.thinking) + '</div>' : '<div class="phc-note">' + esc(t.offline) + '</div>')
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
                    var note = msg.querySelector('.phc-note');
                    var ans = el('<div><b>🤖</b> ' + textHtml(r.data.ai_answer) + '<div class="phc-note">' + esc(T[lang].source) + ':</div></div>');
                    if (note) note.replaceWith(ans); else msg.insertBefore(ans, msg.firstChild);
                    document.getElementById('phc-log').scrollTop = 1e9;
                } else if (r.data.ai_status === 'queued' && r.data.online !== false) {
                    poll(qid, msg, tries + 1);
                } else {
                    var n = msg.querySelector('.phc-note'); if (n) n.remove();
                }
            });
        }, 5000);
    }

    // Only show the assistant once SEVCO has approved Paytime help articles (and the
    // database is ready) — otherwise users would see a button that cannot help yet.
    function start() {
        api('GET', '/api/help/available?app=' + APP).then(function (r) {
            if (r.ok && r.data && r.data.available) build();
        }).catch(function () { /* stay hidden */ });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
