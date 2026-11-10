/**
 * Sean AI Chat widget — Ledger Leo (2026-08-30)
 *
 * Self-contained: injected once by navigation.js on every accounting page,
 * same pattern as eco-api-interceptor.js. Renders a collapsed bubble bottom-
 * right; expands into a small scrollback + input panel. No conversation
 * list — one running conversation per (user, company), same as the backend
 * proxy's Conversation find-or-create in sean-webapp.
 *
 * Visibility gate is UI-only (super-admins only, per Ruan's "Net super-
 * admins vir eers"). The real gate is server-side in sean-chat.js's
 * req.user.isGlobalAdmin check — this just avoids showing a bubble that
 * would immediately 403 for everyone else.
 *
 * Avatar: swap AVATAR_URL below to the real mascot PNG path once saved to
 * the repo (e.g. /accounting/images/sean-chat-avatar.png). Until then this
 * renders a CSS placeholder in the mascot's own blue/orange palette.
 */
(function () {
  'use strict';

  if (document.getElementById('sean-chat-widget-root')) return;

  let currentUser = null;
  try {
    currentUser = JSON.parse(localStorage.getItem('user') || 'null');
  } catch (e) {
    currentUser = null;
  }
  if (!currentUser || currentUser.isGlobalAdmin !== true) return;

  const AVATAR_URL = '/accounting/Images/sean-chat-avatar.png';

  const ACCENT = '#2f8fff';
  const ACCENT_DARK = '#0d5fd6';
  const GOLD = '#f5a524';
  const PANEL_BG = '#0b1220';
  const PANEL_BG_2 = '#111a2e';
  const BORDER = 'rgba(47, 143, 255, 0.35)';

  const style = document.createElement('style');
  style.textContent = `
    #sean-chat-widget-root {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #sean-chat-bubble {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, ${ACCENT_DARK}, #05070d 78%);
      border: 2px solid ${ACCENT};
      box-shadow: 0 4px 18px rgba(0,0,0,0.45), 0 0 0 4px rgba(47,143,255,0.12);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s ease;
    }
    #sean-chat-bubble:hover { transform: scale(1.06); }
    #sean-chat-bubble svg { width: 30px; height: 30px; }
    #sean-chat-bubble img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
    #sean-chat-unread {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: ${GOLD};
      border: 2px solid #05070d;
      display: none;
    }
    #sean-chat-panel {
      position: absolute;
      bottom: 68px;
      right: 0;
      width: 380px;
      height: 560px;
      max-height: 75vh;
      background: ${PANEL_BG};
      border: 1px solid ${BORDER};
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    #sean-chat-panel.open { display: flex; }
    #sean-chat-header {
      background: linear-gradient(135deg, ${PANEL_BG_2}, #08101f);
      border-bottom: 1px solid ${BORDER};
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    #sean-chat-header .avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, ${ACCENT_DARK}, #05070d 78%);
      border: 1.5px solid ${ACCENT};
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      overflow: hidden;
    }
    #sean-chat-header .avatar svg { width: 18px; height: 18px; }
    #sean-chat-header .avatar img { width: 100%; height: 100%; object-fit: cover; }
    #sean-chat-header .title { color: #eaf1ff; font-size: 14px; font-weight: 600; }
    #sean-chat-header .subtitle { color: #7d93b8; font-size: 11px; }
    #sean-chat-close {
      margin-left: auto;
      background: none; border: none; color: #7d93b8; cursor: pointer;
      font-size: 18px; line-height: 1; padding: 4px;
    }
    #sean-chat-close:hover { color: #eaf1ff; }
    #sean-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .sean-chat-msg {
      max-width: 85%;
      padding: 9px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .sean-chat-msg.user {
      align-self: flex-end;
      background: ${ACCENT_DARK};
      color: #fff;
      border-bottom-right-radius: 3px;
    }
    .sean-chat-msg.assistant {
      align-self: flex-start;
      background: ${PANEL_BG_2};
      border: 1px solid ${BORDER};
      color: #dbe6f7;
      border-bottom-left-radius: 3px;
    }
    .sean-chat-msg.assistant.pending { color: #7d93b8; font-style: italic; }
    .sean-chat-msg.error {
      align-self: flex-start;
      background: rgba(220, 38, 38, 0.12);
      border: 1px solid rgba(220, 38, 38, 0.4);
      color: #fca5a5;
      border-bottom-left-radius: 3px;
    }
    #sean-chat-input-row {
      border-top: 1px solid ${BORDER};
      padding: 10px;
      display: flex;
      gap: 8px;
    }
    #sean-chat-input {
      flex: 1;
      background: ${PANEL_BG_2};
      border: 1px solid ${BORDER};
      border-radius: 10px;
      color: #eaf1ff;
      font-size: 13px;
      padding: 9px 11px;
      resize: none;
      font-family: inherit;
      max-height: 90px;
    }
    #sean-chat-input:focus { outline: none; border-color: ${ACCENT}; }
    #sean-chat-send {
      background: linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK});
      border: none;
      border-radius: 10px;
      color: #fff;
      width: 38px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    #sean-chat-send:disabled { opacity: 0.5; cursor: default; }
    #sean-chat-send svg { width: 16px; height: 16px; }
  `;
  document.head.appendChild(style);

  const AVATAR_HTML = AVATAR_URL
    ? '<img src="' + AVATAR_URL + '" alt="Sean AI">'
    : '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="13" rx="4" fill="#05070d" stroke="' + ACCENT + '" stroke-width="1.4"/><circle cx="9" cy="12.5" r="1.6" fill="' + ACCENT + '"/><circle cx="15" cy="12.5" r="1.6" fill="' + ACCENT + '"/><path d="M9 16c1 1 5 1 6 0" stroke="' + ACCENT + '" stroke-width="1.2" stroke-linecap="round"/><path d="M12 6V3" stroke="' + GOLD + '" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const root = document.createElement('div');
  root.id = 'sean-chat-widget-root';
  root.innerHTML = `
    <div id="sean-chat-panel">
      <div id="sean-chat-header">
        <div class="avatar">${AVATAR_HTML}</div>
        <div>
          <div class="title">Sean AI</div>
          <div class="subtitle">Ledger Leo support</div>
        </div>
        <button id="sean-chat-close" aria-label="Close">&times;</button>
      </div>
      <div id="sean-chat-messages"></div>
      <div id="sean-chat-input-row">
        <textarea id="sean-chat-input" rows="1" placeholder="Ask Sean anything about Leo..."></textarea>
        <button id="sean-chat-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none"><path d="M4 12L20 4L13 20L11 13L4 12Z" fill="white"/></svg>
        </button>
      </div>
    </div>
    <div id="sean-chat-bubble">
      ${AVATAR_HTML}
      <div id="sean-chat-unread"></div>
    </div>
  `;
  function mount() {
    document.body.appendChild(root);
    wireUpWidget();
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  function wireUpWidget() {
  const panel = document.getElementById('sean-chat-panel');
  const bubble = document.getElementById('sean-chat-bubble');
  const unreadDot = document.getElementById('sean-chat-unread');
  const messagesEl = document.getElementById('sean-chat-messages');
  const input = document.getElementById('sean-chat-input');
  const sendBtn = document.getElementById('sean-chat-send');
  const closeBtn = document.getElementById('sean-chat-close');

  let sending = false;
  let hasGreeted = false;

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'sean-chat-msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function openPanel() {
    panel.classList.add('open');
    unreadDot.style.display = 'none';
    if (!hasGreeted) {
      hasGreeted = true;
      addMessage('assistant', "Hi, I'm Sean — ask me anything about Ledger Leo (VAT, reconciliations, invoices, reports) and I'll do my best to help.");
    }
    input.focus();
  }

  function closePanel() {
    panel.classList.remove('open');
  }

  bubble.addEventListener('click', function () {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 90) + 'px';
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || sending) return;

    addMessage('user', text);
    input.value = '';
    input.style.height = 'auto';
    sending = true;
    sendBtn.disabled = true;

    const pending = addMessage('assistant pending', 'Thinking...');

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/accounting/sean-chat/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      pending.remove();

      if (!res.ok) {
        addMessage('error', data.error || 'Sean AI is temporarily unavailable. Please try again.');
      } else {
        addMessage('assistant', data.answer || "I couldn't come up with an answer for that — try rephrasing.");
      }
    } catch (e) {
      pending.remove();
      addMessage('error', 'Could not reach Sean AI. Check your connection and try again.');
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }
  }
})();
