/**
 * sidebar.js — Shadow DOM sidebar host.
 *
 * Uses a Shadow DOM so our styles are fully isolated from Gmail's CSS.
 * The host element is appended directly to <body>.
 *
 * Phase 3 extension points (marked with "// [Phase N]"):
 *   - setStatus()  → drive the status card from API responses
 *   - renderAnalysis() → display fairness score, red flags, counter-offer
 *
 * Public API:
 *   open()   — animates the panel open
 *   close()  — animates the panel closed, then removes host
 *   toggle() — opens if closed, closes if open
 *   isOpen() — returns boolean
 */

const HOST_ID = 'vynta-sidebar-host';

let hostEl     = null;
let shadowRoot = null;
let panelEl    = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function open() {
  if (isOpen()) return;
  _mount();
}

export function close() {
  if (!isOpen()) return;

  panelEl.classList.add('closing');
  panelEl.addEventListener('animationend', () => {
    hostEl?.remove();
    hostEl  = null;
    shadowRoot = null;
    panelEl = null;
  }, { once: true });
}

export function toggle() {
  isOpen() ? close() : open();
}

export function isOpen() {
  return !!document.getElementById(HOST_ID);
}

/**
 * Phase 3: Update the sidebar status while an API call is in flight.
 * @param {'ready'|'loading'|'error'} state
 * @param {string} [message]
 */
export function setStatus(state, message) {
  if (!shadowRoot) return;

  const icon  = shadowRoot.querySelector('.vynta-status-icon');
  const label = shadowRoot.querySelector('.vynta-status-label');
  const desc  = shadowRoot.querySelector('.vynta-status-desc');

  const states = {
    ready:   { icon: '⚡', label: 'Vynta Ready',      desc: 'Click "Analyze Deal" on an email to begin.' },
    loading: { icon: '🔍', label: 'Analyzing...',       desc: message ?? 'Reading deal terms and benchmarks.' },
    error:   { icon: '⚠️', label: 'Analysis Failed',   desc: message ?? 'Check your API key in settings.' },
  };

  const s = states[state] ?? states.ready;
  if (icon)  icon.textContent  = s.icon;
  if (label) label.textContent = s.label;
  if (desc)  desc.textContent  = s.desc;
}

export function renderAnalysis(_analysis) {}

// ---------------------------------------------------------------------------
// Private: DOM construction
// ---------------------------------------------------------------------------

function _mount() {
  hostEl = document.createElement('div');
  hostEl.id = HOST_ID;

  // Attach a Shadow DOM to isolate styles from Gmail
  shadowRoot = hostEl.attachShadow({ mode: 'open' });

  // Load the sidebar stylesheet into the shadow root
  const styleLink = document.createElement('link');
  styleLink.rel  = 'stylesheet';
  styleLink.href = chrome.runtime.getURL('src/sidebar/sidebar.css');
  shadowRoot.appendChild(styleLink);

  // Build the panel HTML
  shadowRoot.appendChild(_buildPanel());

  document.body.appendChild(hostEl);

  // Store reference to the panel for animations and updates
  panelEl = shadowRoot.querySelector('.vynta-panel');
}

function _buildPanel() {
  const panel = document.createElement('div');
  panel.className = 'vynta-panel';

  panel.innerHTML = `
    <header class="vynta-header">
      <div class="vynta-header-title">
        <span class="vynta-logo">⚡</span>
        <div>
          <h1 class="vynta-title">Vynta</h1>
          <p class="vynta-subtitle">AI Deal Agent</p>
        </div>
      </div>
      <button class="vynta-close-btn" title="Close">✕</button>
    </header>

    <main class="vynta-body">
      <div class="vynta-status-card">
        <span class="vynta-status-icon">⚡</span>
        <h2 class="vynta-status-label">Vynta Ready</h2>
        <p class="vynta-status-desc">
          Click "Analyze Deal" on an open brand email to detect red flags,
          check market rates, and generate a counter-offer.
        </p>
      </div>

      <div class="vynta-phases">
        <p class="vynta-phases-title">Build progress</p>

        <div class="vynta-phase-item active">
          <span class="vynta-phase-badge">Phase 1</span>
          Gmail integration &amp; sidebar — <strong>complete</strong>
        </div>

        <div class="vynta-phase-item pending">
          <span class="vynta-phase-badge">Phase 2</span>
          DOM scraper — email text extraction
        </div>

        <div class="vynta-phase-item pending">
          <span class="vynta-phase-badge">Phase 3</span>
          AI · Vossian Agent analysis
        </div>

        <div class="vynta-phase-item pending">
          <span class="vynta-phase-badge">Phase 4</span>
          Fairness Meter UI · counter-offer drafts
        </div>
      </div>
    </main>

    <footer class="vynta-footer">
      Vynta v1.0 · AI Deal Agent
    </footer>
  `;

  // Wire up close button
  panel.querySelector('.vynta-close-btn').addEventListener('click', close);

  return panel;
}
