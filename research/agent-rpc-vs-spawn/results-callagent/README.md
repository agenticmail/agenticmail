# AgenticMail Call Agent — Test Results

Results from 9 call_agent tests across 3 execution modes: **light**, **standard**, and **full**.

All tests used **claude-opus-4-6** via AgenticMail's `call_agent` function. Every result is **structured JSON**.

| # | File | Domain | Mode | Runtime | Description |
|---|------|--------|------|---------|-------------|
| 01 | [01-weather-light.md](./01-weather-light.md) | Weather | light | ~18s | Charlotte NC weather — baseline data retrieval |
| 02 | [02-code-review-standard.md](./02-code-review-standard.md) | Software Engineering | standard | ~100s | Python security code review — 9 issues + corrected code |
| 03 | [03-finance-aapl-standard.md](./03-finance-aapl-standard.md) | Finance | standard | ~130s | AAPL stock analysis — fundamentals, bull/bear, recommendation |
| 04 | [04-healthcare-drugs-standard.md](./04-healthcare-drugs-standard.md) | Healthcare | standard | ~96s | Drug interaction analysis — 3 drug pairs + FDA alerts |
| 05 | [05-marketing-campaign-standard.md](./05-marketing-campaign-standard.md) | Marketing | standard | ~48s | Gen Z budgeting app launch — persona, channels, CAC projections |
| 06 | [06-supply-chain-standard.md](./06-supply-chain-standard.md) | Supply Chain | standard | ~141s | Shenzhen→Charlotte routes — 3 routes compared, cost analysis |
| 07 | [07-data-science-standard.md](./07-data-science-standard.md) | Data Science | standard (async) | ~53s | Sales forecasting models — 4 models + implementation plan |
| 08 | [08-education-ml-standard.md](./08-education-ml-standard.md) | Education | standard (async) | ~93s | 4-week ML curriculum — 60 hours, projects, assessments |
| 09 | [09-ma-finance-full.md](./09-ma-finance-full.md) | Finance (M&A) | full | ~58s | M&A due diligence — 8 red flags + email to writer agent |

## Key Findings

- **All modes produce structured JSON** — even complex analysis tasks
- **Standard mode** handles deep reasoning (code review, financial analysis, curriculum design)
- **Full mode** enables inter-agent email coordination (M&A agent → writer agent)
- **Async mode** lets the orchestrator continue working while waiting for results
- **Light mode** is fastest for pure data retrieval (~18s)

## Execution Modes

| Mode | Use Case | Overhead | Features |
|------|----------|----------|----------|
| `light` | Data retrieval, lookups | Minimal | No email, no memory, no workspace |
| `standard` | Analysis, research | Medium | Web search, tools, trimmed context |
| `full` | Multi-agent collaboration | Full | Email, memory, all coordination tools |

**Total tests:** 9
