/**
 * service-worker.js — Vynta background service worker.
 *
 * API key is stored in chrome.storage.local via the Settings UI (BYOK).
 * It is passed in every message payload from the content script.
 */

// ─── API Configuration ────────────────────────────────────────────────────────

const ANTHROPIC_MODEL    = 'claude-sonnet-4-6';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

const MIN_EMAIL_CHARS = 80;
const MAX_EMAIL_CHARS = 4000;  // covers all real-world brand deal emails; fewer tokens = faster
const TIMEOUT_MS      = 120000; // 2-minute hard stop

// ─── Vynta Vossian Agent System Prompt ────────────────────────────────────

const SYSTEM_PROMPT = `
You are a high-stakes Talent Agent and negotiation expert using the "Tactical Empathy" framework developed by Chris Voss. You represent independent creators in brand deal negotiations.

TONE: Professional, protective, and data-driven. Never sound desperate or apologetic. Speak from a position of informed strength.

[2026 MARKET BENCHMARKS — all tiers]
Nano 1k–10k: $150–$800 (typ $250) | Micro 10k–100k: $800–$5,500 (typ $2k) | Mid 100k–500k: $2k–$35k (typ $12k) | Macro 500k–1M: $10k–$100k (typ $25k) | Mega 1M+: $30k–$500k (typ $75k)
Usage rights: +20% per 6mo | Exclusivity: +15%/mo | Whitelisting: +30% | Perpetual: +200% or refuse.
Engagement: Elite 10%+ = 2× baseline | Strong 5–10% = 1.5× | Average <5% = 1×.

[LEGAL RED FLAGS]
"In perpetuity" / "throughout the universe" → permanent ownership.
"Sublicensable" → brand can resell your footage to third parties.
"Train AI / ML models" → your likeness used for synthetic content.
"Total buyout" / "work for hire" → forfeits all future revenue.

[YOUR TASK]
1. Extract key deal terms (rate, deliverables, usage rights, exclusivity, timeline).
2. Determine creator tier from follower count if mentioned; compare offered rate to that tier's typical.
3. Flag every red-flag clause present.
4. Produce a Fairness Score (1.0–10.0, nearest 0.5) using the SCORING ALGORITHM in the user message.
   The score is driven primarily by the Offer Multiplier (offered ÷ tier typical), not line-item checklists.
   1–4: Below market / predatory | 5–7: Mixed | 8–10: Fair to generous
5. Write three counter-offer reply drafts (reply body only, no subject, start with salutation).
   Max 150 words each. Each MUST cite at least one concrete number ($, %, or multiplier).
   "professional": Firm, data-driven, benchmarks. | "collaborator": Warm but protective. | "hardBaller": Voss labelling + high anchor.

[OUTPUT FORMAT — CRITICAL]
Respond with ONLY valid JSON. No markdown, no text outside the JSON.

{
  "fairnessScore": <number 1.0–10.0 nearest 0.5>,
  "score_breakdown": [
    { "label": "<e.g. 'Base Score' or 'Rate: 4.8x typical'>", "value": <signed float> }
  ],
  "fairnessRationale": "<MAX 2 sentences: what drove the score and the single most important thing the creator should push for>",
  "detectedRisks": [
    { "clause": "<phrase>", "severity": "<critical | high | medium | low>", "explanation": "<one sentence>" }
  ],
  "drafts": {
    "professional": "<reply body>",
    "collaborator": "<reply body>",
    "hardBaller": "<reply body>"
  }
}
`.trim();

// ─── Market Rates Loader ──────────────────────────────────────────────────────

let _cachedRates = null;

async function getMarketRates() {
  // 1. Memory cache — fastest path (within same service-worker lifetime)
  if (_cachedRates) return _cachedRates;

  // 2. chrome.storage.local — survives service-worker restarts
  try {
    const stored = await chrome.storage.local.get(['_negRatesCache']);
    if (stored._negRatesCache) {
      _cachedRates = stored._negRatesCache;
      return _cachedRates;
    }
  } catch (_) {}

  // 3. Fetch from bundled file and persist
  try {
    const resp = await fetch(chrome.runtime.getURL('market_rates.json'));
    _cachedRates = await resp.json();
    chrome.storage.local.set({ _negRatesCache: _cachedRates }).catch(() => {});
  } catch (_e) {
    _cachedRates = null;
  }
  return _cachedRates;
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANALYZE_DEAL') {
    analyzeDeal(message.payload)
      .then(data => {
        try { sendResponse({ ok: true, data }); } catch (_) { /* port closed */ }
      })
      .catch(err => {
        try { sendResponse({ ok: false, error: err.message }); } catch (_) { /* port closed */ }
      });
    return true;
  }

  if (message.type === 'TEST_CONNECTION') {
    testConnection(message.payload?.apiKey)
      .then(() => {
        try { sendResponse({ ok: true }); } catch (_) {}
      })
      .catch(err => {
        try { sendResponse({ ok: false, error: err.message }); } catch (_) {}
      });
    return true;
  }
});

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Validates the API key forwarded from the content script.
 */
function resolveApiKey(payloadKey) {
  const key = payloadKey;
  if (!key || key === 'YOUR_API_KEY_HERE') {
    throw new Error(
      'Action Required: Please enter your Anthropic API Key in Settings to begin.'
    );
  }
  return key;
}

/**
 * Translates raw Anthropic HTTP error codes into user-friendly messages.
 */
function humaniseApiError(status, rawMsg) {
  if (status === 401) {
    return 'Invalid API key — please check the key you entered in Settings and try again.';
  }
  if (status === 403) {
    return 'API key does not have permission to use this model. Make sure you are using a key from console.anthropic.com.';
  }
  if (status === 429) {
    return 'Rate limit reached. Wait a moment and try again, or check your usage at console.anthropic.com.';
  }
  if (status === 529 || (status >= 500 && status < 600)) {
    return 'The Anthropic API is temporarily unavailable. Please try again in a minute.';
  }
  // Billing / credit errors come back as 400 with specific message text
  if (status === 400 && /credit|billing|balance/i.test(rawMsg)) {
    return 'Insufficient API credits — please top up your balance at console.anthropic.com/settings/billing.';
  }
  return rawMsg || `API error (HTTP ${status})`;
}

/**
 * Makes the smallest possible API call to verify a key is valid and has credits.
 */
async function testConnection(apiKey) {
  const key = resolveApiKey(apiKey);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15000); // 15s timeout for test

  let response;
  try {
    response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key':                                 key,
        'anthropic-version':                         '2023-06-01',
        'content-type':                              'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      ANTHROPIC_MODEL,
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Reply with the single word: OK' }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Connection timed out. Check your internet connection.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(errText); } catch { parsed = null; }
    const rawMsg = parsed?.error?.message ?? errText;
    throw new Error(humaniseApiError(response.status, rawMsg));
  }
  // Success — key is valid and has credits
}

async function analyzeDeal({ subject, body, redFlags, rateProfile, apiKey }) {
  // ── Resolve & validate API key ──
  const key = resolveApiKey(apiKey);

  const cleanBody = (body ?? '').trim();

  if (cleanBody.length < MIN_EMAIL_CHARS) {
    throw new Error(
      `Email body is too short to analyze (${cleanBody.length} characters). Open a more detailed brand deal email and try again.`
    );
  }

  // Trim very long emails to stay within token budget
  const trimmedBody = cleanBody.length > MAX_EMAIL_CHARS
    ? cleanBody.slice(0, MAX_EMAIL_CHARS) + '\n\n[Content trimmed for analysis]'
    : cleanBody;

  const rates = await getMarketRates();
  const userMessage = buildUserMessage(subject, trimmedBody, redFlags, rateProfile, rates);

  // ── Timeout via AbortController ──
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key':                                 key,
        'anthropic-version':                         '2023-06-01',
        'content-type':                              'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      ANTHROPIC_MODEL,
        max_tokens: 8192,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `Analysis timed out after ${TIMEOUT_MS / 1000} seconds. ` +
        'This can happen when the AI is under high load. Please try again.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let parsed;
    try { parsed = JSON.parse(errText); } catch { parsed = null; }
    const rawMsg = parsed?.error?.message ?? errText;
    throw new Error(humaniseApiError(response.status, rawMsg));
  }

  const raw  = await response.json();
  const text = raw?.content?.[0]?.text ?? '';

  // Check if the AI stopped mid-response due to hitting the token limit
  const stopReason = raw?.stop_reason;
  if (stopReason === 'max_tokens') {
    throw new Error(
      'The AI response was too long and got cut off. The email may be unusually complex. ' +
      'Please try again — results are usually shorter on retry.'
    );
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI returned a response with no JSON object. Please try again.');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Failed to parse AI response as JSON: ' + e.message);
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildUserMessage(subject, body, redFlags, rateProfile, rates) {
  // ── Creator profile context ──
  let profileSection = '';
  if (rateProfile && (rateProfile.followerCount || rateProfile.niche)) {
    const count      = rateProfile.followerCount ? Number(rateProfile.followerCount).toLocaleString() : 'unknown';
    const tier       = getFollowerTier(rateProfile.followerCount);
    const niche      = rateProfile.niche      || 'unspecified';
    const engagement = rateProfile.engagementRate || 'unspecified';
    const cpm        = rateProfile.typicalCPM  ? `$${rateProfile.typicalCPM} CPM` : null;

    profileSection = `
CREATOR PROFILE (use this to calibrate the Fairness Score):
  • Followers:        ${count} (${tier})
  • Niche:            ${niche}
  • Engagement Rate:  ${engagement}${cpm ? `\n  • Typical CPM:    ${cpm}` : ''}

`;
  }

  // ── Market rates scoring algorithm ──
  const ratesSection = rates ? buildRatesContext() : '';

  // ── Pre-scan flag hint ──
  const flagNote = redFlags?.length > 0
    ? `Pre-scan detected these potential red flag phrases:\n${redFlags.map(f => `  • ${f.label}`).join('\n')}\n\n`
    : '';

  return `${profileSection}${ratesSection}${flagNote}Please analyze the following brand deal email:

SUBJECT: ${subject}

EMAIL BODY:
${body}

Respond with the JSON analysis object now.`.trim();
}

function buildRatesContext() {
  return `[SCORING ALGORITHM — start at 5.0, clamp [1,10], round to nearest 0.5]

STEP 1: Base score = 5.0

STEP 2 — OFFER MULTIPLIER (primary driver; percentage-based, not flat dollar):
  Tier typicals: Nano $250 | Micro $2,000 | Mid $12,000 | Macro $25,000 | Mega $75,000
  offerMultiplier = offeredRate / tierTypical
  ≥ 3.0x → +3.0 | 2.0–2.99x → +2.5 | 1.5–1.99x → +1.5 | 1.0–1.49x → +0.5 | 0.75–0.99x → 0.0 | 0.5–0.74x → -2.0 | < 0.5x → -3.5
  Label entry as: "Rate: {X}x typical"

SUPPRESSION RULE — if offerMultiplier ≥ 2.0x:
  Suppress these minor penalties (premium already covers them — set to 0):
  • 30-day usage rights unpaid
  • Category exclusivity ≤ 1 month unpaid
  Note suppressed items in breakdown as "X (suppressed — premium covers)"

STRICT MODE — if offerMultiplier < 1.0x:
  Apply ALL penalties below with no suppression whatsoever.

STEP 3 — DELIVERABLES (apply per type in deal):
  Reel -0.5 | YT integration -0.75 | Live Q&A -1.0 (waived if monthly retainer present) | Blog -0.25 | others 0

STEP 4 — USAGE RIGHTS (if NOT separately compensated; subject to suppression rule):
  90-day -1.0 | 6-month -1.5 | 1-year -2.5 | perpetual -4.5

STEP 5 — EXCLUSIVITY (if NOT compensated; subject to suppression rule):
  None +0.5 | Category 1-month -0.5 | Category 3-month -1.5 | Category 6-month -2.5 | Full -3.5

STEP 6 — WHITELISTING (if NOT compensated): -2.0

STEP 7 — ENGAGEMENT (from creator profile):
  Elite 10%+ → +1.0 | Strong 5–10% → +0.5 | Average <5% → 0

STEP 8 — NICHE (from creator profile):
  Finance / Luxury → +0.5 | Tech / Health → +0.25 | All others → 0

STEP 9 — VALUE-ADD BONUSES (apply each present):
  Monthly retainer 2+ months → +2.0 | Affiliate/revenue share → +1.5 | Performance/KPI bonus → +1.0 | Creator retains IP → +0.75 | Kill fee clause → +0.5 | Content approval rights → +0.5

STEP 10 — RISK PENALTIES (stack without cap):
  AI/ML likeness training → -4.5 [critical] | Perpetuity/irrevocable → -3.5 [critical] | Total buyout/work-for-hire → -3.0 [critical] | Sublicensable → -2.5 [high] | Exclusivity 6+ months unpaid → -2.0 [high] | Undefined/all-channel usage → -1.5 [medium] | No content removal rights → -1.0 [medium]

STEP 11 — DEAL SENTIMENT bonus → +0.5:
  Apply ONLY if email is clearly personalized: mentions creator by name (not "Hi" / "Hi there" / "Hello Creator"), references a specific past video or post by title, or demonstrates specific knowledge of the creator's content beyond their general niche. Generic mass-template language → 0.

STEP 12: Score 9–10 requires: offerMultiplier ≥ 1.5x AND ≥1 value-add bonus AND 0 critical penalties.
Return score_breakdown: one entry per adjustment applied, base score first.

`;
}

function getFollowerTier(count) {
  const n = Number(count);
  if (!n)            return 'unknown tier';
  if (n < 1000)      return 'sub-nano (<1k)';
  if (n < 10000)     return 'nano (1k–10k, typical $250/post)';
  if (n < 100000)    return 'micro (10k–100k, typical $2,000/post)';
  if (n < 500000)    return 'mid-tier (100k–500k, typical $12,000/post)';
  if (n < 1000000)   return 'macro (500k–1M, typical $25,000/post)';
  return 'mega (1M+, typical $75,000/post)';
}
