---
test: test-collab-clinical-stats
label: Clinical Stats
domain: Healthcare (Clinical)
runtime: 88s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---

# Statistical Analysis Plan: Phase III Oral GLP-1 Receptor Agonist for Type 2 Diabetes

## 1. Sample Size Justification & Power Calculations

### Assumptions
| Parameter | Value | Rationale |
|---|---|---|
| Primary endpoint | Change from baseline in HbA1c (%) at Week 52 | Standard for T2D trials |
| Clinically meaningful difference (δ) | −0.4% (treatment vs placebo) | FDA/EMA consensus for GLP-1 class |
| Common SD (σ) | 1.1% | Based on PIONEER program meta-analysis |
| Significance level (α) | 0.025 (one-sided) / 0.05 (two-sided) | Regulatory standard |
| Target power | 90% | Conservative for Phase III pivotal |
| Allocation ratio | 1:1 | 1,000 per arm |

### Calculation (two-sample t-test framework)

**Per-group sample size:**

n = 2 × (Z_{α/2} + Z_β)² × σ² / δ²
n = 2 × (1.96 + 1.282)² × (1.1)² / (0.4)²
n = 2 × 10.507 × 1.21 / 0.16
n ≈ 159 per group (bare minimum)

**Adjustments inflating to N = 2,000 (1,000/arm):**

- **Dropout/missing data inflation:** Anticipated 20% attrition over 52 weeks → multiply by 1.25
- **Interim analysis penalty:** O'Brien-Fleming α-spending consumes minimal alpha early, but conservatively inflate by ~2%
- **Covariate adjustment efficiency gain:** ANCOVA with baseline HbA1c reduces variance ~15–25%, partially offsetting inflation
- **Subgroup analyses and regulatory conservatism:** Overpowering ensures robust results across key subgroups (baseline HbA1c strata, BMI categories, renal function)

**Achieved power with N = 2,000:**

With 800 completers per arm (20% attrition), ANCOVA-adjusted SD ≈ 0.9%, the achieved power for δ = −0.4% exceeds **99%**. This provides:
- **>90% power** to detect δ = −0.25% (smaller but clinically relevant difference)
- **>80% power** for key secondary endpoints (weight loss)
- Robust power for pre-specified subgroup analyses (sex, race, baseline HbA1c ≤8% vs >8%, eGFR strata)

**Conclusion:** N = 2,000 is well-justified — not for the primary endpoint alone, but to ensure adequate power for secondary endpoints, subgroup consistency, and regulatory robustness.

---

## 2. Primary Analysis Method

### Recommendation: MMRM (Mixed Model for Repeated Measures)

**Selected model specification:**

```
Y_ij = μ + β₁(Baseline HbA1c_i) + β₂(Treatment_i) + β₃(Visit_j) 
       + β₄(Treatment_i × Visit_j) + β₅(Stratification factors) + ε_ij
```

**Where:**
- Y_ij = HbA1c at visit j for patient i
- Visits: Weeks 4, 8, 12, 26, 38, 52
- Unstructured covariance matrix for within-patient errors
- Kenward-Roger degrees of freedom
- Primary contrast: Treatment × Visit interaction at Week 52

### Why MMRM over alternatives

| Method | Pros | Cons | Verdict |
|---|---|---|---|
| **MMRM** | Uses all longitudinal data; implicit MAR assumption; no imputation needed; regulatory gold standard for T2D | Assumes MAR; unstructured covariance can be unstable with many timepoints | **Selected** |
| **ANCOVA (Week 52 only)** | Simple, well-understood | Discards intermediate data; requires explicit imputation for missing Week 52; less efficient | Supportive/sensitivity only |
| **Random coefficient models** | Flexible trajectory modeling | Stronger structural assumptions; less standard for regulatory submissions | Not recommended as primary |

### Key MMRM specifications:
- **Fixed effects:** Treatment, Visit, Treatment×Visit, Baseline HbA1c (continuous), Stratification factors (region, baseline HbA1c category, background medication)
- **Covariance structure:** Unstructured (primary); Toeplitz and AR(1) as sensitivity
- **Degrees of freedom:** Kenward-Roger (handles small-sample bias)
- **Estimand alignment:** Treatment policy estimand — includes data regardless of rescue medication or treatment discontinuation (see Section 4)
- **Software:** SAS PROC MIXED or R lme4/mmrm package

### Sensitivity analyses (pre-specified):
1. ANCOVA at Week 52 with MI under MAR
2. ANCOVA at Week 52 with LOCF (for historical comparability only)
3. Tipping point analysis (MNAR)
4. Per-protocol population MMRM
5. Pattern-mixture model

---

## 3. Multiplicity Adjustment Strategy

### Endpoint hierarchy (fixed-sequence gatekeeping)

The secondary endpoints are tested in a **pre-specified fixed-sequence (hierarchical) procedure**, which strongly controls the familywise Type I error rate at α = 0.05 (two-sided).

```
Step 1: PRIMARY ENDPOINT
  HbA1c change from baseline at Week 52
  ↓ (if p < 0.05, proceed)

Step 2: KEY SECONDARY — Weight Loss
  Body weight change from baseline at Week 52 (kg)
  ↓ (if p < 0.05, proceed)

Step 3: KEY SECONDARY — HbA1c Responder
  Proportion achieving HbA1c < 7.0% at Week 52
  ↓ (if p < 0.05, proceed)

Step 4: KEY SECONDARY — Composite Cardiometabolic
  Combined endpoint: ≥0.5% HbA1c reduction + ≥5% weight loss
  ↓ (if p < 0.05, proceed)

Step 5: SECONDARY — Patient-Reported Outcomes
  DTSQ (Diabetes Treatment Satisfaction Questionnaire) change
  ↓ (if p < 0.05, proceed)

Step 6: SECONDARY — Fasting Plasma Glucose
  FPG change from baseline at Week 52
```

### Rationale for ordering:
1. **Weight loss** placed first among secondaries — highest clinical and commercial value for oral GLP-1; expected large effect size (3–5 kg)
2. **HbA1c responder** — binary version of primary; clinically interpretable
3. **Composite cardiometabolic** — differentiator vs DPP-4 and SGLT-2 class
4. **PROs** — supports labeling claims but lower regulatory weight
5. **FPG** — mechanistically expected, lowest risk of failure

### Additional multiplicity considerations:
- **Cardiovascular events (MACE):** NOT in the formal testing hierarchy. With 2,000 patients and 52 weeks, the trial is underpowered for MACE. CV events are analyzed descriptively with Kaplan-Meier estimates and Cox regression. A dedicated CVOT may be required post-approval.
- **Subgroup analyses:** Treated as exploratory with interaction p-values reported without multiplicity adjustment. Forest plots for primary endpoint across pre-specified subgroups.
- **Graphical approach (Bretz et al.):** If regulatory feedback suggests a non-hierarchical structure, a graphical multiplicity procedure (weighted Bonferroni with α-propagation) is the fallback.

---

## 4. Missing Data Handling (ICH E9(R1) Estimand Framework)

### Primary Estimand Definition

| Attribute | Specification |
|---|---|
| **Population** | Adults with T2D, baseline HbA1c 7.0–10.5%, on stable metformin |
| **Treatment** | Oral GLP-1 RA vs placebo, both + metformin |
| **Endpoint** | Change from baseline in HbA1c at Week 52 |
| **Intercurrent events** | See below |
| **Summary measure** | Difference in means (treatment − placebo) |

### Intercurrent Event (IE) Handling Strategies

| Intercurrent Event | Strategy | Rationale |
|---|---|---|
| **Rescue medication initiation** | Treatment policy | Data collected regardless; reflects real-world effectiveness. Aligns with FDA preference. |
| **Treatment discontinuation (non-death)** | Treatment policy (primary); Hypothetical (sensitivity) | Primary: use all data post-discontinuation. Sensitivity: estimate effect if all had continued. |
| **Death** | Composite variable | Death precludes HbA1c; handled as worst outcome in composite or excluded with appropriate analysis. |
| **COVID-related disruption** | Treatment policy | Collect data by all means; sensitivity excludes affected visits |

### Missing Data Mechanism Assumptions

**Primary analysis (MMRM):** Assumes **MAR** (Missing At Random) — missingness depends on observed data (baseline characteristics, prior HbA1c values) but not unobserved future values. MMRM is likelihood-based and valid under MAR without explicit imputation.

### Sensitivity Analyses for Missing Data (mandatory per ICH E9 R1)

| Analysis | Assumption | Method |
|---|---|---|
| **Tipping point analysis** | MNAR — progressively worse outcomes for missing treatment arm data | Shift δ in imputed values for treatment arm from 0 to +1.0% in 0.1% increments; identify δ at which significance is lost |
| **Reference-based MI (jump to reference)** | MNAR — patients who discontinue treatment revert to placebo trajectory | Multiple imputation using placebo arm parameters for missing treatment data |
| **Copy increments in reference (CIR)** | MNAR — post-discontinuation trajectory parallels placebo | MI variant; less conservative than jump-to-reference |
| **Delta-adjusted MI** | MNAR — parametric sensitivity | Add clinically plausible penalty (δ = +0.2%, +0.5%) to imputed treatment values |
| **Complete case analysis** | MCAR | ANCOVA on completers only |
| **Pattern-mixture model** | MNAR — different patterns | Group by discontinuation pattern; combine estimates |

### Data Collection Requirements
- **Critical:** Continue to collect HbA1c at all scheduled visits even after treatment discontinuation (treatment policy estimand requires this)
- All efforts to obtain Week 52 assessment regardless of treatment status
- Minimum: Baseline + at least one post-baseline value for MMRM inclusion
- Document reason for every missing value (CRF-level tracking)

---

## 5. Interim Analysis Plan with Alpha Spending

### Design: Single Interim Analysis with O'Brien-Fleming Alpha Spending

| Parameter | Specification |
|---|---|
| **Number of interim analyses** | 1 |
| **Timing** | ~50% information fraction (approximately 1,000 patients completing Week 26, or 500 completing Week 52) |
| **Alpha-spending function** | Lan-DeMets approximation to O'Brien-Fleming |
| **Overall α** | 0.05 (two-sided) |

### Alpha Allocation

| Analysis | Information Fraction | Cumulative α Spent | Boundary (Z-score) | Nominal p-value |
|---|---|---|---|---|
| **Interim (IA1)** | 0.50 | 0.0054 | 2.797 | 0.0026 |
| **Final** | 1.00 | 0.0500 | 2.012 | 0.0222 |

### Interim Analysis Purposes

1. **Efficacy:** Early stopping for overwhelming efficacy if Z > 2.797 (p < 0.0026). This preserves almost all alpha for the final analysis.
2. **Futility:** Non-binding futility boundary using conditional power. If conditional power < 10% (given observed interim effect), DSMB may recommend stopping for futility. Non-binding = does not consume alpha.
3. **Safety:** Comprehensive safety review (hepatotoxicity, pancreatitis, GI events, thyroid signals — class-specific GLP-1 concerns). No formal alpha penalty for safety monitoring.

### DSMB Charter Provisions
- **Independent statistician** prepares unblinded interim report; trial team remains blinded
- DSMB membership: ≥2 clinicians (endocrinologist + cardiologist), 1 biostatistician, 1 ethicist
- Recommendations: Continue, Modify, Stop for efficacy, Stop for futility, Stop for safety
- **Adaptive sample size re-estimation** NOT included (fixed design) — simplifies regulatory review
- Unblinding limited to DSMB statistician; operational team sees only recommendation

### Operational Considerations
- Calendar time for interim: approximately Month 18 of enrollment (assuming 12-month enrollment period + 6 months follow-up for first 50%)
- Database lock for interim: separate locked dataset; final analysis uses full dataset
- Conditional power computed under both observed effect and original δ = −0.4%

---

## Summary of Key Statistical Decisions

| Decision | Choice | Regulatory Alignment |
|---|---|---|
| Primary analysis | MMRM with unstructured covariance | FDA/EMA preferred for longitudinal T2D data |
| Primary estimand | Treatment policy for rescue med + discontinuation | ICH E9(R1) compliant |
| Multiplicity | Fixed-sequence hierarchical testing | Strong FWER control; FDA accepted |
| Missing data (primary) | MAR via MMRM (implicit) | Standard; supplemented by MNAR sensitivity |
| Missing data (sensitivity) | Tipping point + reference-based MI + delta-adjusted | ICH E9(R1) required sensitivity |
| Interim analysis | 1 interim at 50% IF, O'Brien-Fleming spending | Conservative; preserves final α ≈ 0.048 |
| Sample size | N = 2,000 (1,000/arm) | Overpowered for primary; adequate for secondaries and subgroups |
| CV events | Descriptive only (underpowered for MACE) | Separate CVOT likely required |

---

## Recommendations for Clinical/Regulatory Agent

1. **FDA Type B meeting** should confirm the estimand framework and treatment policy strategy before database lock
2. **Rescue medication protocol** needs precise definition (threshold HbA1c for rescue, permitted agents) — this directly affects the treatment policy estimand
3. **CVOT commitment** should be discussed at pre-NDA meeting; 52-week data with 2,000 patients is insufficient for CV safety per FDA 2008 guidance
4. **PRO instruments** (DTSQ, EQ-5D-5L) should be validated in the target population; labeling claims require FDA PRO guidance alignment
5. **Subgroup consistency** analyses should be powered for baseline HbA1c ≤8% vs >8% and BMI ≤30 vs >30 — these drive prescribing decisions
6. **Hepatic/renal impairment** subgroups need dedicated PK/PD studies; the Phase III SAP should pre-specify eGFR-stratified analyses