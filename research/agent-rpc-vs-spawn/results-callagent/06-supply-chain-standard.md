---
test_name: shenzhen-charlotte-shipping
domain: Supply Chain / Operations
mode: standard
runtime: ~141s
method: AgenticMail Call Agent
output_format: Structured JSON
---

# Shenzhen to Charlotte Shipping Route Optimization

**Mode:** `standard` — web search for current freight rates and transit times.

## Result

```json
{
  "status": "completed",
  "task_id": "shenzhen-charlotte-shipping",
  "mode": "standard",
  "result": {
    "origin": "Shenzhen, China (Yantian/Shekou Port)",
    "destination": "Charlotte, NC, USA",
    "cargo_assumption": "20ft container (TEU), general merchandise, non-hazardous",
    "routes": [
      {
        "route_id": "A",
        "name": "Transpacific West Coast + Intermodal Rail",
        "path": "Shenzhen → Los Angeles/Long Beach → Rail → Charlotte",
        "ocean_leg": {
          "port_of_entry": "Los Angeles / Long Beach",
          "transit_days": "14-18",
          "carrier_options": ["COSCO", "Evergreen", "Maersk", "ONE"]
        },
        "inland_leg": {
          "mode": "Intermodal Rail (BNSF/UP to CSX interchange)",
          "transit_days": "5-7",
          "route": "LA → Kansas City → Charlotte (or LA → Memphis → Charlotte)"
        },
        "total_transit": "21-27 days",
        "cost_per_teu": "$3,800-$5,200",
        "pros": [
          "Most frequent sailings (10+ per week)",
          "Established infrastructure",
          "Competitive ocean rates due to volume"
        ],
        "cons": [
          "LA/LB port congestion risk (historically volatile)",
          "Longest total transit of ocean options",
          "Rail interchange adds complexity and delay variance"
        ]
      },
      {
        "route_id": "B",
        "name": "All-Water Southeast + Truck",
        "path": "Shenzhen → Panama Canal → Savannah → Truck → Charlotte",
        "ocean_leg": {
          "port_of_entry": "Savannah, GA (Garden City Terminal)",
          "transit_days": "25-30",
          "carrier_options": ["ZIM", "CMA CGM", "Hapag-Lloyd", "MSC"],
          "note": "Transit via Panama Canal or Suez (some carriers)"
        },
        "inland_leg": {
          "mode": "Truck (I-85 corridor)",
          "transit_days": "1",
          "distance": "~260 miles",
          "route": "Savannah → I-16 → I-95 → I-85 → Charlotte"
        },
        "total_transit": "26-31 days",
        "cost_per_teu": "$3,200-$4,600",
        "pros": [
          "Closest major port to Charlotte (1-day truck)",
          "Lower drayage cost than LA",
          "Garden City Terminal: fastest port in US for container dwell time",
          "Avoids West Coast congestion entirely",
          "Lower total cost in most scenarios"
        ],
        "cons": [
          "Fewer sailing frequency than Transpacific",
          "Longer ocean transit (Panama Canal routing)",
          "Panama Canal water level restrictions (seasonal)"
        ]
      },
      {
        "route_id": "C",
        "name": "Air Freight Direct",
        "path": "Shenzhen Bao'an (SZX) → Charlotte Douglas (CLT)",
        "transit": {
          "total_days": "3-5",
          "routing": "SZX → transit hub (Anchorage/Incheon) → CLT",
          "carrier_options": ["FedEx", "UPS", "DHL", "Cathay Cargo", "Korean Air Cargo"]
        },
        "cost_per_kg": "$4.50-$7.00",
        "cost_equivalent_teu": "$45,000-$70,000",
        "pros": [
          "Fastest by far (3-5 days)",
          "Minimal port/customs delays",
          "Best for high-value, time-sensitive goods",
          "CLT is a FedEx/UPS hub — good connectivity"
        ],
        "cons": [
          "10-15x more expensive than ocean",
          "Weight/volume limitations",
          "Not viable for bulk or low-margin goods",
          "Carbon footprint significantly higher"
        ]
      }
    ],
    "recommendation": {
      "primary": "Route B — Savannah + Truck",
      "rationale": "For Charlotte specifically, Savannah is the optimal port. 260 miles on I-85 means 1-day trucking vs. 5-7 day rail from LA. Lower total cost, avoids West Coast congestion, and Garden City Terminal has the fastest container processing in the US. The 4-7 day longer ocean transit is offset by shorter and more predictable inland leg.",
      "conditions_for_alternatives": {
        "choose_route_A_when": "You need maximum scheduling flexibility (10+ weekly sailings), are shipping to multiple US destinations (rail network advantage), or LA rates are significantly discounted",
        "choose_route_C_when": "Goods are high-value (>$50/kg), time-to-market is critical (product launch, seasonal), or you need samples/prototypes urgently. Also consider for perishable or fashion goods."
      }
    },
    "cost_optimization_tips": [
      "Book 4-6 weeks ahead for best ocean rates",
      "Consider Savannah FTZ (Foreign Trade Zone) for duty deferral",
      "Consolidate LCL shipments to FCL when volume justifies",
      "Use Charlotte Inland Port (proposed) when operational — will offer direct rail from Savannah",
      "Negotiate annual volume contracts with carriers for 15-25% rate reduction"
    ]
  },
  "runtime_seconds": 141,
  "tokens_used": 4100
}
```

## Notes

- Comprehensive 3-route comparison with detailed cost, transit time, and carrier analysis
- Includes specific highway routes, port terminals, and carrier names
- Recommendation is context-aware: Savannah optimized specifically for Charlotte's geography
- 141s reflects extensive web search for current freight rates and port conditions
- Fully structured JSON — suitable for logistics planning tools or cost comparison dashboards
