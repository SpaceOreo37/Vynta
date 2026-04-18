/**
 * content.js — Vynta Phase 4: Agentic Execution & Polish
 *
 * Sections:
 *   1. STORAGE    — load/save rate profile via chrome.storage.local
 *   2. SCRAPER    — extract, clean, and pre-scan email
 *   3. DETECTOR   — poll URL for Gmail SPA navigation
 *   4. BUTTON     — floating "Analyze Deal" pill
 *   5. INJECTOR   — inject selected draft into Gmail compose box
 *   6. SIDEBAR    — full dark-mode Shadow DOM sidebar
 *   7. INIT
 */

(function () {
  'use strict';

  if (window.__vyntaLoaded) return;
  window.__vyntaLoaded = true;


  // ─────────────────────────────────────────────────────────────────────────
  // 1. STORAGE — Rate Profile
  // ─────────────────────────────────────────────────────────────────────────

  let rateProfile = {}; // populated on load

  function loadProfile() {
    return new Promise(resolve => {
      chrome.storage.local.get(['vyntaProfile'], result => {
        rateProfile = result.vyntaProfile || {};
        resolve(rateProfile);
      });
    });
  }

  function saveProfile(data) {
    rateProfile = data;
    return new Promise(resolve => {
      chrome.storage.local.set({ vyntaProfile: data }, resolve);
    });
  }

  // ── Deal History storage ──────────────────────────────────────────────────

  function loadHistory() {
    return new Promise(resolve => {
      chrome.storage.local.get(['vyntaHistory'], result => {
        dealHistory = result.vyntaHistory || [];
        resolve(dealHistory);
      });
    });
  }

  function clearHistory() {
    dealHistory = [];
    return new Promise(resolve => chrome.storage.local.remove(['vyntaHistory'], resolve));
  }

  // ── API Key storage ──────────────────────────────────────────────────────

  let _cachedApiKey = null; // in-memory cache so we don't hit storage on every render

  function loadApiKey() {
    return new Promise(resolve => {
      if (_cachedApiKey !== null) { resolve(_cachedApiKey); return; }
      chrome.storage.local.get(['vyntaApiKey'], result => {
        _cachedApiKey = result.vyntaApiKey || '';
        resolve(_cachedApiKey);
      });
    });
  }

  function saveApiKey(key) {
    _cachedApiKey = key;
    return new Promise(resolve => chrome.storage.local.set({ vyntaApiKey: key }, resolve));
  }

  // Extracts the first substantial dollar amount (≥$50) from email body for display.
  function extractPrice(body) {
    const re = /\$\s*([\d,]+(?:\.\d{1,2})?)\s*([kKmM])?/g;
    let m;
    while ((m = re.exec(body || '')) !== null) {
      let val = parseFloat(m[1].replace(/,/g, ''));
      const suffix = (m[2] || '').toLowerCase();
      if (suffix === 'k') val *= 1000;
      else if (suffix === 'm') val *= 1000000;
      if (val >= 50) return m[0].replace(/\s/g, '');
    }
    return null;
  }

  // Saves a new deal to history. Deduplicates by threadId so re-opens don't
  // create duplicate entries. Keeps the 10 most recent deals.
  function addToHistory(emailData, aiData, threadId) {
    const s = Math.max(1, Math.min(10, Math.round(aiData.fairnessScore ?? 5)));
    const agentVerdict = s <= 4
      ? { label: '🚫 RED FLAG: Decline Recommended',       cls: 'vb-red' }
      : s <= 7
      ? { label: '⚠️ NEGOTIATE: Push for Better Terms',    cls: 'vb-yellow' }
      : { label: '✅ TAKE THE DEAL: High-Priority Win',    cls: 'vb-green' };
    const rationale = aiData.fairnessRationale ?? '';
    const agentSub  = rationale
      ? rationale.split(/(?<=[.!?])\s+/)[0]
      : (s <= 4 ? 'This deal is significantly below market rate or contains predatory clauses.'
       : s <= 7 ? 'Some terms are fair but key clauses need renegotiation before signing.'
       : 'This deal is at or above market — focus on locking in favorable long-term terms.');

    const entry = {
      id:          Date.now(),
      threadId:    threadId || null,
      subject:     emailData.subject,
      brandName:   emailData.sender || emailData.senderEmail || 'Unknown Brand',
      senderEmail: emailData.senderEmail || '',
      offeredPrice: extractPrice(emailData.body),
      score:       aiData.fairnessScore,
      verdict:     s <= 4 ? 'BELOW MARKET' : s <= 7 ? 'MIXED TERMS' : 'FAIR OFFER',
      agentVerdict: { label: agentVerdict.label, cls: agentVerdict.cls, sub: agentSub },
      risks:          (aiData.detectedRisks ?? []).map(r => ({
                        clause:      r.clause,
                        severity:    (r.severity ?? 'medium').toLowerCase(),
                        explanation: r.explanation || '',
                      })),
      rationale:      rationale,
      drafts:         aiData.drafts          || {},
      score_breakdown: aiData.score_breakdown || [],
      date:           new Date().toISOString(),
    };

    // Replace existing entry for this thread (re-analysis), then cap at 10
    dealHistory = [entry, ...dealHistory.filter(d => d.threadId !== threadId)].slice(0, 10);
    chrome.storage.local.set({ vyntaHistory: dealHistory }).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. SCRAPER
  // ─────────────────────────────────────────────────────────────────────────

  const RED_FLAGS = [
    { pattern: /in perpetuity/i,                                       label: '"In perpetuity"',          detail: 'Permanent content ownership — no expiry date.' },
    { pattern: /throughout the universe/i,                             label: '"Throughout the universe"', detail: 'Unlimited geographic + perpetual scope.' },
    { pattern: /sublicensable/i,                                       label: '"Sublicensable"',           detail: 'Brand can resell your footage to third parties.' },
    { pattern: /train(?:ing)?\s+(?:ai|ml|machine.?learning)\s+model/i, label: '"AI/ML training"',         detail: 'Your voice and likeness used to build AI content.' },
    { pattern: /total\s+buyout/i,                                      label: '"Total buyout"',            detail: 'You forfeit all future revenue from this content.' },
  ];

  function extractEmailData() {
    const messages = document.querySelectorAll('.gs');
    if (!messages.length) return null;

    const msg         = messages[messages.length - 1];
    const subject     = document.querySelector('.hP')?.innerText?.trim() ?? '(No subject)';
    const senderEl    = msg.querySelector('.gD');
    const sender      = senderEl?.getAttribute('name') || senderEl?.innerText?.trim() || 'Unknown sender';
    const senderEmail = senderEl?.getAttribute('email') || '';
    const dateEl      = msg.querySelector('.g3') || msg.querySelector('.xW.xY span[title]');
    const date        = dateEl?.getAttribute('title') || dateEl?.innerText?.trim() || '';
    const bodyEl      = msg.querySelector('.a3s.aiL') || msg.querySelector('.a3s') || msg.querySelector('[dir="ltr"]');
    const rawBody     = bodyEl?.innerText ?? '';
    const body        = cleanBody(rawBody);
    const redFlags    = RED_FLAGS.filter(f => f.pattern.test(`${subject}\n${body}`));

    return { subject, sender, senderEmail, date, body, redFlags, charCount: body.length };
  }

  function cleanBody(raw) {
    const HARD_STOP = [
      /^--\s*$/, /^_{3,}$/, /^-{3,}$/,
      /^On .{5,} wrote:\s*$/i, /^From:\s+.+/i,
      /^Sent from my (iPhone|Android|Mac|Samsung|Pixel)/i,
      /^Get Outlook for/i,
      /^This (email|message) (was sent|is confidential)/i,
    ];
    const SOFT_STOP = [
      /^(best|regards|sincerely|thanks|thank you|cheers|warm regards|kind regards|warmly)[,.]?\s*$/i,
      /^(best wishes|many thanks|with gratitude|all the best|looking forward)[,.]?\s*$/i,
      /^(talk soon|speak soon|ttyl|ciao|bye)[,.]?\s*$/i,
    ];
    const lines = raw.split('\n');
    const out   = [];
    let blanks  = 0;
    for (const line of lines) {
      const t = line.trim();
      if (HARD_STOP.some(p => p.test(t))) break;
      if (SOFT_STOP.some(p => p.test(t))) { if (t) out.push(t); break; }
      if (t.startsWith('>')) continue;
      if (t === '') { blanks++; if (blanks <= 1) out.push(''); continue; }
      blanks = 0;
      out.push(t);
    }
    return out.join('\n').trim();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. DETECTOR
  // ─────────────────────────────────────────────────────────────────────────

  function watchForEmail(onEmailOpen, onEmailClose) {
    let lastUrl       = '';
    let lastThreadId  = null;
    let debounceTimer = null;

    function poll() {
      const currentUrl = window.location.href;
      if (currentUrl === lastUrl) return;
      lastUrl = currentUrl;
      const threadId = getThreadId();
      if (!threadId) {
        if (lastThreadId !== null) { lastThreadId = null; onEmailClose(); }
        return;
      }
      if (threadId === lastThreadId) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const messageEl = document.querySelector('.gs');
        if (!messageEl) return;
        lastThreadId = threadId;
        onEmailOpen(messageEl, threadId);
      }, 500);
    }

    const id = setInterval(poll, 500);
    poll();
    return () => clearInterval(id);
  }

  function getThreadId() {
    const hash = window.location.hash.match(/#[^/]+\/([^/?]+)/);
    if (hash) return hash[1];
    const path = window.location.pathname.match(/\/mail\/[^/]+\/[^/]+\/([^/?]+)/);
    if (path) return path[1];
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. BUTTON
  // ─────────────────────────────────────────────────────────────────────────

  const BUTTON_ID = 'vynta-analyze-btn';

  // Bottom-right FAB position — universally safe whitespace across all Gmail layouts.
  // Gmail's Compose button occupies the bottom-left; bottom-right is intentionally empty
  // across all screen widths, nav states, and density settings.
  const BTN_RIGHT_DEFAULT  = '124px'; // 24px base + 100px left shift
  const BTN_RIGHT_SIDEBAR  = '512px'; // sidebar (412px) + same 100px shift

  function injectButton(onClick) {
    removeButton();
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.textContent = '⚡ Analyze Deal';
    btn.title = 'Open Vynta – AI Deal Agent';
    Object.assign(btn.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'auto',
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '8px 16px',
      background: 'linear-gradient(135deg, #1e40af, #3b82f6)',
      color: '#fff', border: 'none', borderRadius: '20px',
      fontSize: '13px', fontFamily: 'Google Sans, Roboto, sans-serif',
      fontWeight: '600', cursor: 'pointer', letterSpacing: '0.02em',
      boxShadow: '0 2px 12px rgba(59,130,246,0.4)',
      transition: 'right 0.25s ease, box-shadow 0.2s ease, transform 0.2s ease',
      userSelect: 'none', whiteSpace: 'nowrap',
      bottom: '24px', right: BTN_RIGHT_DEFAULT,
    });
    btn.addEventListener('mouseenter', () => {
      btn.style.boxShadow = '0 4px 20px rgba(59,130,246,0.6)';
      btn.style.transform = 'translateY(-1px)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.boxShadow = '0 2px 12px rgba(59,130,246,0.4)';
      btn.style.transform = 'translateY(0)';
    });
    btn.addEventListener('click', (e) => { e.stopImmediatePropagation(); e.preventDefault(); onClick(); }, true);
    document.body.appendChild(btn);
  }

  // Shifts the button left when the sidebar is open so it never hides behind it.
  function repositionButton(sidebarOpen) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    btn.style.right = sidebarOpen ? BTN_RIGHT_SIDEBAR : BTN_RIGHT_DEFAULT;
  }

  function showButton() { const b = document.getElementById(BUTTON_ID); if (b) b.style.display = 'inline-flex'; }
  function hideButton() { const b = document.getElementById(BUTTON_ID); if (b) b.style.display = 'none'; }
  function removeButton() { document.getElementById(BUTTON_ID)?.remove(); }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. INJECTOR — auto-fill Gmail compose
  // ─────────────────────────────────────────────────────────────────────────

  const COMPOSE_SELECTORS = [
    'div[aria-label="Message Body"][contenteditable="true"]',
    'div[g_editable="true"]',
    '.Am.Al.editable[contenteditable="true"]',
    'div[contenteditable="true"].LW-avf',
  ];

  const REPLY_BTN_SELECTORS = [
    '[data-tooltip="Reply"]',
    '[aria-label="Reply"]',
    'span[data-tooltip^="Reply"]',
  ];

  /**
   * Attempts to inject text into an open Gmail compose/reply box.
   * If none is open, clicks the Reply button and retries after a short delay.
   * Returns a promise that resolves with { ok, message }.
   */
  function injectIntoGmailCompose(text) {
    return new Promise(resolve => {
      const result = tryInject(text);
      if (result === 'injected') {
        resolve({ ok: true });
        return;
      }

      // No compose box open — try clicking Reply
      for (const sel of REPLY_BTN_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          // Wait for Gmail to render the compose box
          let attempts = 0;
          const retry = setInterval(() => {
            attempts++;
            if (tryInject(text) === 'injected') {
              clearInterval(retry);
              resolve({ ok: true });
              return;
            }
            if (attempts >= 8) {
              clearInterval(retry);
              resolve({ ok: false, message: 'Could not find reply box. Click Reply in Gmail first, then try again.' });
            }
          }, 300);
          return;
        }
      }

      resolve({ ok: false, message: 'No reply box found. Click Reply in Gmail first, then use the draft.' });
    });
  }

  function tryInject(text) {
    for (const sel of COMPOSE_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.offsetHeight > 0) {
          el.focus();
          // Select all existing content and replace
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          return 'injected';
        }
      }
    }
    return 'not_found';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. SIDEBAR
  // ─────────────────────────────────────────────────────────────────────────

  const SIDEBAR_ID = 'vynta-sidebar-host';

  // Analysis cache — survives sidebar close/reopen on same thread
  let cache = null;


  const SIDEBAR_CSS = `
    /* ── Reset & host ── */
    :host {
      all: initial; display: block; position: fixed; top: 0; right: 0;
      width: 400px; height: 100vh; z-index: 2147483646;
      font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ── Animations ── */
    @keyframes slideIn   { from { transform:translateX(100%); opacity:0; } to { transform:translateX(0); opacity:1; } }
    @keyframes slideOut  { from { transform:translateX(0); opacity:1; } to { transform:translateX(100%); opacity:0; } }
    @keyframes fadeUp    { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    @keyframes pulse     { 0%,100%{opacity:1} 50%{opacity:.35} }
    @keyframes shimmer   { 0%{background-position:-400px 0} 100%{background-position:400px 0} }
    @keyframes spin      { to { transform:rotate(360deg); } }
    @keyframes scaleIn   { from{transform:scale(.92);opacity:0} to{transform:scale(1);opacity:1} }
    @keyframes glow      { 0%,100%{box-shadow:0 0 12px var(--glow)} 50%{box-shadow:0 0 24px var(--glow)} }
    @keyframes settingsIn  { from{transform:translateX(100%)} to{transform:translateX(0)} }
    @keyframes settingsOut { from{transform:translateX(0)} to{transform:translateX(100%)} }
    @keyframes fadeIn      { from{opacity:0} to{opacity:1} }

    /* ── Panel shell ── */
    .panel {
      --bg0:   #0d1117;
      --bg1:   #161b22;
      --bg2:   #1f2937;
      --bg3:   #27303f;
      --bdr:   #2d3748;
      --bdr2:  #374151;
      --acc:   #60a5fa;
      --acc2:  #3b82f6;
      --acc-d: rgba(96,165,250,.15);
      --acc-g: rgba(96,165,250,.25);
      --txt:   #f1f5f9;
      --txt2:  #94a3b8;
      --txt3:  #64748b;
      --red:   #f87171;
      --red-d: rgba(248,113,113,.12);
      --amb:   #fbbf24;
      --amb-d: rgba(251,191,36,.12);
      --grn:   #34d399;
      --grn-d: rgba(52,211,153,.12);

      display: flex; flex-direction: column;
      width: 100%; height: 100%;
      background: var(--bg0);
      border-left: 1px solid var(--bdr);
      box-shadow: -8px 0 40px rgba(0,0,0,.6);
      animation: slideIn .28s cubic-bezier(.16,1,.3,1) forwards;
      overflow: hidden; position: relative;
    }
    .panel.closing { animation: slideOut .22s ease-in forwards; }

    /* ── Header ── */
    .hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px;
      background: linear-gradient(135deg, #1e3a5f 0%, #111827 100%);
      border-bottom: 1px solid var(--bdr);
      flex-shrink: 0; gap: 10px;
    }
    .hdr-left  { display:flex; align-items:center; gap:10px; }
    .hdr-right { display:flex; align-items:center; gap:6px; }
    .logo      { font-size:20px; filter:drop-shadow(0 0 6px rgba(96,165,250,.6)); }
    .hdr-title { font-size:15px; font-weight:700; color:var(--txt); letter-spacing:.01em; }
    .hdr-sub   { font-size:10px; color:var(--acc); font-weight:500; letter-spacing:.08em; text-transform:uppercase; margin-top:1px; }

    .profile-chip {
      display:inline-flex; align-items:center; gap:4px;
      padding:3px 8px; background:var(--acc-d); border:1px solid var(--acc-g);
      border-radius:99px; font-size:10px; color:var(--acc); font-weight:600;
      letter-spacing:.04em;
    }

    .icon-btn {
      background:none; border:none; color:#fff; cursor:pointer;
      padding:6px; border-radius:6px; display:flex; align-items:center;
      justify-content:center; font-size:18px; transition:color .15s, background .15s;
    }
    .icon-btn:hover { color:#fff; background:rgba(255,255,255,.15); }

    /* ── Body ── */
    .body {
      flex:1; overflow-y:auto; padding:16px; display:flex;
      flex-direction:column; gap:16px;
      scrollbar-width:thin; scrollbar-color:var(--bdr) transparent;
    }
    .body::-webkit-scrollbar { width:4px; }
    .body::-webkit-scrollbar-thumb { background:var(--bdr); border-radius:99px; }

    /* ── Card base ── */
    .card {
      background:var(--bg1); border:1px solid var(--bdr);
      border-radius:12px; padding:14px;
      animation: fadeUp .3s ease forwards;
    }
    .card:hover { border-color:var(--bdr2); }

    .sec-label {
      font-size:9px; font-weight:700; color:var(--txt3);
      text-transform:uppercase; letter-spacing:.12em; margin-bottom:8px;
    }

    /* ── Scanning state ── */
    .scanning {
      display:flex; flex-direction:column; align-items:center;
      gap:14px; padding:40px 20px; text-align:center;
    }
    .scan-icon   { font-size:32px; animation:pulse 1.4s ease-in-out infinite; }
    .scan-label  { font-size:15px; font-weight:600; color:var(--acc); }
    .scan-sub    { font-size:12px; color:var(--txt3); }
    .shimmer-bar { width:100%; height:3px; background:var(--bg2); border-radius:99px; overflow:hidden; }
    .shimmer-bar::after {
      content:''; display:block; height:100%;
      background:linear-gradient(90deg,var(--bg2) 25%,var(--acc) 50%,var(--bg2) 75%);
      background-size:400px 100%; animation:shimmer 1.6s infinite linear;
    }

    /* ── AI loading ── */
    .ai-loading {
      display:flex; flex-direction:column; align-items:center;
      gap:14px; padding:40px 20px; text-align:center;
    }
    .spinner {
      width:36px; height:36px; border-radius:50%;
      border:2px solid var(--bdr); border-top-color:var(--acc);
      animation:spin .7s linear infinite;
    }
    .ai-load-label { font-size:15px; font-weight:600; color:var(--acc); transition:all .4s ease; }
    .ai-load-sub   { font-size:12px; color:var(--txt3); max-width:260px; line-height:1.5; transition:all .4s ease; }
    .ai-progress-wrap { width:80%; }
    .ai-progress-track { width:100%; height:3px; background:var(--bg2); border-radius:99px; overflow:hidden; }
    .ai-progress-fill  {
      height:100%; border-radius:99px; background:var(--acc);
      width:4%;
      transition: width 8s cubic-bezier(.1,0,.3,1);
    }
    .ai-progress-fill.step1 { width:20%; transition-duration:8s; }
    .ai-progress-fill.step2 { width:38%; transition-duration:8s; }
    .ai-progress-fill.step3 { width:55%; transition-duration:8s; }
    .ai-progress-fill.step4 { width:70%; transition-duration:8s; }
    .ai-progress-fill.step5 { width:85%; transition-duration:10s; }
    .ai-progress-fill.step6 { width:93%; transition-duration:10s; }
    .ai-timeout-note { font-size:10px; color:var(--txt3); margin-top:4px; }

    /* ── Phase-2 result ── */
    .subject-text { font-size:14px; font-weight:600; color:var(--txt); word-break:break-word; line-height:1.4; }
    .meta-row     { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
    .meta-chip    { background:var(--bg2); border:1px solid var(--bdr); border-radius:99px; padding:2px 9px; font-size:10px; color:var(--txt2); }

    .flags-card   { background:var(--red-d); border-color:rgba(248,113,113,.25); }
    .flags-hdr    { font-size:12px; font-weight:700; color:var(--red); margin-bottom:10px; display:flex; align-items:center; gap:6px; }
    .flag-item    { padding:8px 0; border-top:1px solid rgba(248,113,113,.15); }
    .flag-item:first-child { border-top:none; padding-top:0; }
    .flag-lbl     { font-size:11px; font-weight:700; color:var(--red); margin-bottom:2px; }
    .flag-dtl     { font-size:11px; color:var(--txt3); line-height:1.4; }
    .no-flags     { background:var(--grn-d); border-color:rgba(52,211,153,.2); color:var(--grn); font-size:12px; font-weight:500; display:flex; align-items:center; gap:8px; }

    .preview-text {
      font-size:11px; color:var(--txt2); line-height:1.6;
      white-space:pre-wrap; word-break:break-word;
      max-height:140px; overflow-y:auto; font-family:ui-monospace,'Cascadia Code',monospace;
      scrollbar-width:thin; scrollbar-color:var(--bdr) transparent;
    }
    .preview-meta { font-size:10px; color:var(--txt3); margin-top:6px; }

    /* ── Analyze AI button ── */
    .ai-btn {
      width:100%; padding:12px; border:none; border-radius:10px;
      background:linear-gradient(135deg,#1d4ed8,#3b82f6);
      color:#fff; font-size:14px; font-weight:600; font-family:inherit;
      cursor:pointer; display:flex; align-items:center; justify-content:center;
      gap:8px; transition:all .2s ease;
      box-shadow:0 4px 14px rgba(59,130,246,.35);
      letter-spacing:.01em;
    }
    .ai-btn:hover    { background:linear-gradient(135deg,#1e40af,#2563eb); box-shadow:0 6px 20px rgba(59,130,246,.5); transform:translateY(-1px); }
    .ai-btn:disabled { background:var(--bg2); color:var(--txt3); box-shadow:none; transform:none; cursor:not-allowed; }

    /* ── Score card ── */
    .score-card   { display:flex; flex-direction:column; align-items:center; gap:14px; }
    .score-circle {
      --glow: rgba(96,165,250,.4);
      width:96px; height:96px; border-radius:50%;
      border:3px solid var(--score-clr, var(--acc));
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      animation:scaleIn .4s cubic-bezier(.34,1.56,.64,1) forwards, glow 2.5s ease-in-out 0.5s infinite;
    }
    .score-num    { font-size:38px; font-weight:800; color:var(--score-clr,var(--acc)); line-height:1; font-variant-numeric:tabular-nums; }
    .score-den    { font-size:11px; color:var(--txt3); }
    .score-bar-wrap { width:100%; }
    .score-track  { width:100%; height:5px; background:var(--bg2); border-radius:99px; overflow:hidden; }
    .score-fill   { height:100%; border-radius:99px; background:var(--score-clr,var(--acc)); transition:width .8s cubic-bezier(.34,1,.64,1); }
    .score-ticks  { display:flex; justify-content:space-between; margin-top:4px; font-size:9px; color:var(--txt3); }
    .score-verdict { font-size:13px; font-weight:700; color:var(--score-clr,var(--acc)); letter-spacing:.04em; text-transform:uppercase; }
    .score-rationale { font-size:11px; color:var(--txt2); line-height:1.6; text-align:center; }

    /* ── Verdict banner ── */
    .verdict-banner {
      width:100%; border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:6px;
      animation:fadeIn .35s ease forwards;
    }
    .verdict-banner-title {
      font-size:14px; font-weight:800; letter-spacing:.04em; line-height:1.3;
    }
    .verdict-banner-sub {
      font-size:11px; line-height:1.55; opacity:.9;
    }
    .verdict-banner.vb-red    { background:#FF4D4D; color:#fff; }
    .verdict-banner.vb-yellow { background:#FFD700; color:#1a1a1a; }
    .verdict-banner.vb-green  { background:#28A745; color:#fff; }
    .score-profile-note { font-size:10px; color:var(--txt3); background:var(--bg2); border:1px solid var(--bdr); border-radius:6px; padding:6px 10px; width:100%; text-align:center; }

    /* ── Score breakdown ── */
    .breakdown-list  { width:100%; display:flex; flex-direction:column; gap:3px; }
    .breakdown-item  { display:flex; justify-content:space-between; align-items:center; padding:4px 8px; border-radius:6px; }
    .breakdown-item.pos { background:rgba(52,211,153,.08); }
    .breakdown-item.neg { background:rgba(248,113,113,.08); }
    .breakdown-item.neu { background:var(--bg2); }
    .breakdown-label { font-size:11px; color:var(--txt2); flex:1; }
    .breakdown-value { font-size:11px; font-weight:700; font-variant-numeric:tabular-nums; flex-shrink:0; margin-left:8px; }
    .breakdown-value.pos { color:var(--grn); }
    .breakdown-value.neg { color:var(--red); }
    .breakdown-value.neu { color:var(--txt3); }
    .breakdown-toggle { font-size:10px; color:var(--acc); background:none; border:none; cursor:pointer; padding:2px 0; font-family:inherit; letter-spacing:.04em; align-self:flex-start; }
    .breakdown-toggle:hover { text-decoration:underline; }

    /* ── Risks ── */
    .risk-item   { padding:8px 0; border-top:1px solid var(--bdr); }
    .risk-item:first-child { border-top:none; padding-top:0; }
    .risk-hdr    { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:4px; }
    .risk-clause { font-size:11px; font-weight:700; color:var(--txt); }
    .sev-badge   { font-size:9px; font-weight:700; padding:2px 7px; border-radius:99px; text-transform:uppercase; letter-spacing:.05em; flex-shrink:0; }
    .sev-critical, .sev-high    { background:var(--red-d); color:var(--red); border:1px solid rgba(248,113,113,.3); }
    .sev-medium  { background:var(--amb-d); color:var(--amb); border:1px solid rgba(251,191,36,.3); }
    .sev-low     { background:var(--grn-d); color:var(--grn); border:1px solid rgba(52,211,153,.3); }
    .risk-exp    { font-size:11px; color:var(--txt3); line-height:1.4; }

    /* ── Draft tabs ── */
    .tab-bar {
      display:flex; border-bottom:1px solid var(--bdr); margin-bottom:12px;
    }
    .tab-btn {
      flex:1; padding:8px 4px; border:none; background:none; font-family:inherit;
      font-size:11px; font-weight:600; color:var(--txt3); cursor:pointer;
      border-bottom:2px solid transparent; margin-bottom:-1px;
      transition:color .15s, border-color .15s; letter-spacing:.03em;
    }
    .tab-btn:hover  { color:var(--txt2); }
    .tab-btn.active { color:var(--acc);  border-bottom-color:var(--acc); }

    .draft-pane  { display:flex; flex-direction:column; gap:8px; }
    .draft-text  {
      font-size:12px; color:var(--txt2); line-height:1.65;
      white-space:pre-wrap; word-break:break-word;
      max-height:240px; overflow-y:auto;
      background:var(--bg0); border:1px solid var(--bdr);
      border-radius:8px; padding:12px;
      scrollbar-width:thin; scrollbar-color:var(--bdr) transparent;
    }
    .draft-actions { display:flex; gap:8px; }

    .copy-btn, .use-btn {
      flex:1; padding:7px 12px; border-radius:8px; font-size:12px;
      font-weight:600; font-family:inherit; cursor:pointer;
      transition:all .18s ease; display:flex; align-items:center;
      justify-content:center; gap:5px;
    }
    .copy-btn {
      border:1px solid var(--bdr2); background:var(--bg2); color:var(--txt2);
    }
    .copy-btn:hover  { border-color:var(--acc); color:var(--acc); background:var(--acc-d); }
    .copy-btn.copied { border-color:var(--grn); color:var(--grn); background:var(--grn-d); }

    .use-btn {
      border:1px solid var(--acc2); background:var(--acc-d); color:var(--acc);
    }
    .use-btn:hover { background:var(--acc2); color:#fff; box-shadow:0 4px 12px rgba(59,130,246,.3); }
    .use-btn.injected { border-color:var(--grn); background:var(--grn-d); color:var(--grn); }
    .use-btn.failed   { border-color:var(--red); background:var(--red-d); color:var(--red); }

    /* ── Analyze again ── */
    .again-btn {
      width:100%; padding:9px; border:1px solid var(--bdr2); border-radius:10px;
      background:transparent; color:var(--txt3); font-size:12px; font-weight:600;
      font-family:inherit; cursor:pointer; display:flex; align-items:center;
      justify-content:center; gap:6px; transition:all .18s;
    }
    .again-btn:hover { border-color:var(--acc); color:var(--acc); background:var(--acc-d); }

    /* ── Error state ── */
    .error-card  { background:var(--red-d); border-color:rgba(248,113,113,.25); }
    .error-title { font-size:13px; font-weight:700; color:var(--red); margin-bottom:6px; }
    .error-msg   { font-size:12px; color:var(--txt2); line-height:1.5; word-break:break-word; }

    .setup-card  { background:var(--acc-d); border-color:var(--acc-g); }
    .setup-title { font-size:13px; font-weight:700; color:var(--acc); margin-bottom:8px; }
    .setup-steps { font-size:12px; color:var(--txt2); line-height:1.8; }
    .setup-steps li { margin-left:14px; }

    /* ── Toast ── */
    .toast {
      position:absolute; bottom:70px; left:50%; transform:translateX(-50%);
      background:var(--bg3); border:1px solid var(--bdr2); border-radius:10px;
      padding:8px 16px; font-size:12px; color:var(--txt);
      white-space:nowrap; pointer-events:none; opacity:0;
      transition:opacity .2s; z-index:10;
    }
    .toast.show { opacity:1; }

    /* ── Settings overlay ── */
    .settings-overlay {
      position:absolute; inset:0; background:var(--bg0);
      display:flex; flex-direction:column; z-index:5;
      animation:settingsIn .25s cubic-bezier(.16,1,.3,1) forwards;
    }
    .settings-overlay.closing { animation:settingsOut .2s ease-in forwards; }

    .settings-hdr {
      display:flex; align-items:center; gap:10px;
      padding:14px 16px;
      background:linear-gradient(135deg,#1e3a5f 0%,#111827 100%);
      border-bottom:1px solid var(--bdr); flex-shrink:0;
    }
    .settings-title { font-size:15px; font-weight:700; color:var(--txt); }

    .settings-body  { flex:1; overflow-y:auto; padding:20px 16px; display:flex; flex-direction:column; gap:20px; }

    .field-group    { display:flex; flex-direction:column; gap:6px; }
    .field-label    { font-size:11px; font-weight:600; color:var(--txt2); letter-spacing:.05em; }
    .field-hint     { font-size:10px; color:var(--txt3); line-height:1.4; }

    .field-input, .field-select {
      background:var(--bg1); border:1px solid var(--bdr); border-radius:8px;
      padding:10px 12px; color:var(--txt); font-size:13px; font-family:inherit;
      outline:none; transition:border-color .15s, box-shadow .15s; width:100%;
      appearance:none; -webkit-appearance:none;
    }
    .field-input::placeholder { color:var(--txt3); }
    .field-input:focus, .field-select:focus {
      border-color:var(--acc); box-shadow:0 0 0 3px var(--acc-d);
    }
    option { background:var(--bg1); color:var(--txt); }

    .save-btn {
      width:100%; padding:12px; border:none; border-radius:10px;
      background:linear-gradient(135deg,#1d4ed8,#3b82f6);
      color:#fff; font-size:14px; font-weight:600; font-family:inherit;
      cursor:pointer; transition:all .2s;
      box-shadow:0 4px 14px rgba(59,130,246,.3); letter-spacing:.01em;
    }
    .save-btn:hover { box-shadow:0 6px 20px rgba(59,130,246,.5); transform:translateY(-1px); }

    .profile-summary {
      background:var(--bg1); border:1px solid var(--bdr); border-radius:10px;
      padding:12px; display:flex; flex-direction:column; gap:4px;
    }
    .profile-summary-label { font-size:9px; color:var(--txt3); text-transform:uppercase; letter-spacing:.1em; }
    .profile-summary-val   { font-size:13px; color:var(--txt); font-weight:500; }

    /* ── AI Config section (inside Settings) ── */
    .api-steps-box {
      background:var(--bg2); border:1px solid var(--bdr); border-radius:10px;
      padding:12px 14px; display:flex; flex-direction:column; gap:8px;
    }
    .api-steps-title { font-size:10px; font-weight:700; color:var(--txt2); text-transform:uppercase; letter-spacing:.08em; margin-bottom:2px; }
    .api-step { display:flex; gap:8px; align-items:flex-start; }
    .api-step-num {
      flex-shrink:0; width:18px; height:18px; border-radius:50%;
      background:var(--acc-d); border:1px solid var(--acc-g);
      font-size:9px; font-weight:800; color:var(--acc);
      display:flex; align-items:center; justify-content:center;
    }
    .api-step-txt { font-size:11px; color:var(--txt2); line-height:1.5; padding-top:1px; }
    .api-step-txt strong { color:var(--acc); font-weight:600; }

    .api-key-wrap { display:flex; flex-direction:column; gap:6px; }
    .api-key-row  { display:flex; gap:6px; align-items:stretch; }
    .api-key-row .field-input {
      flex:1; font-family:ui-monospace,'Cascadia Code',monospace;
      font-size:11px; letter-spacing:.03em; min-width:0;
    }

    .test-btn {
      flex-shrink:0; padding:10px 12px; border-radius:8px;
      border:1px solid var(--bdr2); background:var(--bg2); color:var(--txt2);
      font-size:11px; font-weight:600; font-family:inherit;
      cursor:pointer; transition:all .18s; white-space:nowrap;
    }
    .test-btn:hover    { border-color:var(--acc); color:var(--acc); background:var(--acc-d); }
    .test-btn:disabled { opacity:.45; cursor:not-allowed; }
    .test-btn.ok       { border-color:var(--grn); color:var(--grn); background:var(--grn-d); }
    .test-btn.fail     { border-color:var(--red); color:var(--red); background:var(--red-d); }

    .key-status {
      font-size:10px; border-radius:6px; padding:5px 10px;
      line-height:1.4; display:none;
    }
    .key-status.visible { display:block; }
    .key-status.ok   { background:var(--grn-d); color:var(--grn); border:1px solid rgba(52,211,153,.25); }
    .key-status.fail { background:var(--red-d); color:var(--red); border:1px solid rgba(248,113,113,.25); }

    .api-privacy-note {
      font-size:10px; color:var(--txt3); background:var(--bg2);
      border:1px solid var(--bdr); border-radius:8px;
      padding:8px 12px; line-height:1.5; display:flex; gap:7px; align-items:flex-start;
    }
    .api-privacy-icon { flex-shrink:0; font-size:12px; margin-top:1px; }

    /* ── No-key gate card ── */
    .no-key-card {
      background:var(--acc-d); border:1px solid var(--acc-g); border-radius:12px;
      padding:16px; display:flex; flex-direction:column; gap:10px;
    }
    .no-key-title { font-size:13px; font-weight:700; color:var(--acc); }
    .no-key-body  { font-size:12px; color:var(--txt2); line-height:1.6; }
    .no-key-open-settings {
      width:100%; padding:10px; border:none; border-radius:9px;
      background:linear-gradient(135deg,#1d4ed8,#3b82f6);
      color:#fff; font-size:13px; font-weight:600; font-family:inherit;
      cursor:pointer; transition:all .18s;
      box-shadow:0 3px 10px rgba(59,130,246,.3);
    }
    .no-key-open-settings:hover { box-shadow:0 5px 16px rgba(59,130,246,.5); transform:translateY(-1px); }

    /* ── Footer ── */
    .footer {
      padding:8px 16px 10px; border-top:1px solid var(--bdr);
      flex-shrink:0; display:flex; flex-direction:column; align-items:center; gap:5px;
    }
    .footer-top {
      display:flex; align-items:center; justify-content:space-between; width:100%;
    }
    .footer-wordmark {
      font-size:10px; color:var(--txt2); letter-spacing:.04em;
    }
    .feedback-btn {
      background:none; border:1px solid rgba(255,255,255,.25); border-radius:99px;
      color:#fff; font-size:10px; font-family:inherit; font-weight:600;
      padding:3px 10px; cursor:pointer; transition:all .18s; letter-spacing:.03em;
    }
    .feedback-btn:hover { border-color:var(--acc); color:var(--acc); background:var(--acc-d); }
    .footer-tagline {
      font-size:9px; color:#fff; opacity:.85; letter-spacing:.02em; font-style:italic;
    }

    /* ── Main tabs (Analysis / History) ── */
    .main-tabs { display:flex; border-bottom:1px solid var(--bdr); flex-shrink:0; background:var(--bg0); }
    .main-tab {
      flex:1; padding:10px 4px; border:none; background:none; font-family:inherit;
      font-size:12px; font-weight:600; color:var(--txt3); cursor:pointer;
      border-bottom:2px solid transparent; margin-bottom:-1px;
      transition:color .15s, border-color .15s; letter-spacing:.03em;
    }
    .main-tab:hover  { color:var(--txt2); }
    .main-tab.active { color:var(--acc); border-bottom-color:var(--acc); }

    /* ── History panel ── */
    .hist-panel {
      flex:1; overflow-y:auto; padding:16px; display:flex;
      flex-direction:column; gap:10px;
      scrollbar-width:thin; scrollbar-color:var(--bdr) transparent;
    }
    .hist-empty      { text-align:center; padding:40px 20px; color:var(--txt3); font-size:13px; line-height:1.6; }
    .hist-empty-icon { font-size:32px; margin-bottom:12px; }
    .hist-list       { display:flex; flex-direction:column; gap:8px; }

    .hist-item {
      display:flex; align-items:center; gap:10px;
      background:var(--bg1); border:1px solid var(--bdr);
      border-radius:10px; padding:10px 12px; transition:border-color .15s;
      cursor:pointer;
    }
    .hist-item:hover    { border-color:var(--bdr2); }
    .hist-item.selected { border-color:var(--acc); background:var(--acc-d); }
    .hist-check  { width:16px; height:16px; accent-color:var(--acc); cursor:pointer; flex-shrink:0; }
    .hist-info   { flex:1; min-width:0; }
    .hist-brand  { font-size:13px; font-weight:600; color:var(--txt); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .hist-meta   { font-size:10px; color:var(--txt3); margin-top:2px; }
    .hist-score  { font-size:15px; font-weight:800; flex-shrink:0; font-variant-numeric:tabular-nums; }

    .hist-footer { display:flex; flex-direction:column; gap:8px; margin-top:4px; flex-shrink:0; }
    .compare-btn {
      width:100%; padding:9px; border:1px solid var(--acc-g); border-radius:10px;
      background:var(--acc-d); color:var(--acc); font-size:12px; font-weight:600;
      font-family:inherit; cursor:pointer; transition:all .18s; letter-spacing:.02em;
    }
    .compare-btn:hover    { background:var(--acc2); color:#fff; box-shadow:0 4px 12px rgba(59,130,246,.3); }
    .compare-btn:disabled { opacity:.4; cursor:not-allowed; background:var(--acc-d); color:var(--acc); box-shadow:none; }

    /* ── Comparison table ── */
    .compare-wrap   { overflow-x:auto; border-radius:8px; border:1px solid var(--bdr); }
    .compare-table  { width:100%; border-collapse:collapse; font-size:11px; }
    .compare-table th {
      background:var(--bg2); color:var(--txt2); font-weight:700; padding:8px 10px;
      text-align:left; border-bottom:1px solid var(--bdr);
      font-size:10px; letter-spacing:.06em; text-transform:uppercase;
    }
    .compare-table th:first-child { width:90px; }
    .compare-table td { padding:8px 10px; border-top:1px solid var(--bdr); color:var(--txt); vertical-align:top; }
    .compare-table .field-col { color:var(--txt3); font-weight:600; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:var(--bg1); }
    .compare-back-btn {
      background:none; border:none; color:var(--acc); cursor:pointer;
      font-family:inherit; font-size:12px; font-weight:600; padding:0;
    }
    .compare-back-btn:hover { text-decoration:underline; }

    /* ── Benchmark line ── */
    .bench-line {
      width:100%; padding:7px 12px; border-radius:8px; font-size:11px;
      font-weight:500; line-height:1.4; text-align:center;
      background:var(--bg2); color:var(--txt2); border:1px solid var(--bdr);
    }
    .bench-line.better  { color:var(--grn); background:var(--grn-d); border-color:rgba(52,211,153,.2); }
    .bench-line.worse   { color:var(--red); background:var(--red-d); border-color:rgba(248,113,113,.2); }

    /* ── History detail view ── */
    .hist-detail        { display:flex; flex-direction:column; gap:14px; }
    .hist-detail-back   { background:none; border:none; color:var(--acc); cursor:pointer; font-family:inherit; font-size:12px; font-weight:600; padding:0; letter-spacing:.02em; }
    .hist-detail-back:hover { text-decoration:underline; }
    .hist-detail-top    { display:flex; align-items:flex-start; gap:14px; }
    .hist-detail-scores { display:flex; flex-direction:column; align-items:center; gap:2px; flex-shrink:0; }
    .hist-detail-num    { font-size:44px; font-weight:800; line-height:1; font-variant-numeric:tabular-nums; }
    .hist-detail-den    { font-size:11px; color:var(--txt3); }
    .hist-detail-meta   { flex:1; display:flex; flex-direction:column; gap:5px; justify-content:center; }
    .hist-detail-brand  { font-size:15px; font-weight:700; color:var(--txt); }
    .hist-detail-subj   { font-size:11px; color:var(--txt3); line-height:1.4; }
    .hist-detail-chips  { display:flex; flex-wrap:wrap; gap:5px; }
    .hist-detail-verdict { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; padding:2px 8px; border-radius:99px; }

    /* ── Restored-from-history badge ── */
    .restored-badge {
      font-size:10px; color:var(--txt3); text-align:center;
      padding:5px 10px; border-radius:8px; background:var(--bg2);
      border:1px solid var(--bdr); line-height:1.5;
    }

    /* ── Clear history button ── */
    .clear-hist-btn {
      width:100%; padding:10px; border:1px solid rgba(248,113,113,.3); border-radius:10px;
      background:var(--red-d); color:var(--red); font-size:13px; font-weight:600;
      font-family:inherit; cursor:pointer; transition:all .2s;
    }
    .clear-hist-btn:hover { background:var(--red); color:#fff; }

    /* ── Export PDF button ── */
    .export-btn {
      width:100%; padding:9px 14px; border-radius:10px;
      border:1px solid rgba(96,165,250,.35);
      background:rgba(96,165,250,.07); color:var(--acc);
      font-size:12px; font-weight:600; font-family:inherit;
      cursor:pointer; display:flex; align-items:center;
      justify-content:center; gap:6px; transition:all .18s;
      letter-spacing:.02em;
    }
    .export-btn:hover    { border-color:var(--acc); background:var(--acc-d); box-shadow:0 2px 10px rgba(96,165,250,.2); transform:translateY(-1px); }
    .export-btn:disabled { opacity:.45; cursor:not-allowed; transform:none; box-shadow:none; }

    .hidden { display:none !important; }
  `;

  let sidebarHost = null;
  let shadowRoot  = null;
  let panelEl     = null;

  // Deal history — in-memory cache of chrome.storage.local 'vyntaHistory'
  let dealHistory = [];

  // ── Open / close / toggle ────────────────────────────────────────────────

  function openSidebar(messageEl, threadId) {
    const memHit  = cache && cache.threadId === threadId;
    const histHit = !memHit && dealHistory.find(d => d.threadId === threadId);

    if (isSidebarOpen()) {
      if (!memHit) { showScanningState(); runScan(messageEl, threadId, histHit || null); }
      return;
    }

    sidebarHost = document.createElement('div');
    sidebarHost.id = SIDEBAR_ID;
    shadowRoot = sidebarHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SIDEBAR_CSS;
    shadowRoot.appendChild(style);
    shadowRoot.appendChild(buildPanel(messageEl, threadId));

    document.body.appendChild(sidebarHost);
    panelEl = shadowRoot.querySelector('.panel');
    hideButton();
    repositionButton(true);

    if (memHit) {
      setTimeout(() => {
        showPhase2Result(cache.phase2Data, threadId);
        if (cache.aiData) showAIResult(cache.aiData, cache.phase2Data);
      }, 60);
    } else {
      setTimeout(() => runScan(messageEl, threadId, histHit || null), 300);
    }
  }

  function closeSidebar() {
    if (!isSidebarOpen()) return;
    panelEl.classList.add('closing');
    panelEl.addEventListener('animationend', () => {
      sidebarHost?.remove();
      sidebarHost = null; shadowRoot = null; panelEl = null;
      showButton();
      repositionButton(false);
    }, { once: true });
  }

  function toggleSidebar(messageEl, threadId) {
    isSidebarOpen() ? closeSidebar() : openSidebar(messageEl, threadId);
  }

  function isSidebarOpen() { return !!document.getElementById(SIDEBAR_ID); }

  // ── Build panel skeleton ─────────────────────────────────────────────────

  function buildPanel(messageEl, threadId) {
    const panel = document.createElement('div');
    panel.className = 'panel';

    const hasProfile = !!(rateProfile.followerCount || rateProfile.niche);
    const profileChip = hasProfile
      ? `<span class="profile-chip">◎ ${profileShortLabel()}</span>`
      : '';

    panel.innerHTML = `
      <header class="hdr">
        <div class="hdr-left">
          <span class="logo">⚡</span>
          <div>
            <div class="hdr-title">Vynta</div>
            <div class="hdr-sub">AI Deal Defender</div>
          </div>
        </div>
        <div class="hdr-right">
          ${profileChip}
          <button class="icon-btn" id="neg-settings-btn" title="Rate Card Settings">⚙</button>
          <button class="icon-btn" id="neg-close-btn" title="Close">✕</button>
        </div>
      </header>

      <!-- Main tab bar -->
      <div class="main-tabs">
        <button class="main-tab active" id="neg-tab-analysis">⚡ Analysis</button>
        <button class="main-tab" id="neg-tab-history">📋 History</button>
      </div>

      <main class="body" id="neg-analysis-panel">

        <!-- Scanning -->
        <div class="scanning" id="neg-scanning">
          <span class="scan-icon">🔍</span>
          <span class="scan-label">Scanning email…</span>
          <span class="scan-sub">Reading subject, body, and legal clauses</span>
          <div class="shimmer-bar"></div>
        </div>

        <!-- Phase-2 result -->
        <div id="neg-p2" class="hidden" style="display:flex;flex-direction:column;gap:16px;">

          <div class="card">
            <p class="sec-label">From</p>
            <p class="subject-text" id="neg-subject"></p>
            <div class="meta-row" id="neg-meta"></div>
          </div>

          <div id="neg-flags-wrap"></div>

          <div class="card">
            <p class="sec-label">Email body — cleaned</p>
            <pre class="preview-text" id="neg-body"></pre>
            <p class="preview-meta" id="neg-chars"></p>
          </div>

          <!-- Shown when API key is not configured -->
          <div id="neg-no-key-card" class="no-key-card hidden">
            <p class="no-key-title">🔑 API Key Required</p>
            <p class="no-key-body">To run AI analysis, you need a free Anthropic API key. It takes about 2 minutes to set up and costs as little as $5 in credits.</p>
            <button class="no-key-open-settings" id="neg-open-settings-from-gate">⚙ Add API Key in Settings</button>
          </div>

          <!-- Shown when Rate Card is not set -->
          <div id="neg-profile-required" class="card hidden" style="background:var(--amb-d);border-color:rgba(251,191,36,.25);gap:6px;display:flex;flex-direction:column;">
            <p style="font-size:12px;font-weight:700;color:var(--amb)">⚙ Rate Card required</p>
            <p style="font-size:11px;color:var(--txt2);line-height:1.5">Add your follower count and niche so the scoring engine can calibrate to your tier before analyzing.</p>
            <button class="ai-btn" id="neg-open-rate-card" style="margin-top:4px;background:linear-gradient(135deg,#92400e,#d97706)">⚙ Open Rate Card Settings</button>
          </div>

          <button class="ai-btn" id="neg-ai-btn">🤖 Analyze with AI</button>

        </div>

        <!-- AI loading -->
        <div class="ai-loading hidden" id="neg-ai-loading">
          <div class="spinner"></div>
          <span class="ai-load-label">Analyzing with AI…</span>
          <span class="ai-load-sub">The Vossian Agent is benchmarking deal terms against 2026 market rates.</span>
          <div class="ai-progress-wrap">
            <div class="ai-progress-track">
              <div class="ai-progress-fill" id="neg-progress-fill"></div>
            </div>
          </div>
          <span class="ai-timeout-note">Times out after 2 minutes</span>
        </div>

        <!-- AI result -->
        <div id="neg-ai-result" class="hidden" style="display:flex;flex-direction:column;gap:16px;">

          <!-- Verdict banner — injected at top of results -->
          <div class="verdict-banner hidden" id="neg-verdict-banner">
            <span class="verdict-banner-title" id="neg-verdict-title"></span>
            <span class="verdict-banner-sub"   id="neg-verdict-sub"></span>
          </div>

          <div class="card score-card" id="neg-score-card">
            <p class="sec-label" style="align-self:flex-start">Fairness Score</p>
            <div class="score-circle" id="neg-score-circle">
              <span class="score-num" id="neg-score-num">0</span>
              <span class="score-den">/ 10</span>
            </div>
            <div class="score-bar-wrap">
              <div class="score-track"><div class="score-fill" id="neg-score-bar" style="width:0%"></div></div>
              <div class="score-ticks"><span>Predatory</span><span>Mixed</span><span>Fair</span></div>
            </div>
            <span class="score-verdict" id="neg-score-verdict"></span>
            <p class="score-rationale" id="neg-score-rationale"></p>
            <button class="breakdown-toggle hidden" id="neg-breakdown-toggle">▸ Show score reasoning</button>
            <div class="breakdown-list hidden" id="neg-score-breakdown"></div>
            <p class="score-profile-note hidden" id="neg-profile-note"></p>
            <div class="bench-line hidden" id="neg-bench-line"></div>
          </div>

          <div id="neg-risks-wrap"></div>

          <div class="card">
            <p class="sec-label">Response Drafts</p>
            <div class="tab-bar">
              <button class="tab-btn active" data-tab="professional">Professional</button>
              <button class="tab-btn"        data-tab="collaborator">Collaborator</button>
              <button class="tab-btn"        data-tab="hardBaller">Hard-Baller</button>
            </div>

            <div id="tab-professional" class="draft-pane">
              <pre class="draft-text" id="draft-professional"></pre>
              <div class="draft-actions">
                <button class="copy-btn" data-draft="professional">📋 Copy</button>
                <button class="use-btn"  data-draft="professional">↳ Use Draft</button>
              </div>
            </div>
            <div id="tab-collaborator" class="draft-pane hidden">
              <pre class="draft-text" id="draft-collaborator"></pre>
              <div class="draft-actions">
                <button class="copy-btn" data-draft="collaborator">📋 Copy</button>
                <button class="use-btn"  data-draft="collaborator">↳ Use Draft</button>
              </div>
            </div>
            <div id="tab-hardBaller" class="draft-pane hidden">
              <pre class="draft-text" id="draft-hardBaller"></pre>
              <div class="draft-actions">
                <button class="copy-btn" data-draft="hardBaller">📋 Copy</button>
                <button class="use-btn"  data-draft="hardBaller">↳ Use Draft</button>
              </div>
            </div>
          </div>

          <button class="again-btn" id="neg-analyze-again">🔄 Analyze Again</button>
          <button class="export-btn" id="neg-export-btn">📄 Export PDF Report</button>
          <div class="restored-badge hidden" id="neg-restored-badge">
            📂 Restored from history — click Re-analyze for fresh drafts
          </div>

        </div>

        <!-- Error -->
        <div id="neg-error" class="hidden">
          <div class="card error-card" id="neg-error-card">
            <p class="error-title" id="neg-error-title">Analysis failed</p>
            <p class="error-msg"   id="neg-error-msg"></p>
          </div>
          <button class="again-btn" id="neg-analyze-again-err" style="margin-top:12px">🔄 Try Again</button>
        </div>

      </main>

      <!-- Deal History panel -->
      <div class="hist-panel hidden" id="neg-hist-panel">
        <div id="neg-hist-list">
          <div class="hist-empty">
            <div class="hist-empty-icon">📋</div>
            <div>No deals analyzed yet.</div>
            <div style="font-size:11px;margin-top:6px;color:var(--txt3)">Analyze a brand deal email to start building your history.</div>
          </div>
        </div>
        <div class="hist-footer hidden" id="neg-hist-footer">
          <button class="compare-btn" id="neg-compare-btn" disabled>⚖ Select 1 more to compare</button>
        </div>
      </div>


      <!-- Toast -->
      <div class="toast" id="neg-toast"></div>

      <footer class="footer">
        <div class="footer-top">
          <span class="footer-wordmark">VYNTA · v1.0 · Community Edition</span>
          <button class="feedback-btn" id="neg-feedback-btn">💬 Give Feedback</button>
        </div>
        <span class="footer-tagline">Built by a student developer for the creator community.</span>
      </footer>

      <!-- Settings overlay (hidden until gear clicked) -->
      <div class="settings-overlay hidden" id="neg-settings">
        <header class="settings-hdr">
          <button class="icon-btn" id="neg-settings-back" title="Back">←</button>
          <span class="settings-title">⚙ Rate Card</span>
        </header>
        <div class="settings-body">

          <div class="field-group">
            <label class="field-label">FOLLOWER COUNT</label>
            <input class="field-input" id="sf-followers" type="number" placeholder="e.g. 45000" min="0" />
            <span class="field-hint">Used to calibrate the Fairness Score. A $500 offer is very different for 1k vs 50k followers.</span>
          </div>

          <div class="field-group">
            <label class="field-label">NICHE</label>
            <select class="field-select" id="sf-niche">
              <option value="">Select your niche…</option>
              <option value="Lifestyle">Lifestyle</option>
              <option value="Beauty & Fashion">Beauty &amp; Fashion</option>
              <option value="Fitness & Health">Fitness &amp; Health</option>
              <option value="Tech & Gaming">Tech &amp; Gaming</option>
              <option value="Food & Cooking">Food &amp; Cooking</option>
              <option value="Travel">Travel</option>
              <option value="Finance">Finance</option>
              <option value="Education">Education</option>
              <option value="Comedy & Entertainment">Comedy &amp; Entertainment</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div class="field-group">
            <label class="field-label">ENGAGEMENT RATE</label>
            <select class="field-select" id="sf-engagement">
              <option value="">Select engagement tier…</option>
              <option value="&lt;5% — Average">&lt;5% — Average (1× baseline)</option>
              <option value="5–10% — Strong">5–10% — Strong (1.5× baseline)</option>
              <option value="10%+ — Elite">10%+ — Elite (2× baseline)</option>
            </select>
          </div>

          <div class="field-group">
            <label class="field-label">TYPICAL CPM (optional)</label>
            <input class="field-input" id="sf-cpm" type="number" placeholder="e.g. 25" min="0" />
            <span class="field-hint">Your average cost-per-thousand views. Helps calibrate video deal rates.</span>
          </div>

          <div class="profile-summary hidden" id="sf-current-summary">
            <span class="profile-summary-label">Current saved profile</span>
            <span class="profile-summary-val" id="sf-summary-val"></span>
          </div>

          <button class="save-btn" id="sf-save">Save Rate Card</button>

          <!-- ── AI Configuration ── -->
          <div style="border-top:1px solid var(--bdr); padding-top:20px; display:flex; flex-direction:column; gap:14px;">

            <div>
              <p class="field-label" style="margin-bottom:4px">AI CONFIGURATION</p>
              <p class="field-hint">Connect your own Anthropic API key to run AI analysis.</p>
            </div>

            <div class="api-steps-box">
              <p class="api-steps-title">How to get your key — takes ~2 minutes</p>
              <div class="api-step">
                <span class="api-step-num">1</span>
                <span class="api-step-txt">Go to <strong id="sf-console-link" style="cursor:pointer;text-decoration:underline">console.anthropic.com</strong> and create a free account.</span>
              </div>
              <div class="api-step">
                <span class="api-step-num">2</span>
                <span class="api-step-txt">Under <strong>Billing</strong>, add a small credit balance (e.g. $5) to activate the API.</span>
              </div>
              <div class="api-step">
                <span class="api-step-num">3</span>
                <span class="api-step-txt">Go to <strong>API Keys</strong>, create a new key, and paste it below.</span>
              </div>
              <div style="margin-top:4px;padding-top:8px;border-top:1px solid var(--bdr);font-size:10px;color:var(--acc);font-weight:600;line-height:1.5">
                ⚡ Vynta is completely free. You only pay Anthropic directly for the AI processing you use — typically less than $0.05 per scan.
              </div>
            </div>

            <div class="field-group">
              <label class="field-label">AI API KEY</label>
              <div class="api-key-wrap">
                <div class="api-key-row">
                  <input class="field-input" id="sf-api-key" type="password"
                    placeholder="sk-ant-api03-…" autocomplete="off" spellcheck="false" />
                  <button class="test-btn" id="sf-test-key">Test</button>
                </div>
                <div class="key-status" id="sf-key-status"></div>
              </div>
            </div>

            <button class="save-btn" id="sf-save-key">Save Key</button>

            <div class="api-privacy-note">
              <span class="api-privacy-icon">🔒</span>
              <span>Your API key is stored locally on your device and is <strong>never sent to our servers</strong>. It is only transmitted directly to the Anthropic API when you run an analysis.</span>
            </div>

          </div>

          <div style="border-top:1px solid var(--bdr); padding-top:16px;">
            <button class="clear-hist-btn" id="sf-clear-history">🗑 Clear Deal History</button>
          </div>

        </div>
      </div>
    `;

    // ── Wire events ──

    panel.querySelector('#neg-close-btn').addEventListener('click', closeSidebar);

    panel.querySelector('#neg-feedback-btn')?.addEventListener('click', () => {
      window.open('https://docs.google.com/forms/d/e/1FAIpQLSfAirxndAZhYjXeeu4mFj3a2ufVJVC3BysIWNMl2h9Z3_XqAw/viewform?usp=dialog', '_blank', 'noopener,noreferrer');
    });

    // Settings open/close
    panel.querySelector('#neg-settings-btn').addEventListener('click', () => openSettings(panel));
    panel.querySelector('#neg-settings-back').addEventListener('click', () => closeSettings(panel));

    // Save profile
    panel.querySelector('#sf-save').addEventListener('click', () => onSaveProfile(panel));

    // Open Rate Card from profile-required warning card
    panel.querySelector('#neg-open-rate-card')?.addEventListener('click', () => openSettings(panel));

    // Anthropic Console link in settings
    panel.querySelector('#sf-console-link')?.addEventListener('click', () => {
      window.open('https://console.anthropic.com', '_blank', 'noopener,noreferrer');
    });

    // Clear history
    panel.querySelector('#sf-clear-history')?.addEventListener('click', async () => {
      await clearHistory();
      showToast('Deal history cleared');
      closeSettings(panel);
    });

    // ── Main tab switching ──
    const tabAnalysis   = panel.querySelector('#neg-tab-analysis');
    const tabHistory    = panel.querySelector('#neg-tab-history');
    const analysisPanel = panel.querySelector('#neg-analysis-panel');
    const histPanel     = panel.querySelector('#neg-hist-panel');

    tabAnalysis.addEventListener('click', () => {
      tabAnalysis.classList.add('active');
      tabHistory.classList.remove('active');
      analysisPanel.classList.remove('hidden');
      histPanel.classList.add('hidden');
    });

    tabHistory.addEventListener('click', () => {
      tabHistory.classList.add('active');
      tabAnalysis.classList.remove('active');
      analysisPanel.classList.add('hidden');
      histPanel.classList.remove('hidden');
      renderHistoryPanel(panel);
    });

    // Analyze Again
    const wireAgain = (id) => {
      const btn = panel.querySelector('#' + id);
      if (btn) btn.addEventListener('click', () => { cache = null; runScan(messageEl, threadId); });
    };
    wireAgain('neg-analyze-again');
    wireAgain('neg-analyze-again-err');

    // Pre-populate settings from saved profile
    populateSettingsForm(panel);

    // ── API key: Save Key ──
    panel.querySelector('#sf-save-key')?.addEventListener('click', async () => {
      const input  = panel.querySelector('#sf-api-key');
      const status = panel.querySelector('#sf-key-status');
      const key    = input?.value?.trim() || '';
      if (!key) {
        _showKeyStatus(status, 'fail', '✗ Please paste an API key before saving.');
        return;
      }
      await saveApiKey(key);
      _showKeyStatus(status, 'ok', '✓ Key saved. Run a deal analysis to verify it works.');
      showToast('✓ API key saved');
      // Refresh gate state on analysis panel
      _refreshApiKeyGate();
    });

    // ── API key: Test Connection ──
    panel.querySelector('#sf-test-key')?.addEventListener('click', async () => {
      const input   = panel.querySelector('#sf-api-key');
      const testBtn = panel.querySelector('#sf-test-key');
      const status  = panel.querySelector('#sf-key-status');
      const key     = input?.value?.trim() || '';

      if (!key) {
        _showKeyStatus(status, 'fail', '✗ Paste a key first.');
        return;
      }

      testBtn.textContent = '…';
      testBtn.disabled    = true;
      testBtn.className   = 'test-btn';
      _showKeyStatus(status, '', '');

      chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', payload: { apiKey: key } }, (resp) => {
        testBtn.disabled  = false;
        if (!isContextValid()) return;
        if (resp?.ok) {
          testBtn.textContent = '✓';
          testBtn.className   = 'test-btn ok';
          _showKeyStatus(status, 'ok', '✓ Connection successful — your key is valid and has credits.');
        } else {
          testBtn.textContent = '✗';
          testBtn.className   = 'test-btn fail';
          _showKeyStatus(status, 'fail', '✗ ' + (resp?.error || 'Connection failed.'));
          setTimeout(() => { if (testBtn.isConnected) { testBtn.textContent = 'Test'; testBtn.className = 'test-btn'; } }, 3000);
        }
      });
    });

    // ── "Add API Key in Settings" gate shortcut ──
    panel.querySelector('#neg-open-settings-from-gate')?.addEventListener('click', () => openSettings(panel));

    return panel;
  }

  function _showKeyStatus(el, cls, msg) {
    if (!el) return;
    el.className = 'key-status' + (cls ? ' visible ' + cls : '');
    el.textContent = msg;
  }

  // Refreshes the analysis panel gate state based on current key + rate card.
  // Called after saving the key and every time the settings overlay closes.
  async function _refreshApiKeyGate() {
    const key = await loadApiKey();
    if (!isContextValid() || !shadowRoot) return;

    const gateCard = shadowRoot.getElementById('neg-no-key-card');
    const aiBtn    = shadowRoot.getElementById('neg-ai-btn');
    const reqCard  = shadowRoot.getElementById('neg-profile-required');

    if (!key) {
      gateCard?.classList.remove('hidden');
      if (aiBtn) aiBtn.disabled = true;
      return;
    }

    // Key present — hide the key gate
    gateCard?.classList.add('hidden');

    // Now check rate card + whether phase2 data is ready
    const hasProfile  = !!(rateProfile?.followerCount);
    const phase2Ready = !!(cache?.phase2Data);

    if (hasProfile && phase2Ready) {
      reqCard?.classList.add('hidden');
      if (aiBtn) {
        aiBtn.disabled    = false;
        aiBtn.textContent = '🤖 Analyze with AI';
        aiBtn.onclick     = () => triggerAIAnalysis(cache.phase2Data);
      }
    } else if (!hasProfile && phase2Ready) {
      reqCard?.classList.remove('hidden');
      if (aiBtn) aiBtn.disabled = true;
    }
    // If phase2 not ready yet (still scanning), leave aiBtn alone —
    // showPhase2Result will wire it correctly when the scan completes.
  }

  // ── Settings panel ───────────────────────────────────────────────────────

  function openSettings(panel) {
    const overlay = panel.querySelector('#neg-settings');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.classList.remove('closing');
  }

  function closeSettings(panel) {
    const overlay = panel.querySelector('#neg-settings');
    if (!overlay) return;
    overlay.classList.add('closing');
    overlay.addEventListener('animationend', () => {
      overlay.classList.add('hidden');
      overlay.classList.remove('closing');
      // Immediately refresh the analysis panel gate so the AI button
      // reflects any key/profile changes made while settings was open.
      _refreshApiKeyGate();
    }, { once: true });
  }

  function populateSettingsForm(panel) {
    if (!panel) return;
    const p = rateProfile;
    if (p.followerCount)  panel.querySelector('#sf-followers')?.value  !== undefined && (panel.querySelector('#sf-followers').value  = p.followerCount);
    if (p.niche)          panel.querySelector('#sf-niche')?.value      !== undefined && (panel.querySelector('#sf-niche').value       = p.niche);
    if (p.engagementRate) panel.querySelector('#sf-engagement')?.value !== undefined && (panel.querySelector('#sf-engagement').value  = p.engagementRate);
    if (p.typicalCPM)     panel.querySelector('#sf-cpm')?.value        !== undefined && (panel.querySelector('#sf-cpm').value         = p.typicalCPM);

    const summary = panel.querySelector('#sf-current-summary');
    const sumVal  = panel.querySelector('#sf-summary-val');
    if (summary && sumVal && (p.followerCount || p.niche)) {
      sumVal.textContent = profileShortLabel();
      summary.classList.remove('hidden');
    }

    // Pre-fill API key input (masked) if one is already saved
    loadApiKey().then(key => {
      const keyInput = panel.querySelector('#sf-api-key');
      if (keyInput && key) keyInput.value = key;
    });
  }

  async function onSaveProfile(panel) {
    const followers   = panel.querySelector('#sf-followers')?.value?.trim()  || '';
    const niche       = panel.querySelector('#sf-niche')?.value              || '';
    const engagement  = panel.querySelector('#sf-engagement')?.value         || '';
    const cpm         = panel.querySelector('#sf-cpm')?.value?.trim()        || '';

    const newProfile = {
      followerCount:   followers ? Number(followers) : null,
      niche:           niche     || null,
      engagementRate:  engagement || null,
      typicalCPM:      cpm ? Number(cpm) : null,
    };

    await saveProfile(newProfile);

    // Update the header chip
    const chip = shadowRoot?.querySelector('.profile-chip');
    if (chip) {
      chip.textContent = '◎ ' + profileShortLabel();
    } else if (shadowRoot) {
      // No chip yet — add one
      const hdrRight = shadowRoot.querySelector('.hdr-right');
      if (hdrRight) {
        const c = document.createElement('span');
        c.className = 'profile-chip';
        c.textContent = '◎ ' + profileShortLabel();
        hdrRight.prepend(c);
      }
    }

    showToast('✓ Rate Card saved');
    closeSettings(panel);

    // Save phase2 data before clearing cache so we can rewire the AI button
    const savedPhase2 = cache?.phase2Data ?? null;

    // Clear cache so next analysis uses the new profile
    cache = null;

    // If the AI button was gated by the rate card, unlock it now — but only
    // if an API key is also present (the key gate takes priority).
    if (newProfile.followerCount) {
      loadApiKey().then(key => {
        if (!isContextValid() || !shadowRoot) return;
        const aiBtn     = shadowRoot.getElementById('neg-ai-btn');
        const reqCard   = shadowRoot.getElementById('neg-profile-required');
        const noKeyCard = shadowRoot.getElementById('neg-no-key-card');
        if (!key) {
          // Still no key — leave the key gate visible
          noKeyCard?.classList.remove('hidden');
          return;
        }
        if (aiBtn?.disabled) {
          reqCard?.classList.add('hidden');
          aiBtn.disabled    = false;
          aiBtn.textContent = '🤖 Analyze with AI';
          if (savedPhase2) aiBtn.onclick = () => triggerAIAnalysis(savedPhase2);
        }
      });
    }
  }

  function profileShortLabel() {
    const p = rateProfile;
    const parts = [];
    if (p.followerCount) parts.push(Number(p.followerCount).toLocaleString() + ' followers');
    if (p.niche)         parts.push(p.niche);
    return parts.join(' · ') || 'Profile set';
  }

  // ── State transitions ────────────────────────────────────────────────────

  const STATES = ['neg-scanning','neg-p2','neg-ai-loading','neg-ai-result','neg-error'];

  function setVisible(id) {
    STATES.forEach(s => {
      const el = shadowRoot?.getElementById(s);
      if (el) el.classList.toggle('hidden', s !== id);
    });
  }

  function showScanningState() { setVisible('neg-scanning'); }

  function showPhase2Result(data, threadId) {
    const subjectEl = $('neg-subject');
    if (!subjectEl) return; // shadow DOM gone — bail safely
    subjectEl.textContent = data.subject;

    const chips = [];
    if (data.sender)      chips.push(mkChip('👤 ' + data.sender));
    if (data.senderEmail) chips.push(mkChip(data.senderEmail));
    if (data.date)        chips.push(mkChip('🕐 ' + data.date));
    const metaEl = $('neg-meta');
    if (metaEl) metaEl.innerHTML = chips.join('');

    const fw = $('neg-flags-wrap');
    if (fw) {
      if (data.redFlags.length > 0) {
        fw.innerHTML = `
          <div class="card flags-card">
            <div class="flags-hdr">⛔ ${data.redFlags.length} Red Flag${data.redFlags.length > 1 ? 's' : ''} Detected</div>
            ${data.redFlags.map(f => `
              <div class="flag-item">
                <div class="flag-lbl">⚠ ${esc(f.label)}</div>
                <div class="flag-dtl">${esc(f.detail)}</div>
              </div>`).join('')}
          </div>`;
      } else {
        fw.innerHTML = `<div class="card no-flags">✅ No red flag clauses detected.</div>`;
      }
    }

    const preview = data.body.length > 500 ? data.body.slice(0, 500) + '…' : data.body || '(No body text found)';
    const bodyEl  = $('neg-body');
    const charsEl = $('neg-chars');
    if (bodyEl)  bodyEl.textContent  = preview;
    if (charsEl) charsEl.textContent = `${data.charCount.toLocaleString()} chars extracted`;

    setVisible('neg-p2');

    // Gate order: API key must exist first, then Rate Card
    loadApiKey().then(key => {
      if (!isContextValid() || !shadowRoot) return;

      const aiBtn     = shadowRoot.getElementById('neg-ai-btn');
      const reqCard   = shadowRoot.getElementById('neg-profile-required');
      const noKeyCard = shadowRoot.getElementById('neg-no-key-card');
      const hasProfile = !!(rateProfile && rateProfile.followerCount);

      if (!key) {
        // No API key — show the key gate, hide everything else
        noKeyCard?.classList.remove('hidden');
        reqCard?.classList.add('hidden');
        if (aiBtn) { aiBtn.disabled = true; aiBtn.textContent = '🤖 Analyze with AI'; }
        return;
      }

      noKeyCard?.classList.add('hidden');

      if (hasProfile) {
        reqCard?.classList.add('hidden');
        if (aiBtn) {
          aiBtn.disabled    = false;
          aiBtn.textContent = '🤖 Analyze with AI';
          aiBtn.onclick     = () => triggerAIAnalysis(data);
        }
      } else {
        reqCard?.classList.remove('hidden');
        if (aiBtn) { aiBtn.disabled = true; aiBtn.textContent = '🤖 Analyze with AI'; }
      }
    });
  }

  // Progress steps shown during the AI call — gives user confidence something is happening
  const PROGRESS_STEPS = [
    { t:  0, label: 'Reading deal terms…',              sub: 'Extracting rate, deliverables, and rights clauses.' },
    { t: 10, label: 'Scanning legal language…',         sub: 'Checking for red flags and liability traps.' },
    { t: 20, label: 'Benchmarking against 2026 rates…', sub: 'Comparing offer to nano/micro creator market data.' },
    { t: 30, label: 'Calculating Fairness Score…',      sub: 'Weighing rate, rights, and engagement multipliers.' },
    { t: 40, label: 'Drafting counter-offers…',         sub: 'Writing Professional, Collaborator, and Hard-Baller responses.' },
    { t: 52, label: 'Almost there…',                    sub: 'Finalising analysis — thanks for your patience.' },
  ];

  let _progressTimers = [];

  function showAILoading() {
    setVisible('neg-ai-loading');
    // Clear any leftover timers from a previous call
    _progressTimers.forEach(clearTimeout);
    _progressTimers = [];

    const labelEl = shadowRoot?.querySelector('.ai-load-label');
    const subEl   = shadowRoot?.querySelector('.ai-load-sub');
    if (!labelEl || !subEl) return;

    const fillEl = shadowRoot?.getElementById('neg-progress-fill');

    PROGRESS_STEPS.forEach((step, i) => {
      const id = setTimeout(() => {
        if (!isContextValid()) return;
        try {
          if (labelEl) labelEl.textContent = step.label;
          if (subEl)   subEl.textContent   = step.sub;
          if (fillEl)  fillEl.className    = `ai-progress-fill step${i + 1}`;
        } catch (_) {}
      }, step.t * 1000);
      _progressTimers.push(id);
    });
  }

  function clearProgressTimers() {
    _progressTimers.forEach(clearTimeout);
    _progressTimers = [];
  }

  function showAIResult(aiData, emailData) {
    clearProgressTimers();
    if (!isContextValid() || !shadowRoot) return;
    if (cache) cache.aiData = aiData;

    // ── Score ──
    const score   = Math.max(1, Math.min(10, Math.round(aiData.fairnessScore ?? 5)));
    const color   = score <= 4 ? 'var(--red)' : score <= 7 ? 'var(--amb)' : 'var(--grn)';
    const verdict = score <= 4 ? 'BELOW MARKET' : score <= 7 ? 'MIXED TERMS' : 'FAIR OFFER';

    // ── Verdict banner ──
    const bannerEl    = $('neg-verdict-banner');
    const bannerTitle = $('neg-verdict-title');
    const bannerSub   = $('neg-verdict-sub');
    if (bannerEl && bannerTitle && bannerSub) {
      const bannerCfg = score <= 4
        ? { cls: 'vb-red',    label: '🚫 RED FLAG: Decline Recommended' }
        : score <= 7
        ? { cls: 'vb-yellow', label: '⚠️ NEGOTIATE: Push for Better Terms' }
        : { cls: 'vb-green',  label: '✅ TAKE THE DEAL: High-Priority Win' };

      bannerEl.className = `verdict-banner ${bannerCfg.cls}`;
      bannerTitle.textContent = bannerCfg.label;
      // Agent logic subtext: first sentence of fairnessRationale, or fallback
      const rationale = aiData.fairnessRationale ?? '';
      bannerSub.textContent = rationale
        ? rationale.split(/(?<=[.!?])\s+/)[0]
        : (score <= 4 ? 'This deal is significantly below market rate or contains predatory clauses.'
         : score <= 7 ? 'Some terms are fair but key clauses need renegotiation before signing.'
         : 'This deal is at or above market — focus on locking in favorable long-term terms.');
    }

    // Animate score counting up
    const numEl  = $('neg-score-num');
    const barEl  = $('neg-score-bar');
    const circle = $('neg-score-circle');

    if (circle) {
      circle.style.setProperty('--score-clr', color);
      circle.style.setProperty('--glow', score <= 4 ? 'rgba(248,113,113,.3)' : score <= 7 ? 'rgba(251,191,36,.3)' : 'rgba(52,211,153,.3)');
    }
    if (barEl) barEl.style.background = color;

    let current = 0;
    const timer = setInterval(() => {
      if (!isContextValid() || !numEl.isConnected) { clearInterval(timer); return; }
      try {
        current = Math.min(current + 1, score);
        numEl.textContent = current;
        numEl.style.color = color;
        barEl.style.width = (current / 10 * 100) + '%';
        if (current >= score) clearInterval(timer);
      } catch (_) { clearInterval(timer); }
    }, 70);

    const verdictEl = $('neg-score-verdict');
    if (verdictEl) { verdictEl.textContent = verdict; verdictEl.style.color = color; }
    const rationaleEl = $('neg-score-rationale');
    if (rationaleEl) rationaleEl.textContent = aiData.fairnessRationale ?? '';

    // Show profile note if profile is set
    const profileNote = $('neg-profile-note');
    if (profileNote && (rateProfile.followerCount || rateProfile.niche)) {
      profileNote.textContent = `Calibrated for: ${profileShortLabel()}`;
      profileNote.classList.remove('hidden');
    }

    // ── Benchmark line — compare to previous deals BEFORE saving this one ──
    const benchEl = $('neg-bench-line');
    if (benchEl && dealHistory.length >= 1) {
      // Exclude any existing entry for this thread so we compare to OTHER deals
      const prev = dealHistory.filter(d => d.threadId !== cache?.threadId);
      if (prev.length >= 1) {
        const avg  = prev.reduce((s, d) => s + d.score, 0) / prev.length;
        const diff = score - avg;
        const pct  = Math.abs(Math.round((diff / avg) * 100));
        if (diff > 0.24) {
          benchEl.textContent = `📈 ${pct}% above your average deal (${avg.toFixed(1)} avg across ${prev.length})`;
          benchEl.className = 'bench-line better';
        } else if (diff < -0.24) {
          benchEl.textContent = `📉 ${pct}% below your average deal (${avg.toFixed(1)} avg across ${prev.length})`;
          benchEl.className = 'bench-line worse';
        } else {
          benchEl.textContent = `📊 Matches your average deal score (${avg.toFixed(1)} avg)`;
          benchEl.className = 'bench-line';
        }
        benchEl.classList.remove('hidden');
      }
    }

    // Save to history (non-blocking; deduplicates by threadId)
    addToHistory(emailData, aiData, cache?.threadId);

    // ── Score breakdown ──
    const breakdownEl = $('neg-score-breakdown');
    const toggleBtn   = $('neg-breakdown-toggle');
    const breakdown   = aiData.score_breakdown ?? [];
    if (breakdownEl && breakdown.length > 0) {
      breakdownEl.innerHTML = breakdown.map(item => {
        const v   = Number(item.value ?? 0);
        const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu';
        const sign = v > 0 ? '+' : '';
        return `<div class="breakdown-item ${cls}">
          <span class="breakdown-label">${esc(item.label)}</span>
          <span class="breakdown-value ${cls}">${sign}${v.toFixed(1)}</span>
        </div>`;
      }).join('');

      if (toggleBtn) {
        toggleBtn.classList.remove('hidden');
        toggleBtn.onclick = () => {
          const open = !breakdownEl.classList.contains('hidden');
          breakdownEl.classList.toggle('hidden', open);
          toggleBtn.textContent = open ? '▸ Show score reasoning' : '▾ Hide score reasoning';
        };
      }
    }

    // ── Risks ──
    const rw    = $('neg-risks-wrap');
    const risks = aiData.detectedRisks ?? [];
    if (!rw) return; // if shadow DOM is gone at this point, bail
    rw.innerHTML = risks.length > 0 ? `
      <div class="card">
        <p class="sec-label">Detected Risks (${risks.length})</p>
        ${risks.map(r => {
          const sev = (r.severity ?? 'medium').toLowerCase();
          return `
          <div class="risk-item">
            <div class="risk-hdr">
              <span class="risk-clause">${esc(r.clause)}</span>
              <span class="sev-badge sev-${esc(sev)}">${esc(sev)}</span>
            </div>
            <p class="risk-exp">${esc(r.explanation)}</p>
          </div>`;
        }).join('')}
      </div>` :
      `<div class="card no-flags">✅ No contract risks identified by AI.</div>`;

    // ── Drafts ──
    const drafts = aiData.drafts ?? {};
    ['professional','collaborator','hardBaller'].forEach(key => {
      const pre = shadowRoot.getElementById('draft-' + key);
      if (pre) pre.textContent = drafts[key] ?? '(No draft generated)';
    });

    // Tab switching
    shadowRoot?.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => {
        shadowRoot?.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        ['professional','collaborator','hardBaller'].forEach(k => {
          const pane = shadowRoot.getElementById('tab-' + k);
          if (pane) pane.classList.toggle('hidden', k !== btn.dataset.tab);
        });
      };
    });

    // Copy buttons
    shadowRoot?.querySelectorAll('.copy-btn').forEach(btn => {
      btn.onclick = () => {
        const text = drafts[btn.dataset.draft] ?? '';
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '✓ Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('copied'); }, 2000);
        });
      };
    });

    // Use Draft buttons
    shadowRoot?.querySelectorAll('.use-btn').forEach(btn => {
      btn.onclick = async () => {
        const text = drafts[btn.dataset.draft] ?? '';
        if (!text) return;

        const orig = btn.textContent;
        btn.textContent = 'Opening reply…';
        btn.disabled = true;

        try {
          const result = await injectIntoGmailCompose(text);

          // Guard: sidebar may have been closed/extension reloaded while awaiting
          if (!btn.isConnected) return;

          btn.disabled = false;
          if (result.ok) {
            btn.textContent = '✓ Draft inserted!';
            btn.classList.add('injected');
            showToast('✓ Draft inserted into reply box');
            setTimeout(() => { if (btn.isConnected) { btn.textContent = orig; btn.classList.remove('injected'); } }, 3000);
          } else {
            btn.textContent = '✗ Failed';
            btn.classList.add('failed');
            showToast(result.message ?? 'Could not inject — click Reply in Gmail first');
            setTimeout(() => { if (btn.isConnected) { btn.textContent = orig; btn.classList.remove('failed'); } }, 3000);
          }
        } catch (_e) {
          // Extension context invalidated mid-flight — silently ignore
        }
      };
    });

    // Export PDF button
    const exportBtn = $('neg-export-btn');
    if (exportBtn) {
      exportBtn.onclick = () => exportDealPDF(aiData, emailData);
    }

    setVisible('neg-ai-result');

    // Auto-scroll sidebar body to top so the verdict banner is the first thing seen
    const bodyEl = shadowRoot?.querySelector('main.body');
    if (bodyEl) bodyEl.scrollTop = 0;
  }

  // ── History panel render ──────────────────────────────────────────────────

  function renderHistoryPanel(panel) {
    const listEl   = panel.querySelector('#neg-hist-list');
    const footerEl = panel.querySelector('#neg-hist-footer');
    if (!listEl) return;

    // Clone the compare button to strip old listeners, then re-reference it
    const oldCmpBtn = panel.querySelector('#neg-compare-btn');
    let cmpBtn = oldCmpBtn;
    if (oldCmpBtn) {
      const fresh = oldCmpBtn.cloneNode(true);
      oldCmpBtn.replaceWith(fresh);
      cmpBtn = fresh;
    }

    if (!dealHistory.length) {
      listEl.innerHTML = `
        <div class="hist-empty">
          <div class="hist-empty-icon">📋</div>
          <div>No deals analyzed yet.</div>
          <div style="font-size:11px;margin-top:6px;color:var(--txt3)">Analyze a brand deal email to start building your history.</div>
        </div>`;
      footerEl?.classList.add('hidden');
      return;
    }

    const selected = new Set();

    listEl.innerHTML = `<div class="hist-list">${dealHistory.map(deal => {
      const color   = deal.score <= 4 ? 'var(--red)' : deal.score <= 7 ? 'var(--amb)' : 'var(--grn)';
      const dateStr = new Date(deal.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const riskTxt = deal.risks.length
        ? `${deal.risks.length} risk${deal.risks.length > 1 ? 's' : ''}`
        : 'No risks';
      return `
        <div class="hist-item" data-id="${deal.id}">
          <input type="checkbox" class="hist-check" data-id="${deal.id}">
          <div class="hist-info">
            <div class="hist-brand">${esc(deal.brandName)}</div>
            <div class="hist-meta">${deal.offeredPrice ? esc(deal.offeredPrice) + ' · ' : ''}${dateStr} · ${esc(riskTxt)}</div>
          </div>
          <div class="hist-score" style="color:${color}">${deal.score}</div>
        </div>`;
    }).join('')}</div>`;

    // Click on item row (not checkbox) → show detail scorecard
    listEl.querySelectorAll('.hist-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.hist-check')) return;
        const id   = Number(item.dataset.id);
        const deal = dealHistory.find(d => d.id === id);
        if (deal) showHistoryDetail(panel, deal);
      });
    });

    // Wire checkboxes for compare mode
    listEl.querySelectorAll('.hist-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id   = Number(cb.dataset.id);
        const item = cb.closest('.hist-item');
        if (cb.checked) { selected.add(id);    item.classList.add('selected'); }
        else            { selected.delete(id); item.classList.remove('selected'); }

        const n = selected.size;
        if (n === 0) {
          footerEl?.classList.add('hidden');
        } else {
          footerEl?.classList.remove('hidden');
          if (cmpBtn) {
            cmpBtn.disabled    = n < 2;
            cmpBtn.textContent = n < 2
              ? '⚖ Select 1 more to compare'
              : `⚖ Compare ${n} Deal${n > 1 ? 's' : ''}`;
          }
        }
      });
    });

    cmpBtn?.addEventListener('click', () => {
      const picks = dealHistory.filter(d => selected.has(d.id));
      showCompareView(panel, picks);
    });

    footerEl?.classList.add('hidden');
  }

  function showHistoryDetail(panel, deal) {
    const listEl   = panel.querySelector('#neg-hist-list');
    const footerEl = panel.querySelector('#neg-hist-footer');
    if (!listEl) return;

    const color   = deal.score <= 4 ? 'var(--red)' : deal.score <= 7 ? 'var(--amb)' : 'var(--grn)';
    const dateStr = new Date(deal.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const riskRows = deal.risks.length
      ? deal.risks.map(r => `
          <div class="risk-item">
            <div class="risk-hdr">
              <span class="risk-clause">${esc(r.clause)}</span>
              <span class="sev-badge sev-${esc(r.severity)}">${esc(r.severity)}</span>
            </div>
            ${r.explanation ? `<p class="risk-exp">${esc(r.explanation)}</p>` : ''}
          </div>`).join('')
      : `<div style="font-size:12px;color:var(--grn)">✅ No contract risks detected</div>`;

    // Build verdict banner HTML for history detail (use saved agentVerdict if present)
    const av = deal.agentVerdict;
    const bannerHtml = av ? `
      <div class="verdict-banner ${esc(av.cls)}">
        <span class="verdict-banner-title">${esc(av.label)}</span>
        <span class="verdict-banner-sub">${esc(av.sub)}</span>
      </div>` : '';

    listEl.innerHTML = `
      <div class="hist-detail">
        <div>
          <button class="hist-detail-back" id="neg-detail-back">← Back to list</button>
        </div>

        ${bannerHtml}

        <div class="hist-detail-top">
          <div class="hist-detail-scores">
            <span class="hist-detail-num" style="color:${color}">${deal.score}</span>
            <span class="hist-detail-den">/ 10</span>
          </div>
          <div class="hist-detail-meta">
            <div class="hist-detail-brand">${esc(deal.brandName)}</div>
            <div class="hist-detail-subj">${esc(deal.subject)}</div>
            <div class="hist-detail-chips" style="margin-top:4px">
              <span class="meta-chip" style="color:${color};border-color:${color};background:transparent;font-weight:700">${esc(deal.verdict)}</span>
              ${deal.offeredPrice ? `<span class="meta-chip">💰 ${esc(deal.offeredPrice)}</span>` : ''}
              <span class="meta-chip">📅 ${dateStr}</span>
            </div>
          </div>
        </div>

        ${deal.rationale ? `
        <div class="card" style="padding:10px 14px">
          <p class="sec-label" style="margin-bottom:6px">AI Rationale</p>
          <p style="font-size:12px;color:var(--txt2);line-height:1.6">${esc(deal.rationale)}</p>
        </div>` : ''}

        <div class="card" style="padding:10px 14px">
          <p class="sec-label" style="margin-bottom:8px">Detected Risks (${deal.risks.length})</p>
          ${riskRows}
        </div>

        ${deal.score_breakdown?.length ? `
        <div class="card" style="padding:10px 14px">
          <p class="sec-label" style="margin-bottom:8px">Score Breakdown</p>
          <div class="breakdown-list">
            ${deal.score_breakdown.map(item => {
              const v   = Number(item.value ?? 0);
              const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu';
              const sign = v > 0 ? '+' : '';
              return `<div class="breakdown-item ${cls}">
                <span class="breakdown-label">${esc(item.label)}</span>
                <span class="breakdown-value ${cls}">${sign}${v.toFixed(1)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}
      </div>`;

    footerEl?.classList.add('hidden');
    listEl.querySelector('#neg-detail-back')?.addEventListener('click', () => renderHistoryPanel(panel));
  }

  function showCompareView(panel, deals) {
    const listEl   = panel.querySelector('#neg-hist-list');
    const footerEl = panel.querySelector('#neg-hist-footer');
    if (!listEl || deals.length < 2) return;

    const headerCols = deals.map(d => {
      const dateStr = new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<th>${esc(d.brandName)}<br><span style="font-size:9px;font-weight:400;color:var(--txt3)">${dateStr}</span></th>`;
    }).join('');

    const mkRow = (label, cells) =>
      `<tr><td class="field-col">${label}</td>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;

    const rows = [
      mkRow('Score', deals.map(d => {
        const color = d.score <= 4 ? 'var(--red)' : d.score <= 7 ? 'var(--amb)' : 'var(--grn)';
        return `<span style="font-weight:800;color:${color}">${d.score}</span>`;
      })),
      mkRow('Offered Price', deals.map(d => esc(d.offeredPrice || '—'))),
      mkRow('Verdict',       deals.map(d => esc(d.verdict))),
      mkRow('Risk Count',    deals.map(d => d.risks.length ? `${d.risks.length}` : '✅ 0')),
      mkRow('Top Risk', deals.map(d => {
        const top = d.risks.find(r => r.severity === 'critical') || d.risks[0];
        if (!top) return '—';
        const label = top.clause.length > 28 ? top.clause.slice(0, 28) + '…' : top.clause;
        return `<span style="color:var(--red)">${esc(label)}</span>`;
      })),
      mkRow('Subject', deals.map(d => {
        const s = d.subject.length > 30 ? d.subject.slice(0, 30) + '…' : d.subject;
        return `<span style="color:var(--txt2);font-size:10px">${esc(s)}</span>`;
      })),
    ].join('');

    listEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span class="sec-label">Comparing ${deals.length} Deals</span>
        <button class="compare-back-btn" id="neg-compare-back">← Back to list</button>
      </div>
      <div class="compare-wrap">
        <table class="compare-table">
          <thead><tr><th></th>${headerCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    footerEl?.classList.add('hidden');
    listEl.querySelector('#neg-compare-back')?.addEventListener('click', () => renderHistoryPanel(panel));
  }

  function showError(message) {
    clearProgressTimers();
    if (!isContextValid() || !shadowRoot) return;

    const errorCard  = $('neg-error-card');
    const errorTitle = $('neg-error-title');
    const errorMsg   = $('neg-error-msg');
    if (!errorCard || !errorTitle || !errorMsg) return;

    const isApiKey   = /API key/i.test(message);
    const isTooShort = /too short/i.test(message);

    if (isApiKey) {
      errorCard.className   = 'card setup-card';
      errorTitle.textContent = '🔑 API Key Required';
      errorTitle.style.color = 'var(--acc)';
      errorMsg.innerHTML = `
        <ol class="setup-steps">
          <li>Click <strong>⚙ Settings</strong> (gear icon in the header)</li>
          <li>Scroll to <strong>AI Configuration</strong></li>
          <li>Paste your Anthropic API key and click <strong>Save Key</strong></li>
        </ol>`;
    } else {
      errorCard.className   = 'card error-card';
      errorTitle.textContent = isTooShort ? '📧 Email Too Short' : '⚠ Analysis Failed';
      errorTitle.style.color = '';
      errorMsg.textContent  = message;
    }

    setVisible('neg-error');
  }

  // ── Scan + AI ────────────────────────────────────────────────────────────

  function runScan(messageEl, threadId, histEntry = null) {
    showScanningState();
    // Yield to the browser first so the scanning animation renders before we do DOM work.
    // requestIdleCallback keeps the Gmail main thread smooth; setTimeout is the fallback.
    const doScan = () => {
      const data = extractEmailData();
      if (!data) {
        const lbl = shadowRoot?.querySelector('.scan-label');
        const sub = shadowRoot?.querySelector('.scan-sub');
        if (lbl) lbl.textContent = 'Could not read email';
        if (sub) sub.textContent = 'Close the sidebar and try again.';
        return;
      }

      cache = { threadId, phase2Data: data, aiData: null };
      showPhase2Result(data, threadId);

      // ── Restore from deal history if available ──
      if (histEntry) {
        const restoredAI = {
          fairnessScore:     histEntry.score,
          score_breakdown:   histEntry.score_breakdown  || [],
          fairnessRationale: histEntry.rationale        || '',
          detectedRisks:     histEntry.risks            || [],
          drafts:            histEntry.drafts           || {},
        };
        cache.aiData = restoredAI;
        showAIResult(restoredAI, data);

        // Show "restored from history" indicator and relabel Analyze Again
        const badge    = shadowRoot?.getElementById('neg-restored-badge');
        const againBtn = shadowRoot?.getElementById('neg-analyze-again');
        if (badge)    badge.classList.remove('hidden');
        if (againBtn) {
          againBtn.textContent = '🔄 Re-analyze with AI';
          // Re-wire: clear cache so it re-runs AI analysis, not just re-scans
          againBtn.onclick = () => {
            cache = null;
            const b2 = shadowRoot?.getElementById('neg-restored-badge');
            if (b2) b2.classList.add('hidden');
            runScan(messageEl, threadId);
          };
        }
      }
    };

    if (typeof requestIdleCallback !== 'undefined') {
      setTimeout(() => requestIdleCallback(doScan, { timeout: 1500 }), 300);
    } else {
      setTimeout(doScan, 700);
    }
  }

  function triggerAIAnalysis(emailData) {
    const btn = shadowRoot?.getElementById('neg-ai-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending to AI…'; }
    showAILoading();

    loadApiKey().then(apiKey => {
      if (!isContextValid()) return;
      if (!apiKey) {
        showError('Action Required: Please enter your Anthropic API Key in Settings to begin.');
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: 'ANALYZE_DEAL',
          payload: {
            subject:     emailData.subject,
            body:        emailData.body,
            redFlags:    emailData.redFlags,
            rateProfile: rateProfile,
            apiKey,
          },
        },
        (response) => {
          if (!isContextValid()) return;
          if (chrome.runtime.lastError) { showError(chrome.runtime.lastError.message); return; }
          if (!response?.ok)            { showError(response?.error ?? 'Unknown error.'); return; }
          showAIResult(response.data, emailData);
        }
      );
    });
  }

  // ── Toast ────────────────────────────────────────────────────────────────

  function showToast(msg) {
    if (!isContextValid()) return;
    try {
      const t = shadowRoot?.getElementById('neg-toast');
      if (!t) return;
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => { try { t.classList.remove('show'); } catch (_) {} }, 2500);
    } catch (_) {}
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Dynamically loads jsPDF from the extension's web-accessible resources.
   * Injects a <script> tag once and caches the result for subsequent calls.
   * This sidesteps Gmail's strict CSP (external CDN URLs are blocked; the
   * extension origin is always allowed).
   */
  function loadJsPDF() {
    // jspdf.umd.min.js is declared as a content script in manifest.json and
    // therefore runs before content.js in the same isolated world, completely
    // bypassing Gmail's CSP.  By the time this function is called the class
    // is already available — no async loading or eval needed.
    return new Promise((resolve, reject) => {
      const JsPDF = window.jspdf?.jsPDF;
      if (JsPDF) { resolve(JsPDF); return; }
      reject(new Error('jsPDF not available — reload the extension at chrome://extensions'));
    });
  }

  /**
   * Builds and downloads a high-end PDF deal report using jsPDF.
   *
   * Layout:
   *   ┌─────────────────────────────────┐
   *   │  Navy header — Vynta logo    │
   *   ├─────────────────────────────────┤
   *   │  Deal overview (brand / subject)│
   *   │  Fairness Score + verdict       │
   *   │  Detected Red Flags             │
   *   │  Strategic Advice               │
   *   │  Selected Draft                 │
   *   ├─────────────────────────────────┤
   *   │  Footer — Generated by …        │
   *   └─────────────────────────────────┘
   *
   * @param {{ fairnessScore, fairnessRationale, detectedRisks, drafts, score_breakdown }} aiData
   * @param {{ subject, sender, senderEmail, date }} emailData
   */
  async function exportDealPDF(aiData, emailData) {
    const btn = $('neg-export-btn');
    if (btn) { btn.textContent = '⏳ Generating PDF…'; btn.disabled = true; }

    try {
      const JsPDF = await loadJsPDF();

      // ── Document setup ──
      const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const W   = 210;   // page width
      const PH  = 297;   // page height
      const ML  = 16;    // margin left
      const CW  = W - ML - 16; // content width (178mm)
      const MB  = 20;    // margin bottom threshold
      let   y   = 0;

      // ── Score colour lookup ──
      const score   = Math.max(1, Math.min(10, Math.round(aiData.fairnessScore ?? 5)));
      const verdict = score <= 4 ? 'BELOW MARKET' : score <= 7 ? 'MIXED TERMS' : 'FAIR OFFER';
      const scoreRGB = score <= 4 ? [248, 113, 113] : score <= 7 ? [251, 191, 36] : [52, 211, 153];

      // ── Footer helper (called before every addPage and at doc end) ──
      function drawFooter() {
        const pg = doc.internal.getCurrentPageInfo().pageNumber;
        doc.setDrawColor(45, 55, 72);
        doc.setLineWidth(0.25);
        doc.line(ML, PH - 14, W - 16, PH - 14);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.text(
          'Generated by Vynta \u2014 Supporting fair deals for creators.',
          W / 2, PH - 9.5, { align: 'center' }
        );
        doc.text(`Page ${pg}`, W - 16, PH - 9.5, { align: 'right' });
      }

      // ── Page-break guard ──
      function checkBreak(needed = 16) {
        if (y + needed > PH - MB) {
          drawFooter();
          doc.addPage();
          // Thin navy continuation header
          doc.setFillColor(30, 58, 95);
          doc.rect(0, 0, W, 8, 'F');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7);
          doc.setTextColor(255, 255, 255);
          doc.text('Vynta \u2014 Deal Analysis Report (continued)', ML, 5.5);
          y = 16;
        }
      }

      // ── Thin horizontal rule ──
      function rule() {
        checkBreak(8);
        doc.setDrawColor(45, 55, 72);
        doc.setLineWidth(0.25);
        doc.line(ML, y, W - 16, y);
        y += 7;
      }

      // ── Section label ──
      function sectionLabel(txt) {
        checkBreak(10);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.text(txt.toUpperCase(), ML, y);
        y += 5;
      }

      // ── Wrapped body text block ──
      function bodyText(txt, sz, r, g, b, bold = false) {
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setFontSize(sz);
        doc.setTextColor(r, g, b);
        const lines = doc.splitTextToSize(String(txt || ''), CW);
        lines.forEach(line => {
          checkBreak(sz * 0.45 + 2);
          doc.text(line, ML, y);
          y += sz * 0.45;
        });
      }

      // ════════════════════════════════════════════════════════════════
      // HEADER — Navy blue full-width bar
      // ════════════════════════════════════════════════════════════════
      doc.setFillColor(30, 58, 95);   // #1e3a5f — matches sidebar header
      doc.rect(0, 0, W, 30, 'F');

      // "Vynta" wordmark
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(255, 255, 255);
      doc.text('Vynta', ML, 14);

      // Sub-label
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(147, 197, 253);   // blue-300
      doc.text('AI DEAL AGENT', ML, 22);

      // Report date (right-aligned in header)
      const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      doc.setFontSize(8);
      doc.setTextColor(200, 225, 255);
      doc.text(today, W - 16, 14, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text('Deal Analysis Report', W - 16, 22, { align: 'right' });

      y = 40;

      // ════════════════════════════════════════════════════════════════
      // SECTION 1 — Deal Overview
      // ════════════════════════════════════════════════════════════════
      sectionLabel('Deal Overview');

      // Brand name (large, dark)
      const brand = emailData.sender || emailData.brandName || 'Unknown Brand';
      bodyText(brand, 14, 15, 23, 42, true);
      y += 2;

      // Email subject
      bodyText(emailData.subject || '(No subject)', 10, 71, 85, 105);
      y += 1;

      // Sender email + date chips
      const chips = [];
      if (emailData.senderEmail) chips.push(emailData.senderEmail);
      if (emailData.date)        chips.push(emailData.date);
      if (chips.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(100, 116, 139);
        checkBreak(6);
        doc.text(chips.join('   \u00B7   '), ML, y);
        y += 5;
      }

      y += 4;
      rule();

      // ════════════════════════════════════════════════════════════════
      // SECTION 2 — Fairness Score
      // ════════════════════════════════════════════════════════════════
      sectionLabel('Fairness Score');

      // Score badge (coloured filled square with rounded corners)
      const [sr, sg, sb] = scoreRGB;
      doc.setFillColor(sr, sg, sb);
      doc.roundedRect(ML, y, 22, 22, 2, 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(19);
      doc.setTextColor(10, 10, 10);
      doc.text(String(score), ML + 11, y + 14, { align: 'center' });

      // Verdict text to the right of badge
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(sr, sg, sb);
      doc.text(verdict, ML + 28, y + 9);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text('out of 10', ML + 28, y + 16);

      y += 28;

      // Agent verdict banner (coloured band)
      const bannerLabel = score <= 4
        ? 'RED FLAG: Decline Recommended'
        : score <= 7
        ? 'NEGOTIATE: Push for Better Terms'
        : 'TAKE THE DEAL: High-Priority Win';
      const [banR, banG, banB] = score <= 4 ? [220, 38,  38] : score <= 7 ? [202, 138, 4] : [21, 128, 61];
      const bannerBg            = score <= 4 ? [255, 77,  77] : score <= 7 ? [255, 215, 0] : [40, 167, 69];
      doc.setFillColor(...bannerBg);
      doc.roundedRect(ML, y, CW, 10, 2, 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(banR, banG, banB);
      doc.text(bannerLabel, ML + 5, y + 6.5);
      y += 14;

      // Rationale
      if (aiData.fairnessRationale) {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9.5);
        doc.setTextColor(71, 85, 105);
        const ratLines = doc.splitTextToSize(aiData.fairnessRationale, CW);
        ratLines.forEach(line => { checkBreak(5); doc.text(line, ML, y); y += 4.8; });
        y += 3;
      }

      // Score breakdown table
      const breakdown = aiData.score_breakdown ?? [];
      if (breakdown.length) {
        checkBreak(10);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        doc.text('SCORE BREAKDOWN', ML, y);
        y += 5;

        breakdown.forEach(item => {
          checkBreak(5.5);
          const v    = Number(item.value ?? 0);
          const sign = v > 0 ? '+' : '';
          const [ivR, ivG, ivB] = v > 0 ? [34, 197, 94] : v < 0 ? [239, 68, 68] : [100, 116, 139];

          // Label (left)
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(71, 85, 105);
          const lbl = doc.splitTextToSize(String(item.label || ''), CW - 22)[0] || '';
          doc.text(lbl, ML + 3, y);

          // Value (right, colour-coded)
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(ivR, ivG, ivB);
          doc.text(`${sign}${v.toFixed(1)}`, W - 16, y, { align: 'right' });
          y += 4.5;
        });
        y += 4;
      }

      rule();

      // ════════════════════════════════════════════════════════════════
      // SECTION 3 — Detected Red Flags
      // ════════════════════════════════════════════════════════════════
      const risks = aiData.detectedRisks ?? [];
      sectionLabel('Detected Red Flags');

      if (!risks.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(34, 197, 94);
        checkBreak(8);
        doc.text('\u2713 No contract risks identified by AI.', ML, y);
        y += 8;
      } else {
        risks.forEach(r => {
          checkBreak(20);
          const sev          = (r.severity ?? 'medium').toLowerCase();
          const isCrit       = sev === 'critical' || sev === 'high';
          const [bR, bG, bB] = isCrit ? [248, 113, 113] : sev === 'medium' ? [251, 191, 36] : [52, 211, 153];

          // Severity pill
          doc.setFillColor(bR, bG, bB);
          doc.roundedRect(ML, y - 3.5, 22, 5.5, 1.2, 1.2, 'F');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(6);
          doc.setTextColor(20, 20, 20);
          doc.text(sev.toUpperCase(), ML + 11, y + 0.5, { align: 'center' });

          // Clause text
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(10);
          doc.setTextColor(bR, bG, bB);
          const clauseLines = doc.splitTextToSize(r.clause || '', CW - 27);
          doc.text(clauseLines, ML + 26, y);
          y += clauseLines.length * 5;

          // Explanation
          if (r.explanation) {
            const expLines = doc.splitTextToSize(r.explanation, CW - 5);
            expLines.forEach(line => {
              checkBreak(5);
              doc.setFont('helvetica', 'normal');
              doc.setFontSize(8.5);
              doc.setTextColor(100, 116, 139);
              doc.text(line, ML + 4, y);
              y += 4.5;
            });
          }
          y += 5;
        });
      }

      rule();

      // ════════════════════════════════════════════════════════════════
      // SECTION 4 — Strategic Advice
      // ════════════════════════════════════════════════════════════════
      sectionLabel('Strategic Advice');

      const advice = aiData.fairnessRationale || 'No strategic advice available.';
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(30, 41, 59);
      doc.splitTextToSize(advice, CW).forEach(line => {
        checkBreak(6);
        doc.text(line, ML, y);
        y += 5;
      });
      y += 5;

      // ════════════════════════════════════════════════════════════════
      // FOOTER — last page
      // ════════════════════════════════════════════════════════════════
      drawFooter();

      // ── Save ──
      const brandSafe = (emailData.sender || 'Deal')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 20) || 'Deal';
      const dateStamp = new Date().toISOString().slice(0, 10);
      doc.save(`Vynta_${brandSafe}_${dateStamp}.pdf`);

      showToast('✓ PDF exported!');

    } catch (err) {
      showToast('\u26a0 PDF export failed — ' + err.message);
    } finally {
      if (btn?.isConnected) {
        btn.textContent = '📄 Export PDF Report';
        btn.disabled    = false;
      }
    }
  }

  /**
   * Returns false if the extension context has been invalidated (e.g. after
   * a reload). All async callbacks should bail early if this returns false.
   */
  function isContextValid() {
    try {
      // Accessing chrome.runtime.id throws if the context is invalidated
      return !!(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function $(id) {
    if (!isContextValid()) return null;
    try { return shadowRoot?.getElementById(id); } catch (_) { return null; }
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function mkChip(t) { return `<span class="meta-chip">${esc(t)}</span>`; }

  // ─────────────────────────────────────────────────────────────────────────
  // 7. INIT
  // ─────────────────────────────────────────────────────────────────────────

  // Load profile + history before anything runs so both are ready for the first analysis
  Promise.all([loadProfile(), loadHistory()]).then(() => {
    watchForEmail(
      (messageEl, threadId) => injectButton(() => toggleSidebar(messageEl, threadId)),
      ()                    => { cache = null; removeButton(); closeSidebar(); }
    );
  });

})();
