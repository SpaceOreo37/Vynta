/**
 * detector.js — Gmail email-open detection via MutationObserver.
 *
 * Gmail is a SPA; navigating to an email doesn't trigger a page load.
 * We watch the DOM for the appearance of an open email thread and fire
 * a callback when one is detected.
 *
 * Phase 2 extension point:
 *   - `extractEmailText()` will be added here to scrape the visible email
 *     body and return it to the sidebar for API analysis.
 */

// Selector for an open email message block in Gmail.
// Gmail's DOM changes periodically; if this breaks, inspect a live email
// and look for the element wrapping the sender name + subject line.
const EMAIL_MESSAGE_SELECTOR = '.gs';        // Individual message in a thread
const EMAIL_SUBJECT_SELECTOR = '.hP';        // Subject line element
const EMAIL_BODY_SELECTOR    = '.a3s.aiL';   // Decoded email body

/**
 * Starts watching Gmail's DOM for an open email.
 *
 * @param {(messageEl: Element) => void} onEmailOpen
 *   Called each time a new email message becomes visible.
 *   Receives the root message element so the caller can position the button.
 *
 * @returns {() => void} A cleanup function that stops the observer.
 */
export function watchForEmail(onEmailOpen) {
  let lastSeenThreadId = null;

  const observer = new MutationObserver(() => {
    // Gmail encodes the open thread in the URL hash, e.g. #inbox/THREAD_ID
    const threadId = getThreadIdFromUrl();
    if (!threadId || threadId === lastSeenThreadId) return;

    // Look for an open, visible email message block
    const messageEls = document.querySelectorAll(EMAIL_MESSAGE_SELECTOR);
    if (messageEls.length === 0) return;

    lastSeenThreadId = threadId;

    // Pass the last (most recently expanded) message to the callback
    const latestMessage = messageEls[messageEls.length - 1];
    onEmailOpen(latestMessage);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Return a cleanup function so index.js can tear down if needed
  return () => observer.disconnect();
}

/**
 * Extracts the thread ID segment from Gmail's hash-based URL.
 * Returns null if no email is open.
 *
 * @returns {string|null}
 */
function getThreadIdFromUrl() {
  const hash = window.location.hash; // e.g. "#inbox/FMfcgzQZTHDnvWtLmKPQxRsW"
  const match = hash.match(/#[^/]+\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Phase 2 stub: scrapes the visible email body text.
 * Will be fully implemented in Phase 2 (DOM Scraper).
 *
 * @param {Element} messageEl — the root message element
 * @returns {{ subject: string, body: string }}
 */
export function extractEmailText(messageEl) {
  const subjectEl = document.querySelector(EMAIL_SUBJECT_SELECTOR);
  const bodyEl    = messageEl.querySelector(EMAIL_BODY_SELECTOR);

  return {
    subject: subjectEl?.innerText?.trim() ?? '',
    body:    bodyEl?.innerText?.trim()    ?? '',
  };
}
