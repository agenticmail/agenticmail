---
test: test-collab-MA-finance
label: M&A Finance
domain: Finance (M&A)
runtime: 78s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---

# Financial Due Diligence Report: TechCorp Acquisition

**Target:** TechCorp (B2B SaaS) | **Acquirer:** MegaCorp | **Price:** $400M | **Multiple:** 8.0x ARR | **Date:** March 27, 2026

---

## 1. VALUATION ASSESSMENT

**Headline:** 8.0x ARR is within range but on the higher end for a $50M ARR B2B SaaS company.

| Benchmark | Range | TechCorp |
|---|---|---|
| Median B2B SaaS (2025-26) | 5x–10x ARR | 8.0x |
| Growth-adjusted (Rule of 40) | Justified if Rule of 40 > 40% | **Must verify** |
| Comparable exits ($30M–$80M ARR) | 6x–12x ARR | Within range |

**Key question:** Is the 8x justified by growth rate? At $50M ARR:
- If growing 30%+ YoY with <10% net churn → 8x is reasonable
- If growing <20% YoY → 8x is a premium; negotiate down to 6x–7x
- If growing 40%+ → MegaCorp may be getting a deal

---

## 2. REVENUE QUALITY ANALYSIS

### 2A. ARR Composition — Investigate Thoroughly

| Revenue Type | Healthy Benchmark | Red Flag Threshold |
|---|---|---|
| Recurring (subscription) | >90% of total revenue | <80% |
| Professional services / one-time | <10% | >20% |
| Usage-based / variable | Depends on predictability | >30% without floor |

**Action items:**
- Decompose $50M ARR: What portion is truly contracted recurring vs. month-to-month vs. usage-based?
- If TechCorp reports "$50M ARR" but $8M+ is professional services, implementation, or one-time license fees, the **effective recurring ARR is $42M**, making the real multiple 9.5x — materially different
- Check for multi-year prepaid contracts that inflate current-period ARR but create future cliffs

### 2B. Customer Concentration — Critical Risk Factor

| Metric | Healthy | Moderate Risk | High Risk |
|---|---|---|---|
| Top 1 customer % of ARR | <5% | 5%–10% | >10% |
| Top 5 customers % of ARR | <15% | 15%–25% | >25% |
| Top 10 customers % of ARR | <25% | 25%–40% | >40% |

**Specific diligence:**
- If top customer = $5M+ (10%+ of ARR) → demand contract review, renewal dates, and termination clauses
- Request customer cohort data by size tier: Enterprise ($100K+ ACV), Mid-Market ($25K–$100K), SMB (<$25K)
- Ideal mix for a $50M ARR company: 200–500 customers at $100K–$250K ACV (mid-market/enterprise heavy)
- If >1,000 SMB customers with <$10K ACV → higher churn risk, different unit economics

### 2C. Churn & Retention — The Make-or-Break Metric

| Metric | Best-in-Class | Healthy | Concerning |
|---|---|---|---|
| Gross revenue retention | >95% | 90%–95% | <90% |
| Net revenue retention (NRR) | >120% | 100%–120% | <100% |
| Logo churn (annual) | <5% | 5%–10% | >10% |

**At $50M ARR with 8x valuation, we need:**
- NRR of 110%+ to justify the multiple (implies $5M+ in annual expansion from existing customers)
- Gross retention of 90%+ minimum; below this, the business is a leaky bucket
- **Calculate implied churn cost:** At 10% gross churn, TechCorp loses $5M ARR/year — new sales must first replace this before growing

**Red flag investigations:**
- Are churn figures calculated on ARR or on customer count? (Companies game this)
- Is "churn" being offset by forced upsells or price increases disguised as retention?
- Request monthly cohort retention curves, not just annual averages

---

## 3. MARGIN PROFILE

### 3A. Gross Margin

| Component | B2B SaaS Benchmark | Investigate If |
|---|---|---|
| Overall gross margin | 70%–85% | <70% |
| Subscription gross margin | 75%–90% | <75% |
| COGS breakdown: hosting | 5%–15% of revenue | >15% |
| COGS breakdown: support | 5%–10% of revenue | >10% |

**At $50M ARR, expected COGS structure:**
- Hosting/infrastructure: $3M–$6M (6%–12%)
- Customer support: $2M–$4M (4%–8%)
- **Target blended gross margin: $37.5M–$40M (75%–80%)**

**Investigate:** Are there hidden COGS? Some SaaS companies misclassify customer success, onboarding, or managed services as S&M instead of COGS, artificially inflating gross margin.

### 3B. EBITDA Margin

| Expense Category | % of Revenue (Healthy) | $ Amount at $50M |
|---|---|---|
| Gross Profit | 75%–80% | $37.5M–$40M |
| R&D | 20%–30% | $10M–$15M |
| Sales & Marketing | 25%–40% | $12.5M–$20M |
| G&A | 8%–15% | $4M–$7.5M |
| **EBITDA** | **5%–20%** | **$2.5M–$10M** |

**Key questions:**
- Is TechCorp EBITDA-positive? Many $50M ARR SaaS companies still burn cash if growing aggressively
- If EBITDA negative, what's the path to profitability? Model the "steady-state" margin by normalizing growth spend
- **Normalized EBITDA** (removing excess growth spend): If S&M is 40% ($20M) but could be 25% ($12.5M) at maintenance growth, normalized EBITDA could be $10M+ vs. reported breakeven — this changes the EV/EBITDA story dramatically

### 3C. R&D Spend Ratio

| R&D % of Revenue | Interpretation |
|---|---|
| 15%–20% | Mature product, maintenance mode |
| 20%–30% | Healthy investment, active development |
| 30%–40% | Heavy investment — platform buildout or technical debt |
| >40% | Concerning unless pre-product-market-fit (not at $50M ARR) |

**Investigate:**
- Is R&D capitalized or expensed? Capitalized R&D inflates EBITDA — request both views
- What % of R&D is maintenance vs. new product? High maintenance ratio = technical debt burden
- Headcount breakdown: If 60%+ of R&D staff joined in last 12 months, execution risk is elevated

---

## 4. WORKING CAPITAL REQUIREMENTS

### 4A. SaaS Working Capital Model

B2B SaaS typically has **favorable working capital** due to upfront/annual billing:

| Metric | Expected | Investigate If |
|---|---|---|
| Deferred revenue | $10M–$20M (20%–40% of ARR) | <$5M (short billing cycles) |
| DSO (Days Sales Outstanding) | 30–60 days | >75 days |
| Billing mix: annual vs. monthly | 60%+ annual | >50% monthly |

**At $50M ARR:**
- If 70% annual billing → ~$17.5M deferred revenue (cash collected upfront, recognized over time)
- This is a **cash flow advantage** — operating cash flow should exceed EBITDA
- If mostly monthly billing, deferred revenue is minimal and cash conversion is weaker

### 4B. Cash Conversion

- **Expected free cash flow margin:** 5%–15% for a healthy $50M ARR SaaS
- FCF should roughly equal or exceed EBITDA (due to deferred revenue benefit and low capex)
- If FCF is materially below EBITDA → investigate: capitalized software costs, large prepaid hosting contracts, or unusual working capital swings

---

## 5. DEBT STRUCTURE ASSUMPTIONS

### 5A. Target Balance Sheet

**Request and verify:**
- Existing debt (venture debt, credit facilities, convertible notes)
- Cash on hand and minimum cash requirements
- Any off-balance-sheet liabilities (operating leases under ASC 842, earnout obligations from prior acquisitions)

**Common findings at $50M ARR VC-backed SaaS:**
- $5M–$15M venture debt facility (Silicon Valley Bank, etc.)
- Possible convertible notes from earlier rounds
- Preferred stock liquidation preferences that affect net proceeds to common shareholders

### 5B. Acquisition Financing Implications

At $400M purchase price, if MegaCorp uses leverage:
- 3x–4x EBITDA leverage is typical for software acquisitions
- If normalized EBITDA = $8M, max comfortable debt = $24M–$32M
- Remaining $368M–$376M would be equity/cash — this is primarily an equity deal unless EBITDA is higher than modeled

---

## 6. KEY FINANCIAL RED FLAGS — PRIORITY INVESTIGATION LIST

### HIGH PRIORITY (Deal-breaker potential)

1. **Revenue recognition irregularities** — Request ASC 606 analysis. Are multi-year deals recognized appropriately? Any side letters granting unusual terms?
2. **Customer concentration cliff** — If top 3 customers = 30%+ of ARR AND any contract renews within 12 months of close, material risk
3. **Churn acceleration** — Is trailing 3-month churn trending worse than trailing 12-month? Companies clean up churn before a sale
4. **Deferred revenue decline** — If deferred revenue is shrinking while ARR is "growing," new bookings quality is deteriorating
5. **Related-party revenue** — Any revenue from investors, board members, or affiliated entities?

### MEDIUM PRIORITY (Valuation adjustment)

6. **Channel/reseller dependency** — If >20% of revenue comes through a single channel partner, risk of disintermediation
7. **Cohort economics deterioration** — Are recent cohorts (2024-2025) retaining worse than 2022-2023 cohorts? This is a leading indicator
8. **Capitalized R&D inflation** — If >30% of R&D is capitalized, EBITDA is overstated; request cash-basis adjustments
9. **Unusual Q4 loading** — If >35% of annual bookings land in Q4, pipeline is less predictable than it appears
10. **Pending litigation or tax exposure** — Request contingent liability schedule; SaaS companies often have state sales tax exposure for untaxed SaaS revenue in states that tax it

### LOWER PRIORITY (Integration risk)

11. **Key-person dependency** — If CTO/founder departure triggers customer termination rights
12. **Non-standard contracts** — Custom SLAs, unlimited usage tiers, or MFN clauses that limit pricing power
13. **Infrastructure lock-in** — Single-cloud dependency with no portability; costs could spike

---

## 7. RECOMMENDED DATA REQUESTS

To complete this analysis, the following should be requested from TechCorp:

1. Monthly ARR bridge (last 24 months): new, expansion, contraction, churn
2. Customer list with ACV, contract dates, billing terms, and renewal dates
3. Cohort retention analysis (by quarter of initial sale, 24-month view)
4. P&L with departmental detail (last 3 fiscal years + current YTD)
5. Balance sheet and cash flow statement (last 3 years + current)
6. Revenue by product line / SKU
7. Capitalized vs. expensed R&D breakdown
8. Deferred revenue rollforward (quarterly, last 8 quarters)
9. Sales pipeline and weighted forecast (next 12 months)
10. Cap table and waterfall analysis (to understand payout mechanics)

---

## SUMMARY VERDICT

| Dimension | Preliminary Assessment | Confidence |
|---|---|---|
| Valuation (8x ARR) | **Reasonable if NRR >110% and growth >25%** | Medium — needs data |
| Revenue quality | **Assume risk until decomposition verified** | Low — critical gap |
| Margin profile | **Expect 75% gross, 5%–15% EBITDA** | Medium — standard range |
| Working capital | **Likely favorable (SaaS model)** | Medium-High |
| Debt exposure | **Likely manageable** | Medium |
| Overall risk | **Proceed with diligence; 3–4 items could be deal-breakers** | — |

**Bottom line:** The deal economics are plausible at 8x for a $50M ARR B2B SaaS business, but the multiple is only justified if revenue quality is genuinely high (NRR >110%, gross retention >92%, low concentration). The priority items in Section 6 should be resolved before LOI becomes binding. If churn is >12% gross or customer concentration exceeds 25% in top 5, the appropriate multiple drops to 5x–6x ($250M–$300M), representing $100M–$150M in potential overpayment risk.