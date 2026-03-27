---
test_name: weather-charlotte-nc
domain: Weather / Data Retrieval
mode: light
runtime: ~18s
method: AgenticMail Call Agent
output_format: Structured JSON
---

# Weather for Charlotte, NC

**Mode:** `light` — minimal overhead, no email infrastructure, ideal for data retrieval.

## Result

```json
{
  "status": "completed",
  "task_id": "weather-charlotte-nc",
  "mode": "light",
  "result": {
    "location": "Charlotte, NC",
    "current_conditions": {
      "temperature": "85°F",
      "condition": "Sunny",
      "humidity": "35%",
      "wind": {
        "speed": "9 mph",
        "direction": "WSW"
      },
      "feels_like": "83°F",
      "uv_index": 7,
      "visibility": "10 mi"
    },
    "forecast_today": {
      "high": "87°F",
      "low": "62°F",
      "precipitation_chance": "0%"
    },
    "source": "weather data via web lookup",
    "timestamp": "2026-03-27T15:30:00-04:00"
  },
  "runtime_seconds": 18,
  "tokens_used": 340
}
```

## Notes

- Call Agent in `light` mode skips full agent initialization (no email, no memory, no workspace context)
- Returns structured JSON directly to the orchestrator
- The orchestrator retains full control over how to present results to the user
- 18s includes agent spawn + web lookup + JSON serialization
