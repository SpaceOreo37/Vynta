# ⚡ Vynta — AI Deal Agent for Creators

> A 2026-ready AI agent that lives in your browser to help you negotiate better, safer, and more profitable brand deals. Built for the modern creator-entrepreneur, it transforms your Gmail into a professional talent agency, ensuring you never leave money on the table or your identity at risk.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Manifest](https://img.shields.io/badge/manifest-v3-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## What It Does

Vynta injects directly into Gmail. When you open a brand partnership email, one click runs the full analysis pipeline:

1. **Scrapes** the email body, subject, and sender — stripping quoted replies and signatures
2. **Pre-scans** for legal red flags before a single API token is spent
3. **Sends** the cleaned text to AI with a structured 2026 market rates knowledge base
4. **Returns** a Fairness Score, a weighted score breakdown, detected risks, and three ready-to-send counter-offer drafts

No data leaves your browser except to the Anthropic API using your own key.

---

## Key Features

### 🧮 Weighted Scoring Engine

The fairness score is not a gut-check — it is a deterministic, multi-step algorithm anchored to 2026 creator economy data.

**Scoring starts at 5.0** and adjustments are applied in layers:

| Layer | What it measures | Range |
|---|---|---|
| Offer Multiplier | `offered ÷ tier typical` — the primary driver | −3.5 → +3.0 |
| Deliverable Effort | Reels, YouTube integrations, Live Q&As add production burden | −1.0 → 0 |
| Usage Rights | Duration of rights granted without compensation | −4.5 → 0 |
| Exclusivity | Category or full lock-out without a premium | −3.5 → +0.5 |
| Whitelisting | Paid ad rights granted without a 30% add-on | −2.0 → 0 |
| Engagement Tier | Elite (10%+), Strong (5–10%), Average (<5%) | 0 → +1.0 |
| Niche Premium | Finance, Luxury, Tech, Health command higher rates | 0 → +0.5 |
| Value-Add Bonuses | Retainers, affiliate commission, kill fees, IP retention | 0 → +2.0 |
| Risk Penalties | Legal red flags — stack without a cap | −4.5 each |
| Deal Sentiment | Personalized outreach vs. mass template | 0 → +0.5 |

**The score breakdown is shown in the sidebar for every analysis** — every adjustment is labeled, signed, and color-coded so creators understand exactly why a deal scored the way it did.

#### Relative Value Logic

A flat dollar comparison is meaningless across tiers. Vynta uses a **percentage-based Offer Multiplier**:

```
offerMultiplier = offeredRate / tierTypical
```

| Multiplier | Score Adjustment | What it means |
|---|---|---|
| ≥ 3.0× | +3.0 | Exceptional — well above market |
| 2.0–2.99× | +2.5 | Strong premium |
| 1.5–1.99× | +1.5 | Above market |
| 1.0–1.49× | +0.5 | At market |
| 0.75–0.99× | 0.0 | Slightly below |
| 0.5–0.74× | −2.0 | Below market |
| < 0.5× | −3.5 | Lowball |

This means a **$1,200 Nano deal** (4.8× the $250 typical) scores as exceptional, while a **$5,000 Mega deal** (0.07× the $75,000 typical) is correctly flagged as a lowball — even though the absolute dollar amount is higher.

#### Suppression Rule

If the Offer Multiplier is ≥ 2.0×, minor penalty items (30-day usage rights, 1-month category exclusivity) are automatically suppressed — the premium mathematically covers them. Suppressed items appear in the breakdown labeled `(suppressed — premium covers)`.

If the Offer Multiplier is < 1.0×, **strict mode** activates: every applicable penalty fires with no suppression.

---

### 🛡️ 2026 AI-Likeness Protection

Vynta specifically scans for clauses that have become legally significant in 2026, including under the Tennessee ELVIS Act and similar state-level legislation:

| Clause | Risk | Penalty |
|---|---|---|
| `"right to train AI / ML models"` | Your voice and face can be cloned into synthetic content without ongoing consent or payment | **−4.5 (Critical)** |
| `"in perpetuity"` / `"irrevocable"` | Brand owns the content forever with no expiry | **−3.5 (Critical)** |
| `"total buyout"` / `"work for hire"` | You forfeit all future revenue from the content | **−3.0 (Critical)** |
| `"sublicensable"` | Brand can resell your footage to third parties — including competitors | **−2.5 (High)** |
| `"any and all media"` / `"all channels"` | Unlimited distribution rights across TV, OOH, and paid ads | **−1.5 (Medium)** |

Critical penalties **stack without a cap** and cannot be suppressed by a high offer. A deal with an AI-likeness clause cannot score above 5.0 regardless of rate.

---

### 📊 Dynamic Market Benchmarking

Every analysis is calibrated against the creator's specific tier. Rate Card settings are saved locally and injected into every prompt:

| Tier | Followers | Typical Rate | Min | Max |
|---|---|---|---|---|
| Nano | 1k – 10k | $250 | $150 | $800 |
| Micro | 10k – 100k | $2,000 | $800 | $5,500 |
| Mid-Tier | 100k – 500k | $12,000 | $2,000 | $35,000 |
| Macro | 500k – 1M | $25,000 | $10,000 | $100,000 |
| Mega | 1M+ | $75,000 | $30,000 | $500,000 |

Rate Card settings also capture **engagement tier** (Elite / Strong / Average) and **niche** (Finance, Tech, Luxury, Health, etc.), which adjust both the benchmark comparison and the score.

**Sources:** Influencer Marketing Hub 2026, Later / Hootsuite Influencer Reports 2026, Afluencer Rate Guide 2026, Shopify Influencer Pricing Guide 2026, NeoReach Creator Economy Report 2026.

---

## Counter-Offer Drafts

Three ready-to-use reply drafts are generated for every analysis, each citing at least one concrete market number:

- **Professional** — Firm, data-driven, benchmarks the offer against 2026 rates
- **Collaborator** — Warm and partnership-focused while still protective of your rights  
- **Hard-Baller** — Assertive, high-anchoring, uses Chris Voss labelling and mirroring techniques

Drafts can be copied to clipboard or auto-injected directly into the Gmail reply box with one click.

---

## Architecture

```
Vynta/
├── manifest.json                  # MV3 manifest
├── market_rates.json              # 2026 benchmark data
├── src/
│   ├── background/
│   │   └── service-worker.js      # AI API calls, scoring algorithm, caching
│   └── content/
│       └── content.js             # Gmail DOM scraper, sidebar, button injection
├── popup/
│   └── popup.html / .js / .css   # Extension popup
└── icons/
```

**Key technical decisions:**

- **Shadow DOM sidebar** — fully isolated from Gmail's CSS; survives Gmail's frequent DOM re-renders
- **SPA navigation detection** — polls `window.location.href` at 500ms because Gmail uses `history.pushState`, not `hashchange`
- **Analysis cache** — keyed by thread ID so results survive sidebar close/reopen without re-querying the API
- **3-layer market rates cache** — memory → `chrome.storage.local` → file fetch; rates are never re-fetched across Chrome sessions after first load
- **`requestIdleCallback` for DOM scraping** — yields to the Gmail paint cycle before running extraction, keeping the UI smooth
- **`AbortController` timeout** — hard 60-second stop on all API calls

---

## Setup

### Prerequisites
- Google Chrome (or any Chromium browser)
- An [Anthropic API key](https://console.anthropic.com)

### Installation

**1. Clone the repository**
```bash
git clone https://github.com/your-username/vynta.git
cd vynta
```

**2. Add your API key**

Click the **⚙** icon inside the Vynta sidebar → scroll to **AI Configuration** → paste your Anthropic API key → **Save Key**. Your key is stored locally in `chrome.storage.local` and never sent anywhere except directly to the Anthropic API.

**3. Load the extension**

- Navigate to `chrome://extensions`
- Enable **Developer mode** (toggle, top right)
- Click **Load unpacked**
- Select the `Vynta/` folder



**4. Set your Rate Card**

Open a Gmail email → click **⚡ Analyze Deal** → click the **⚙** icon → enter your follower count, niche, and engagement tier → **Save Rate Card**.

### Usage

1. Open any brand deal email in Gmail
2. Click the **⚡ Analyze Deal** button (appears near the toolbar)
3. Review the pre-scan for red flags
4. Click **🤖 Analyze with AI**
5. Review your Fairness Score, score breakdown, and detected risks
6. Pick a draft → **↳ Use Draft** to inject it directly into your reply box

---

## Scoring Reference

```
Final Score = 5.0 (base)
            + Offer Multiplier adjustment   ← primary driver
            + Deliverable modifiers
            + Usage rights modifiers
            + Exclusivity modifiers
            + Whitelisting modifier
            + Engagement tier bonus
            + Niche bonus
            + Value-add bonuses
            + Risk penalties (stacked, uncapped)
            + Deal sentiment bonus
            → Clamped to [1.0, 10.0], rounded to nearest 0.5
```

| Score | Verdict | Meaning |
|---|---|---|
| 8.0 – 10.0 | ✅ Fair Offer | At or above market; push for extras, not rate |
| 5.0 – 7.5 | ⚠️ Mixed Terms | Some fair elements; specific clauses need negotiation |
| 1.0 – 4.5 | 🚨 Below Market | Predatory or significantly undervalued; counter firmly |

A score of **9.0–10.0** requires: Offer Multiplier ≥ 1.5×, at least one value-add structure (retainer, commission, kill fee), and zero critical-severity penalties.

---

## Privacy

- All processing happens locally in your browser
- Email text is sent only to the Anthropic API using **your own API key** — no Vynta server ever sees it
- Your API key and Rate Card are stored in `chrome.storage.local` — never transmitted to any Vynta server

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">Built for creator-entrepreneurs who know their worth.</p>
