/**
 * button.js — Injects the "Analyze Deal" button into an open Gmail email.
 *
 * Injection strategy:
 *   We target the email's action toolbar (.G-tF) which holds the
 *   archive / delete / move buttons. If that toolbar isn't present
 *   (e.g. Gmail layout changes), we fall back to prepending to the
 *   message header (.ha).
 *
 * Phase 2 extension point:
 *   The onClick handler currently just toggles the sidebar.
 *   In Phase 2, it will also call extractEmailText() and pass the
 *   result into the sidebar before opening.
 */

const BUTTON_ID       = 'vynta-analyze-btn';
const TOOLBAR_SELECTOR = '.G-tF';   // Gmail action toolbar (top of thread view)
const FALLBACK_SELECTOR = '.ha';    // Message header row

/**
 * Injects the "Analyze Deal" button near the email toolbar.
 * Safe to call multiple times — removes any existing button first.
 *
 * @param {() => void} onClick — called when the button is clicked
 */
export function injectAnalyzeButton(onClick) {
  removeAnalyzeButton();

  const button = createButton(onClick);

  const toolbar = document.querySelector(TOOLBAR_SELECTOR);
  if (toolbar) {
    toolbar.appendChild(button);
    return;
  }

  // Fallback: prepend to the message header area
  const header = document.querySelector(FALLBACK_SELECTOR);
  if (header) {
    header.prepend(button);
    return;
  }

  // Last resort: inject into the document body (still functional)
  document.body.appendChild(button);
}

/**
 * Removes the injected button if it exists.
 */
export function removeAnalyzeButton() {
  document.getElementById(BUTTON_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function createButton(onClick) {
  const btn = document.createElement('button');
  btn.id          = BUTTON_ID;
  btn.textContent = '⚡ Analyze Deal';
  btn.title       = 'Open Vynta – AI Deal Agent';

  Object.assign(btn.style, {
    display:         'inline-flex',
    alignItems:      'center',
    gap:             '6px',
    margin:          '0 8px',
    padding:         '6px 14px',
    background:      '#1a73e8',
    color:           '#fff',
    border:          'none',
    borderRadius:    '4px',
    fontSize:        '13px',
    fontFamily:      'Google Sans, Roboto, sans-serif',
    fontWeight:      '500',
    cursor:          'pointer',
    verticalAlign:   'middle',
    letterSpacing:   '0.01em',
    boxShadow:       '0 1px 3px rgba(0,0,0,.2)',
    transition:      'background 0.15s ease',
    zIndex:          '9998',
  });

  btn.addEventListener('mouseenter', () => { btn.style.background = '#1557b0'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#1a73e8'; });

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // Don't let Gmail intercept the click
    onClick();
  });

  return btn;
}
