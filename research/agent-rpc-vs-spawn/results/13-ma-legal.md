---
test: test-collab-MA-legal
label: M&A Legal
domain: Legal (M&A)
runtime: 90s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---

# Legal Due Diligence Report: TechCorp Acquisition by MegaCorp

**Deal:** MegaCorp acquiring TechCorp for $400M (8x ARR on $50M)
**Date:** March 27, 2026
**Agent:** Legal Analysis
**Classification:** Confidential — Draft Working Document

---

## 1. INTELLECTUAL PROPERTY OWNERSHIP

### 1.1 Patents & Trademarks

| Finding | Risk | Detail |
|---|---|---|
| Patent assignment chain gaps | **High** | B2B SaaS companies at $50M ARR typically have 5-20 patents. Must verify each has a clean chain of title from inventor → company. Any patent filed by a founder pre-incorporation or during a prior employment could be clouded. Require full patent schedule with assignment confirmations. |
| Trademark registration status | **Medium** | Verify "TechCorp" and all product names are registered (not just common-law) in key jurisdictions. Unregistered marks weaken post-acquisition brand enforcement. Check for any pending opposition proceedings. |
| Prior employer IP claims | **High** | If founders or early engineers came from competitors, prior employers may have broad IP assignment clauses. Request founder employment history and prior employer IP agreements for the first 3 years of TechCorp's existence. |

### 1.2 Source Code Ownership

| Finding | Risk | Detail |
|---|---|---|
| Contractor IP assignment gaps | **Critical** | SaaS companies at this stage routinely used contractors in early development. Every contractor must have signed a work-for-hire or IP assignment agreement. Missing assignments = TechCorp may not own portions of its core codebase. Require a complete contractor schedule with signed IP assignment agreements. |
| Employee invention assignment | **High** | Verify all employees signed CIIAs (Confidential Information and Invention Assignments). California employees require special handling — CA Labor Code §2870 limits invention assignment scope. Any CA-based engineers without compliant CIIAs are a gap. |
| Open-source license contamination | **Critical** | Conduct a full Software Composition Analysis (SCA) scan. Key risks: **GPL/AGPL** — any GPL code linked into proprietary modules could create copyleft obligations forcing source code disclosure. **AGPL** — even network interaction (SaaS delivery) triggers disclosure obligations. At 8x revenue multiple, the entire valuation rests on proprietary code. A single AGPL dependency in the core platform could be deal-breaking. Also flag SSPL (MongoDB), Commons Clause, and BSL components. |
| Open-source contribution policy | **Medium** | Has TechCorp contributed code to open-source projects? If employees contributed proprietary code upstream, that IP may be irrecoverably licensed. Review contribution policy and git commit history to external repos. |

**Recommended Action:** Engage a third-party code audit firm (e.g., Black Duck/Synopsys) for a full SCA scan before closing. This is non-negotiable at this valuation.

---

## 2. CUSTOMER CONTRACT RISKS

### 2.1 Change-of-Control Provisions

| Finding | Risk | Detail |
|---|---|---|
| Change-of-control termination rights | **Critical** | At $50M ARR, TechCorp likely has 5-15 enterprise customers representing 30-50% of ARR. If any top-10 customer contracts include change-of-control (CoC) termination or consent provisions, MegaCorp could lose material revenue post-close. Request a schedule of all contracts with CoC clauses, cross-referenced with ARR concentration. If >15% of ARR is subject to CoC termination, consider an escrow or earnout structure. |
| Customer notification requirements | **Medium** | Some contracts may require advance notice of ownership change even without termination rights. Failure to notify could constitute breach. |

### 2.2 Material Termination Clauses

| Finding | Risk | Detail |
|---|---|---|
| Convenience termination rights | **High** | B2B SaaS contracts sometimes allow termination for convenience with 30-90 day notice. Quantify ARR exposed to convenience termination. If TechCorp shifted to annual prepaid contracts, risk is lower but still present at renewal. |
| SLA-triggered termination | **Medium** | Review SLA terms. Repeated SLA breaches often accumulate into termination rights. Check historical SLA performance and any outstanding credits or disputes. |

### 2.3 MFN and Pricing Clauses

| Finding | Risk | Detail |
|---|---|---|
| Most Favored Nation (MFN) clauses | **High** | If early enterprise customers negotiated MFN pricing, MegaCorp's existing customer pricing or future pricing strategies could trigger MFN adjustments, compressing margins. Quantify the financial exposure. |
| Price lock / escalation caps | **Medium** | Long-term contracts with capped annual increases (e.g., CPI-only) limit pricing power post-acquisition. Review top-20 contracts for pricing flexibility. |
| Auto-renewal terms | **Low** | Verify auto-renewal mechanics. Favorable for buyer if multi-year with auto-renew; unfavorable if customers can opt out at each anniversary. |

---

## 3. REGULATORY COMPLIANCE

### 3.1 Data Privacy

| Finding | Risk | Detail |
|---|---|---|
| GDPR compliance posture | **High** | As a B2B SaaS, TechCorp is almost certainly a data processor for EU customers. Verify: (a) Data Processing Agreements (DPAs) with all EU customers, (b) Art. 30 Records of Processing, (c) Data Protection Impact Assessments for high-risk processing, (d) EU representative appointed (Art. 27) if no EU establishment, (e) Cross-border transfer mechanisms (SCCs, adequacy decisions). Post-Schrems II, any reliance on invalidated frameworks is a gap. Non-compliance fines up to 4% of global turnover. |
| CCPA/CPRA compliance | **High** | If TechCorp processes personal information of California residents (likely given B2B SaaS), verify service provider agreements, opt-out mechanisms, and data inventory. CPRA's expanded requirements (effective 2023) add obligations around sensitive data and automated decision-making. |
| SOC 2 certification | **Medium** | Verify current SOC 2 Type II report. Check for any qualified opinions or noted exceptions. Lapsed or Type I-only certification is a yellow flag for enterprise customers and could trigger contract issues. |
| Data breach history | **High** | Request full incident log. Any unreported breaches are a ticking liability. Review cyber insurance coverage and limits. |

### 3.2 Pending Litigation

| Finding | Risk | Detail |
|---|---|---|
| Active lawsuits / threatened claims | **High** | Request a full litigation schedule including: active suits, pre-litigation demands, regulatory inquiries, IP infringement claims (both offensive and defensive). At $400M, even a single material patent troll suit could affect valuation. |
| Product liability / negligence | **Medium** | If TechCorp's software is used in regulated industries (financial services, healthcare), errors-and-omissions exposure could be significant. Review E&O insurance and indemnification obligations. |

### 3.3 Government Contracts

| Finding | Risk | Detail |
|---|---|---|
| FedRAMP / ITAR / government contract implications | **Medium** | If TechCorp has government customers, verify: (a) FedRAMP authorization status, (b) ITAR/EAR classification of software, (c) CFIUS implications if MegaCorp has foreign ownership. Government contracts often have assignment restrictions and additional CoC provisions. |
| Novation requirements | **Medium** | Government contracts typically require novation (formal consent) for assignment. This can delay integration. |

---

## 4. EMPLOYMENT & KEY PERSONNEL

### 4.1 Key Person Provisions

| Finding | Risk | Detail |
|---|---|---|
| Founder/C-suite retention | **Critical** | At a B2B SaaS company with $50M ARR, the CTO and VP Engineering are likely critical to product continuity. If key executives have no post-closing employment agreements or retention packages, there's a risk of immediate departure. Recommend retention bonuses or earnout structures tied to 18-24 month stay. |
| Key person dependencies in customer relationships | **High** | Enterprise SaaS deals often depend on personal relationships. If the CEO or VP Sales personally manages top accounts, their departure could accelerate customer churn post-acquisition. |

### 4.2 Non-Compete Enforceability

| Finding | Risk | Detail |
|---|---|---|
| FTC non-compete ban status | **Critical** | The FTC's non-compete rule (if in effect) broadly bans non-competes for most workers. Verify current legal status — enforcement has been subject to litigation. If non-competes are unenforceable, departing employees can immediately compete. This materially increases key-person risk. |
| State-by-state enforceability | **High** | California: non-competes are void (Bus. & Prof. Code §16600). Colorado, Minnesota, Oklahoma: heavily restricted. If key employees are in these states, non-competes provide zero protection. Map employee locations against enforceability. |
| Non-solicitation as fallback | **Medium** | Non-solicitation of customers and employees is generally more enforceable than non-competes. Verify these are in place as a backstop. |

### 4.3 Equity Treatment on Acquisition

| Finding | Risk | Detail |
|---|---|---|
| Unvested equity acceleration | **High** | Review all option/RSU agreements for single-trigger vs. double-trigger acceleration. Single-trigger acceleration on closing could create a large immediate tax and cash obligation. Double-trigger (closing + termination) is buyer-friendly. Quantify the fully-diluted share count under each scenario. |
| Option pool refresh / 409A valuation | **Medium** | Verify the current 409A valuation and that all options were granted at or above FMV. Below-FMV grants create Section 409A penalties for employees and potential company liability. |
| Employee equity communication | **Low** | Plan for clear communication to employees about what the acquisition means for their equity. Ambiguity creates retention risk. |

---

## 5. CORPORATE STRUCTURE & CAP TABLE

### 5.1 Cap Table Cleanliness

| Finding | Risk | Detail |
|---|---|---|
| Cap table accuracy | **High** | At $50M ARR, TechCorp likely raised Series A through C/D. Verify the cap table against: (a) all stock certificates / Carta records, (b) board minutes authorizing each issuance, (c) state filings (certificates of incorporation, amendments). Any discrepancies between the cap table and legal records must be reconciled before closing. |
| 83(b) election compliance | **Medium** | If founders received restricted stock, verify timely 83(b) elections were filed. Missing 83(b)s create tax issues for founders that could complicate closing (disgruntled founders demanding tax gross-ups). |

### 5.2 Convertible Instruments

| Finding | Risk | Detail |
|---|---|---|
| Outstanding SAFEs / convertible notes | **High** | Any unconverted SAFEs or notes must convert or be addressed at closing. Verify: (a) conversion terms and caps, (b) whether the acquisition triggers conversion, (c) the fully-diluted impact. Surprise dilution from forgotten angel SAFEs can materially affect per-share acquisition price. |
| Warrant obligations | **Medium** | Venture lenders (SVB, WTI, etc.) often receive warrants. Verify all outstanding warrants, exercise prices, and expiration dates. These affect the waterfall analysis. |

### 5.3 Preference Stack & Waterfall

| Finding | Risk | Detail |
|---|---|---|
| Liquidation preference analysis | **Critical** | At $400M, the preference stack matters. If TechCorp raised $100-150M+ in total funding with participating preferred, the common stockholders (including key employees) may receive less than expected. A compressed common payout reduces retention incentive. Model the full waterfall: (a) senior preferences, (b) participation rights, (c) conversion to common analysis. Verify no investor has a >1x liquidation preference (2x or 3x preferences from down rounds could be lurking). |
| Anti-dilution ratchets | **Medium** | If any round was a down round, full-ratchet anti-dilution adjustments may have distorted the cap table. Verify all anti-dilution calculations were correctly applied. |
| Drag-along / tag-along rights | **High** | Verify drag-along provisions allow the acquisition to proceed with the required shareholder approval threshold. If minority investors can block or tag along on different terms, this complicates closing mechanics. |
| Right of first refusal / co-sale | **Low** | Verify ROFR and co-sale rights are either waived or satisfied as part of the acquisition. Standard but must be documented. |

---

## SUMMARY: TOP RISKS BY SEVERITY

### Critical (Deal Blockers or Material Value Impact)

1. **Contractor IP assignment gaps** — Missing assignments could mean TechCorp doesn't fully own its codebase
2. **Open-source (GPL/AGPL) contamination** — Could force disclosure of proprietary source code or require costly remediation
3. **Change-of-control termination clauses** — Could trigger loss of material ARR post-closing
4. **Key person retention** — Departure of critical executives could erode product and customer relationships
5. **FTC non-compete landscape** — May be unable to prevent key employees from competing
6. **Liquidation preference stack** — Could compress common payouts and undermine employee retention

### High (Significant but Manageable with Diligence)

7. Patent assignment chain verification
8. Prior employer IP claims against founders
9. Employee CIIA coverage gaps (especially California)
10. MFN clause financial exposure
11. GDPR/CCPA compliance posture and breach history
12. Pending litigation
13. Unvested equity acceleration terms
14. Cap table reconciliation
15. Outstanding convertible instruments
16. Drag-along sufficiency for closing

### Medium

17. Trademark registration completeness
18. Open-source contribution policy
19. SLA-triggered termination exposure
20. SOC 2 certification currency
21. Government contract novation
22. Non-solicitation enforceability
23. 409A compliance / 83(b) elections
24. Warrant obligations
25. Anti-dilution ratchet calculations

### Low

26. Auto-renewal mechanics
27. Employee equity communication planning
28. ROFR/co-sale waiver documentation

---

## RECOMMENDED IMMEDIATE ACTIONS

1. **Engage code audit firm** for full SCA scan (open-source license analysis) — timeline: 2-3 weeks
2. **Request complete contractor schedule** with all IP assignment agreements from TechCorp counsel
3. **Map top-20 customer contracts** for CoC, MFN, and convenience termination provisions; quantify ARR at risk
4. **Model full waterfall** with all preferences, participation, and conversion scenarios at $400M
5. **Draft retention packages** for CTO, VP Engineering, and top 5 identified key persons
6. **Request full litigation schedule** and insurance coverage summary
7. **Obtain latest SOC 2 Type II report** and data breach incident log
8. **Verify cap table** against Carta/legal records and reconcile any discrepancies

---

*This legal diligence report is designed to integrate with parallel financial analysis (revenue quality, churn, unit economics) and operational diligence (product, technology, team) from companion agents. Risk ratings are calibrated for a $400M acquisition at 8x ARR where IP and customer retention are the primary value drivers.*