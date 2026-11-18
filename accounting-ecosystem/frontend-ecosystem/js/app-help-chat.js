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
 * (no AI needed). 2026-11-17: "Explain step by step" (or typing where you are
 * stuck) asks the local AI to explain THAT article in small steps, as a
 * conversation (POST /api/help/questions/:id/explain). Never advice.
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
              helpful: 'Was dit nuttig?', thanks: 'Dankie!', error: 'Kon nie nou antwoord nie. Probeer weer.', source: 'Bron', aria: 'Hulp-assistent',
              explain: 'Verduidelik stap vir stap', explaining: 'Ek dink hoe om dit eenvoudiger te verduidelik…', newq: 'Nuwe vraag',
              next: 'Sê vir my wanneer jy daar is, of waar jy vashaak, dan help ek verder.', more: 'Volgende stappe',
              doneSteps: 'Dis al die stappe. As jy iewers vashaak, sê vir my waar.',
              stuck: 'Sê waar jy vashaak…', disclaimer: 'Hulp met hoe die app werk — nie belasting- of rekeningkundige advies nie.',
              cannot: 'Ek kan dit nie beter verduidelik as die artikel hierbo nie. Volg die stappe daar, of vra jou vraag op \'n ander manier.',
              offlineExplain: 'Ek kan nou nie verder verduidelik nie. Volg die artikel hierbo, of probeer later weer.',
              limit: 'Ek kan nie verder hieroor verduidelik nie. Volg die artikel hierbo, of vra \'n nuwe vraag.' },
        EN: { title: 'Help assistant', hint: 'Hi! Ask me how to do something in the app.', placeholder: 'Type your question…', send: 'Send',
              open: 'Open the screen', none: 'I don\'t have a help article about this yet. Your question was noted so we can add one.',
              thinking: 'Also writing a short answer…', offline: 'The AI helper is offline right now — here is the help article that fits best.',
              advice: 'That sounds like an advice question. I help with how the app works. For advice, ask your accountant.',
              helpful: 'Was this helpful?', thanks: 'Thank you!', error: 'Could not answer right now. Please try again.', source: 'Source', aria: 'Help assistant',
              explain: 'Explain step by step', explaining: 'Working out a simpler way to explain it…', newq: 'New question',
              next: 'Tell me when you are there, or where you are stuck, and I will help further.', more: 'Next steps',
              doneSteps: 'That is all the steps. If you get stuck somewhere, tell me where.',
              stuck: 'Tell me where you are stuck…', disclaimer: 'Help with how the app works — not tax or accounting advice.',
              cannot: 'I can\'t explain it better than the article above. Follow the steps there, or ask your question another way.',
              offlineExplain: 'I can\'t explain further right now. Follow the article above, or try again later.',
              limit: 'I can\'t explain more about this. Follow the article above, or ask a new question.' }
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
        '.ahc-act{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}.ahc-act button{background:#16141f;border:1px solid ' + ACCENT + ';color:#e9e4ff;border-radius:8px;padding:5px 9px;font-size:12.5px;cursor:pointer}' +
        '.ahc-act button:disabled{opacity:.5;cursor:default}' +
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
        panel.querySelector('#ahc-form').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
        applyLang();
        say('bot', textHtml(T[lang].hint));
    }

    function applyLang() {
        var t = T[lang];
        document.getElementById('ahc-title').textContent = t.title;
        document.getElementById('ahc-q').placeholder = thread ? t.stuck : t.placeholder;
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

    // An open "explain" conversation: typed text goes to it as a follow-up.
    // "Explain step by step" pages through the APPROVED article's own numbered
    // steps, 3 at a time — no AI, always correct, works with the AI computer off.
    // Only when the client types where they are stuck does the local AI help,
    // told which step they are at (trial 2026-11-17: the small model does not
    // keep to "3 steps", repeats steps, and drifts in Afrikaans).
    var thread = null;   // { rootId, pending: [], shown: n, seen: {} } — page memory only
    var STEP_RE = /^\s*\d{1,2}[.)]\s/;
    var NEXT_RE = /^\s*(ok(ay)?|ja|yes|klaar|done|gedoen|reg|ek is daar|i'?m there|i am there|daar|volgende|next|wat nou|what now|en nou|and now|then\??|toe\??)\b/i;
    function submit() {
        var input = document.getElementById('ahc-q');
        var q = input.value.trim();
        if (q.length < 2) return;
        input.value = '';
        say('me', esc(q));
        if (thread && thread.pending.length && NEXT_RE.test(q) && q.split(/\s+/).length <= 4) { showMore(thread.rootId); return; }
        if (thread) explain(thread.rootId, q); else ask(q);
    }
    function endThread() { thread = null; applyLang(); }
    function newThread(rootId) { return { rootId: rootId, pending: [], shown: 0, seen: {} }; }
    function stepKey(s) { return String(s).replace(STEP_RE, '').trim().toLowerCase(); }

    function splitSteps(text) {
        var intro = [], steps = [];
        String(text || '').split('\n').forEach(function (line) {
            var l = line.trim();
            if (STEP_RE.test(line)) steps.push(l);
            else if (steps.length) { if (l) steps[steps.length - 1] += '\n' + l; }
            else if (l) intro.push(l);
        });
        return { intro: intro.join('\n'), steps: steps };
    }

    // mode 'article' → [Explain step by step]; 'answer' → [Next steps]? [New question]
    function explainButtons(msg, rootId, mode, article) {
        var t = T[lang];
        var more = mode === 'answer' && thread && thread.pending.length;
        var bar = el('<div class="ahc-act">' +
            (mode === 'article' ? '<button type="button" data-a="explain">' + esc(t.explain) + '</button>' : '') +
            (more ? '<button type="button" data-a="more">' + esc(t.more) + '</button>' : '') +
            (mode === 'answer' ? '<button type="button" data-a="new">' + esc(t.newq) + '</button>' : '') + '</div>');
        var off = function () { bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; }); };
        var eb = bar.querySelector('[data-a="explain"]');
        if (eb) eb.addEventListener('click', function () {
            off();
            var steps = article ? splitSteps(article.body).steps : [];
            if (steps.length >= 2) {
                thread = newThread(rootId); thread.pending = steps; applyLang();
                showMore(rootId);
            } else {
                explain(rootId, '');   // an article without numbered steps: the AI writes them
            }
        });
        var mb = bar.querySelector('[data-a="more"]');
        if (mb) mb.addEventListener('click', function () { off(); showMore(rootId); });
        var nb = bar.querySelector('[data-a="new"]');
        if (nb) nb.addEventListener('click', function () { endThread(); bar.remove(); document.getElementById('ahc-q').focus(); });
        msg.appendChild(bar);
    }

    function stepsHtml(lines, last, fromAi) {
        var t = T[lang];
        return textHtml(lines.join('\n')) + '<br><br>' + esc(last ? t.doneSteps : t.next) +
            (fromAi ? '<div class="ahc-note">' + esc(t.disclaimer) + '</div>' : '');
    }

    function markShown(steps) {
        steps.forEach(function (s) { thread.seen[stepKey(s)] = true; });
        thread.shown += steps.length;
    }

    // Next 3 of the pending steps — no AI.
    function showMore(rootId) {
        if (!thread || !thread.pending.length) return;
        var chunk = thread.pending.splice(0, 3);
        markShown(chunk);
        var m = say('bot', stepsHtml(chunk, !thread.pending.length, false));
        explainButtons(m, rootId, 'answer');
    }

    // An AI answer: leave out steps the client has already seen, then page it.
    function showAnswer(msg, answer, qid, rootId) {
        var s = splitSteps(answer);
        var fresh = s.steps.filter(function (x) { return !thread.seen[stepKey(x)]; });
        var steps = fresh.length ? fresh : s.steps;
        var first = steps.slice(0, 3);
        thread.pending = steps.slice(first.length);
        markShown(first);
        var lines = (s.intro ? [s.intro] : []).concat(first.length ? first : [answer]);
        msg.innerHTML = stepsHtml(lines, !thread.pending.length, true);
        feedback(msg, qid);
        explainButtons(msg, rootId, 'answer');
    }

    // Ask the local AI to help with the article of question rootId.
    function explain(rootId, text) {
        var t = T[lang];
        if (!thread || thread.rootId !== rootId) thread = newThread(rootId);
        applyLang();
        api('POST', '/api/help/questions/' + rootId + '/explain', { message: text, language: lang, at_step: thread.shown }).then(function (r) {
            if (!r.ok) { say('bot', esc((r.data && r.data.error) || t.error)); return; }
            var d = r.data;
            if (d.language === 'AF' || d.language === 'EN') { lang = d.language; t = T[lang]; applyLang(); }
            if (d.advice) { say('bot', textHtml(t.advice)); return; }
            var st = d.ai && d.ai.status;
            if (st === 'queued') {
                var msg = say('bot', '<div class="ahc-note">' + esc(t.explaining) + '</div>');
                pollExplain(d.question_id, rootId, text, msg, 0);
            } else if (st === 'limit') { say('bot', esc(t.limit)); }
            else if (st === 'offline') { say('bot', esc(t.offlineExplain)); }
            else { say('bot', esc(t.cannot)); }
        }).catch(function () { say('bot', esc(t.error)); });
    }

    // Small model on one computer: ~10–60 s; stop after ~3 minutes.
    function pollExplain(qid, rootId, text, msg, tries) {
        var t = T[lang];
        if (tries > 36) { msg.innerHTML = esc(t.offlineExplain); return; }
        setTimeout(function () {
            api('GET', '/api/help/questions/' + qid).then(function (r) {
                if (!r.ok) { msg.innerHTML = esc(t.error); return; }
                var d = r.data;
                if (d.ai_status === 'done' && d.ai_answer) {
                    if (!thread || thread.rootId !== rootId) thread = newThread(rootId);
                    showAnswer(msg, d.ai_answer, qid, rootId);
                } else if (d.not_covered) {
                    // Not about this article: it is a new question.
                    msg.remove(); endThread();
                    if (text) ask(text); else say('bot', esc(t.cannot));
                    return;
                } else if (d.ai_status === 'queued' && d.online !== false) {
                    pollExplain(qid, rootId, text, msg, tries + 1); return;
                } else {
                    msg.innerHTML = esc(d.ai_status === 'queued' ? t.offlineExplain : t.cannot);
                }
                document.getElementById('ahc-log').scrollTop = 1e9;
            }).catch(function () { msg.innerHTML = esc(t.error); });
        }, 5000);
    }

    function ask(q) {
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
            if (d.can_explain) explainButtons(msg, d.question_id, 'article', d.articles[0]);
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
