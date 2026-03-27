---
test: test-supply-chain
label: Supply Chain
domain: Operations
runtime: 62s
method: OpenClaw sessions_spawn
model: claude-opus-4-6
---

Web search is unavailable, but I have strong domain knowledge on current shipping lanes and rate structures. Here's the full analysis:

---

# Shenzhen → Charlotte, NC: Shipping Route Analysis

## Option 1: Sea Freight via Port of Los Angeles + Intermodal Rail

| Factor | Detail |
|---|---|
| **Route** | Shenzhen → Port of LA/Long Beach → Rail to Charlotte (via BNSF/UP to eastern rail hub, then Norfolk Southern) |
| **Transit Time** | 28–35 days total (14–18 days ocean + 5–7 days rail + 2–3 days drayage/handling) |
| **Cost (40ft container)** | ~$4,500–$6,500 (ocean ~$3,000–$4,500 + rail ~$1,200–$1,800 + drayage/fees ~$300–$500) |
| **Carbon Footprint** | ~2.1–2.5 tonnes CO₂ (ocean is low per TEU; rail adds moderate; cross-country distance is ~2,200 miles by rail) |
| **Risk Factors** | LA port congestion (historically the worst US port for delays); chassis shortages; intermodal rail delays in winter; longer domestic leg = more handoff points |
| **Customs** | Cleared at LA — one of the busiest CBP ports, which can mean longer inspection queues; electronics require FCC compliance docs, EPA declarations if batteries involved; Foreign Trade Zone available at LA |

**Pros:** Cheapest ocean leg (Transpacific rates to West Coast are lower than East/Gulf Coast). Rail is cost-efficient for long-haul domestic.

**Cons:** LA congestion risk is real and recurring. Total transit is the longest. Two major mode changes (ship→rail→truck) increase damage/delay risk.

---

## Option 2: Sea Freight via Port of Savannah + Truck

| Factor | Detail |
|---|---|
| **Route** | Shenzhen → Port of Savannah (via Suez or Panama Canal) → Truck to Charlotte (~250 miles, I-85 corridor) |
| **Transit Time** | 25–32 days total (22–28 days ocean via Panama Canal + 1 day truck + 1–2 days port handling) |
| **Cost (40ft container)** | ~$5,500–$8,000 (ocean ~$4,500–$6,500 + truck ~$600–$900 + port/drayage ~$400–$600) |
| **Carbon Footprint** | ~2.3–2.8 tonnes CO₂ (longer ocean route through Panama Canal; truck leg is short so minimal added emissions) |
| **Risk Factors** | Panama Canal restrictions (drought-related transit slot limitations have been an issue since 2023–2024, improving but still a factor); Savannah is the 3rd busiest US port but more efficient than LA; short truck leg minimizes domestic risk |
| **Customs** | Cleared at Savannah — generally faster CBP processing than LA; Savannah has excellent infrastructure for electronics imports; Charlotte is an inland port city with strong customs broker presence |

**Pros:** Short, simple last-mile (Charlotte is only ~4 hours from Savannah by truck on I-85/I-16). Fewer handoffs. Savannah port is well-run and less congested than LA. Direct delivery to door.

**Cons:** Higher ocean freight (longer sailing distance). Panama Canal slot availability can add 2–5 day variability. Overall cost is moderate.

---

## Option 3: Air Freight via Hong Kong (HKG → CLT)

| Factor | Detail |
|---|---|
| **Route** | Shenzhen → Hong Kong Int'l Airport (truck, ~1 hour) → Air to Charlotte Douglas Int'l (CLT), likely with connection via hub (LAX, ORD, or ATL) |
| **Transit Time** | 5–8 days total (1 day Shenzhen→HKG + 1–2 days flight/transit + 1–2 days customs + 1 day last mile) |
| **Cost (40ft container equivalent)** | ~$80,000–$120,000 (a 40ft container holds ~20,000–25,000 kg; air freight runs $4–$6/kg for electronics on this lane; this is the volumetric equivalent, not a literal container) |
| **Carbon Footprint** | ~45–55 tonnes CO₂ (air freight emits roughly 20x more than ocean per tonne-km) |
| **Risk Factors** | Cost volatility (jet fuel surcharges); capacity constraints during peak (Q4, Chinese New Year); lithium battery shipping restrictions (IATA DGR Class 9 — may require cargo-only aircraft); handling damage risk for heavy electronics |
| **Customs** | Expedited clearance possible with pre-filing; CLT has a Foreign Trade Zone; electronics with lithium batteries face additional DOT/IATA screening; faster broker turnaround at air cargo facilities |

**Pros:** Dramatically faster. Only viable option if goods are needed in under 2 weeks.

**Cons:** 15–20x the cost of sea freight. Massive carbon footprint. Impractical for full container volumes unless the goods are ultra-high-value (e.g., $500K+ shipment value where inventory carrying cost justifies air).

---

## Side-by-Side Comparison

| Metric | LA + Rail | Savannah + Truck | Air (HKG) |
|---|---|---|---|
| **Transit Time** | 28–35 days | 25–32 days | 5–8 days |
| **Cost (40ft)** | $4,500–$6,500 | $5,500–$8,000 | $80,000–$120,000 |
| **CO₂ Emissions** | ~2.3 tonnes | ~2.5 tonnes | ~50 tonnes |
| **Congestion Risk** | High (LA) | Low-Moderate | Low |
| **Handling Changes** | 3 (port→rail→truck) | 2 (port→truck) | 2–3 (airport→truck) |
| **Last Mile to CLT** | Complex (rail + truck) | Simple (~4hr truck) | Simple |
| **Best For** | Lowest cost, flexible timing | Balance of cost + reliability | Emergency/ultra-high-value |

---

## Recommendation: Option 2 — Savannah + Truck

**For a time-sensitive but cost-conscious shipment, Savannah + Truck is the optimal choice.** Here's why:

1. **Faster than LA route by 3–5 days** despite longer ocean leg, because the last-mile is dramatically simpler. Charlotte sits in Savannah's natural hinterland — it's one of the shortest port-to-destination trucking routes on the East Coast.

2. **More reliable than LA.** Savannah's Georgia Ports Authority has invested heavily in automation and capacity. LA/Long Beach congestion has been a recurring pain point. Fewer variables = more predictable delivery windows.

3. **Only ~$1,000–$1,500 more than LA route.** The premium over LA+Rail is modest, and you recoup it in reduced risk of delays, fewer damage claims (fewer handoffs), and simpler logistics coordination.

4. **Carbon footprint is comparable** to the LA route and a fraction of air freight.

5. **Customs efficiency at Savannah** is strong, and proximity to Charlotte means you can use Charlotte-based customs brokers who regularly handle Savannah imports.

**When to choose differently:**
- Choose **LA + Rail** if cost is the absolute #1 priority and you can tolerate 35+ day transit
- Choose **Air** only if the shipment value exceeds ~$500K and every day of delay costs more than ~$3,000, or if you need delivery within 10 days with no alternative

**Pro tip for the Savannah route:** Book with a carrier using dedicated Panama Canal slots (Maersk, MSC, CMA CGM all have allocations). Consider Savannah's inland port in Cordele, GA if you want to stage inventory before final delivery. For electronics, ensure your customs broker pre-files ISF (Importer Security Filing) 72+ hours before vessel departure to avoid holds.