---
test_name: ma-financial-due-diligence
domain: Finance (M&A)
mode: full
runtime: ~58s
method: AgenticMail Call Agent
output_format: Structured JSON
---

# M&A Financial Due Diligence — TechCorp Acquisition

**Mode:** `full` — all coordination features, email between agents, multi-agent capable.

## Result

```json
{
  "status": "completed",
  "task_id": "ma-financial-due-diligence",
  "mode": "full",
  "result": {
    "target": "TechCorp (B2B SaaS)",
    "acquirer": "MegaCorp",
    "deal_size": "$400M",
    "valuation_assessment": {
      "asking_multiple": "10x ARR",
      "fair_value_range": "7.5x-9.5x ARR based on comps",
      "implied_arr": "$40M",
      "verdict": "Premium to fair value — justified only if NRR >110% and growth re-accelerates above 30%",
      "comparable_multiples": {
        "high_growth_saas_median": "8.5x ARR",
        "category_leader_premium": "+1-2x",
        "decelerating_growth_discount": "-1-1.5x"
      },
      "recommendation": "Negotiate to 8-8.5x ($320-340M) with earnout for delta"
    },
    "revenue_quality": {
      "arr": "$40M",
      "arr_growth_yoy": "28% (decelerating from 45% prior year)",
      "revenue_composition": {
        "recurring_subscription": "88%",
        "professional_services": "8%",
        "usage_based": "4%"
      },
      "customer_concentration": {
        "top_1_customer": "18% of ARR",
        "top_5_customers": "42% of ARR",
        "top_10_customers": "58% of ARR",
        "risk_level": "HIGH — top customer >15% threshold"
      },
      "churn_metrics": {
        "gross_dollar_churn": "12% annually",
        "logo_churn": "15% annually",
        "net_revenue_retention": "108%",
        "assessment": "NRR below 110% SaaS best-in-class; expansion not fully offsetting churn"
      },
      "cohort_analysis": "2024 cohorts showing faster time-to-value but lower initial ACV — land-and-expand working but at smaller deal sizes"
    },
    "margin_profile": {
      "gross_margin": "72%",
      "gross_margin_trend": "Improving (68% → 72% over 2 years)",
      "operating_margin": "-8%",
      "burn_rate": "$3.2M/month",
      "path_to_profitability": "18-24 months at current trajectory",
      "rule_of_40": "20 (28% growth + (-8%) margin) — below threshold",
      "saas_benchmarks": {
        "gross_margin_median": "75%",
        "assessment": "Slightly below median — professional services drag"
      }
    },
    "red_flags": [
      {
        "id": 1,
        "flag": "Customer Concentration",
        "severity": "HIGH",
        "detail": "Top customer at 18% of ARR. Loss would materially impact growth metrics.",
        "mitigation": "Key customer interview + retention analysis + escrow/earnout tied to retention"
      },
      {
        "id": 2,
        "flag": "Growth Deceleration",
        "severity": "HIGH",
        "detail": "YoY growth dropped from 45% to 28%. Need to determine if market saturation or execution issue.",
        "mitigation": "TAM analysis + sales pipeline review + win/loss analysis"
      },
      {
        "id": 3,
        "flag": "Gross Dollar Churn",
        "severity": "MEDIUM-HIGH",
        "detail": "12% annual churn is above SaaS median (~8-10%). Indicates product-market fit issues or competitive pressure.",
        "mitigation": "Exit interview analysis + competitor feature comparison + product roadmap assessment"
      },
      {
        "id": 4,
        "flag": "Negative Operating Margin",
        "severity": "MEDIUM",
        "detail": "Still burning $3.2M/month. Path to profitability depends on growth assumptions that may not hold.",
        "mitigation": "Detailed cost-reduction plan + integration synergy modeling"
      },
      {
        "id": 5,
        "flag": "Professional Services Revenue Mix",
        "severity": "MEDIUM",
        "detail": "8% PS revenue drags gross margins and is not recurring. May indicate product complexity.",
        "mitigation": "Assess PS-to-product conversion roadmap + customer self-serve capabilities"
      },
      {
        "id": 6,
        "flag": "Rule of 40 Below Threshold",
        "severity": "MEDIUM",
        "detail": "Score of 20 is well below the 40 benchmark. Not compensating for losses with growth.",
        "mitigation": "Model post-acquisition synergies — can MegaCorp push this above 40?"
      },
      {
        "id": 7,
        "flag": "NRR Below 110%",
        "severity": "MEDIUM",
        "detail": "108% NRR means expansion barely exceeds contraction. Best-in-class B2B SaaS targets 120%+.",
        "mitigation": "Pricing/packaging audit + expansion motion analysis"
      },
      {
        "id": 8,
        "flag": "Cohort ACV Decline",
        "severity": "LOW-MEDIUM",
        "detail": "Newer cohorts landing at lower ACVs. Could indicate market-down pressure or deliberate SMB pivot.",
        "mitigation": "Clarify GTM strategy — intentional vs. drift"
      }
    ],
    "email_coordination": {
      "email_sent_to_writer": true,
      "recipient_agent": "writer",
      "email_subject": "M&A Due Diligence Summary — TechCorp Acquisition",
      "email_purpose": "Sent executive summary to writer agent for formatting into board-ready presentation",
      "coordination_note": "Full mode enabled inter-agent email. Finance agent autonomously identified that results should be shared with writer agent for deliverable preparation."
    },
    "deal_recommendation": {
      "verdict": "PROCEED WITH CAUTION",
      "conditions": [
        "Negotiate price to 8-8.5x ARR ($320-340M)",
        "Structure with 20% earnout tied to 12-month revenue retention >90%",
        "Secure top-customer contract extensions before close",
        "Complete competitive landscape analysis",
        "Validate path to profitability with detailed integration plan"
      ]
    }
  },
  "runtime_seconds": 58,
  "tokens_used": 5200
}
```

## Notes

- **Full mode** enabled inter-agent email coordination — the finance agent emailed the writer agent
- This demonstrates Call Agent's ability to facilitate agent-to-agent collaboration within the AgenticMail ecosystem
- 8 red flags identified with severity ratings and specific mitigation strategies
- Comprehensive valuation analysis with comparable multiples and negotiation guidance
- All structured JSON — even the most complex analysis domain returns machine-parseable output
- 58s runtime includes email send to writer agent
