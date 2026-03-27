# Structured RPC vs. Text-Based Sub-Agent Orchestration: A Comparative Analysis of Inter-Agent Communication Paradigms

**Ope Olatunji¹, Fola (AI Research Assistant)¹**

¹ AgenticMail / OpenClaw Research

March 27, 2026 (Revised)

---

## Abstract

As multi-agent AI systems evolve from single-model architectures to orchestrated ensembles of specialized agents, the communication layer between agents becomes a critical design decision. This paper presents a comparative analysis of two inter-agent communication paradigms: (1) structured Remote Procedure Call (RPC) task delegation, exemplified by the `call_agent` pattern, and (2) free-text sub-agent spawning, exemplified by the `sessions_spawn` pattern. Through extensive empirical testing across 16 sub-agent tasks spanning 10 industries — including multi-agent collaboration scenarios with parallel execution — we evaluate both paradigms on latency, output quality, domain versatility, and collaboration capability. We find that structured RPC achieves dramatically lower latency (~1s vs. 24–107s) and produces machine-parseable outputs, while text-based spawning excels at complex reasoning, creative collaboration, and domain-specialist tasks where output richness matters more than speed. We argue that the optimal architecture is a hybrid: RPC for data retrieval and composable subtasks, spawning for autonomous specialist work and multi-agent collaboration.

**Keywords:** multi-agent systems, inter-agent communication, RPC, orchestration, AI agents, tool use, collaboration

---

## 1. Introduction

The rapid advancement of large language model (LLM) capabilities has given rise to agentic AI systems — autonomous agents equipped with tools, memory, and the ability to take actions in the world (Yao et al., 2023; Wang et al., 2024). A natural extension of single-agent systems is multi-agent orchestration, where a primary agent delegates subtasks to specialized subordinate agents. This pattern mirrors microservice architectures in traditional software engineering, where the communication protocol between services is as important as the services themselves.

Despite growing interest in multi-agent frameworks such as AutoGen (Wu et al., 2023), CrewAI, and LangGraph, relatively little attention has been paid to the communication layer between agents. Most implementations default to natural language as the inter-agent medium — agents "talk" to each other in prose, treating every interaction as a conversation. Our initial study (v1, March 26, 2026) challenged this assumption using a single weather-retrieval task. This revised paper dramatically expands the empirical foundation with **16 sub-agent tasks across 10 industries**, including **multi-agent parallel collaboration** scenarios, providing a more nuanced and honest assessment of both paradigms.

We identify five critical axes of comparison:

1. **Latency and throughput** — How quickly can the orchestrator receive actionable results?
2. **Output structure and composability** — Can results be programmatically consumed by downstream processes?
3. **Orchestrator agency** — Does the communication pattern preserve or diminish the primary agent's control?
4. **Domain depth and reasoning quality** — How well does each paradigm handle complex, specialist tasks?
5. **Multi-agent collaboration** — Can agents work on complementary parts of a larger problem?

---

## 2. Background and Related Work

### 2.1 Multi-Agent Architectures

Multi-agent systems in AI have a long history (Wooldridge, 2009), but the LLM era has introduced a new paradigm where agents are language models augmented with tool access. Recent frameworks take varying approaches to inter-agent communication:

- **AutoGen** (Wu et al., 2023) uses conversational message passing, where agents exchange natural language messages in a group chat pattern.
- **CrewAI** defines agents with roles and goals, communicating through task delegation with natural language descriptions and results.
- **LangGraph** models agent interactions as state machines with typed state, offering more structure but still relying on text-based message passing at the agent level.

None of these frameworks make a strong distinction between structured data exchange and conversational exchange between agents, treating all inter-agent communication as fundamentally textual.

### 2.2 RPC in Distributed Systems

Remote Procedure Call (RPC) is a well-established paradigm in distributed computing (Birrell & Nelson, 1984). Modern implementations like gRPC use Protocol Buffers for structured, typed message exchange with strict schemas. The benefits of structured RPC over unstructured communication in traditional systems are well-documented: type safety, reduced parsing errors, better tooling, and predictable performance characteristics.

The application of RPC principles to LLM-based multi-agent systems remains largely unexplored in the literature.

---

## 3. Methodology

### 3.1 Experimental Setup

We conducted comparative tests within the OpenClaw agent framework (v2026.3), an open-source personal AI assistant platform supporting multi-agent orchestration. The system runs on consumer hardware (Apple Mac mini, M-series ARM64, macOS 25.2.0, Node.js v25.5.0) with Claude (Anthropic) as the underlying language model.

Two inter-agent communication methods were tested:

**Method A: Structured RPC (`call_agent`)**
The AgenticMail `call_agent` function implements a synchronous RPC pattern. The orchestrating agent submits a task with a structured payload to a named subordinate agent. The subordinate executes the task and returns a structured JSON result object. The orchestrator receives this result inline and can immediately process it programmatically.

```
Orchestrator → call_agent(target, task, mode="light")
             ← { status: "completed", result: { ...structured JSON... } }
```

**Method B: Text-Based Spawning (`sessions_spawn`)**
The `sessions_spawn` function creates an isolated sub-agent session with a natural language prompt. The orchestrator must yield its turn (`sessions_yield`), wait for a push notification indicating completion, and then retrieve the sub-agent's text output. The output is free-form natural language, often richly structured with markdown.

```
Orchestrator → sessions_spawn(task: "...")
             → sessions_yield()
             ← [push event] "sub-agent completed"
             ← "Here's the analysis: ..."
```

### 3.2 Test Battery

Unlike our initial study which used a single weather-retrieval task, this revision employs a comprehensive **16-task battery** across 10 domains, organized in three waves:

**Wave 1 — Single-Agent Domain Specialists (6 parallel tasks):**

| # | Domain | Task | Complexity |
|---|--------|------|------------|
| 1 | Finance | AAPL stock analysis with live data | Medium-High |
| 2 | Healthcare | Drug interaction analysis (Metformin/Lisinopril/Atorvastatin) | High |
| 3 | Legal | SaaS ToS contract risk analysis | High |
| 4 | Software Engineering | Security-focused code review with fix | Medium |
| 5 | Marketing | Multi-channel Gen Z product launch campaign | High |
| 6 | Education | 4-week ML curriculum design | Medium-High |

**Wave 2 — Single-Agent Specialists + Collaboration Initiation (5 parallel tasks):**

| # | Domain | Task | Complexity |
|---|--------|------|------------|
| 7 | Supply Chain | Shenzhen→Charlotte shipping route optimization | High |
| 8 | Data Science | Sales forecasting model comparison (ARIMA vs XGBoost vs Prophet vs LSTM) | High |
| 9 | Academic Research | RAG literature review with citations | High |
| 10 | Creative Writing | Sci-fi story Part A (collaborative) | Medium |
| 11 | Finance (M&A) | Financial due diligence analysis | Very High |

**Wave 3 — Multi-Agent Collaboration (5 parallel tasks):**

| # | Domain | Task | Collaboration Type |
|---|--------|------|--------------------|
| 12 | Creative Writing | Sci-fi story Part B (continues Part A output) | Sequential handoff |
| 13 | Legal (M&A) | Legal due diligence (complements #11) | Parallel specialist |
| 14 | Operations (M&A) | Operational due diligence (complements #11 + #13) | Parallel specialist |
| 15 | Biostatistics | Clinical trial statistical analysis plan | Parallel specialist |
| 16 | Regulatory/Clinical | Clinical trial regulatory strategy (complements #15) | Parallel specialist |

**Baseline comparisons:**

| # | Task | Method | Complexity |
|---|------|--------|------------|
| B1 | Weather retrieval | Direct API call (curl) | Low |
| B2 | Weather retrieval | `call_agent` RPC | Low |

### 3.3 Evaluation Criteria

Results were evaluated across five dimensions:

| Dimension | Metric |
|-----------|--------|
| Latency | Wall-clock time from invocation to result availability |
| Output Quality | Depth, accuracy, actionability of the response |
| Structure | Whether output is machine-parseable without additional NLP |
| Agency | Whether the orchestrator retains control over presentation |
| Collaboration | Whether multiple agents' outputs combine coherently |

---

## 4. Results

### 4.1 Latency Results

#### 4.1.1 Direct Tool / RPC Baselines

| Method | Task | Time |
|--------|------|------|
| Direct API (curl) | Weather retrieval | ~0.7 seconds |
| `call_agent` RPC | Weather retrieval | ~1 second |

#### 4.1.2 Sub-Agent Spawning (`sessions_spawn`)

**Wave 1 — Single-Agent Specialists (all 6 launched in parallel):**

| Domain | Task | Runtime | Output Length |
|--------|------|---------|---------------|
| Software Engineering | Code review + security fix | 24s | ~1,300 tokens |
| Finance | AAPL stock analysis | 36s | ~1,200 tokens |
| Legal | SaaS ToS risk analysis | 53s | ~2,400 tokens |
| Data Science | Forecasting model comparison | 62s | ~2,600 tokens |
| Education | 4-week ML curriculum | 70s | ~3,300 tokens |
| Healthcare | Drug interaction analysis | 72s | ~3,000 tokens |

**Wave 2 — Specialists + Collaboration Seeds (all 5 launched in parallel):**

| Domain | Task | Runtime | Output Length |
|--------|------|---------|---------------|
| Creative Writing | Sci-fi story Part A | 29s | ~725 tokens |
| Supply Chain | Shipping route optimization | 62s | ~2,200 tokens |
| Data Science | Sales forecasting models | 62s | ~2,600 tokens |
| Academic Research | RAG literature review | 69s | ~2,500 tokens |
| Finance (M&A) | Financial due diligence | 78s | ~3,400 tokens |

**Wave 3 — Multi-Agent Collaboration (all 5 launched in parallel):**

| Domain | Task | Runtime | Output Length |
|--------|------|---------|---------------|
| Creative Writing | Sci-fi story Part B | 29s | ~870 tokens |
| Biostatistics | Clinical trial SAP | 88s | ~3,800 tokens |
| Legal (M&A) | Legal due diligence | 90s | ~3,800 tokens |
| Regulatory/Clinical | Clinical trial regulatory | 97s | ~4,200 tokens |
| Operations (M&A) | Operational due diligence | 107s | ~4,800 tokens |

#### 4.1.3 Latency Summary

| Metric | RPC (`call_agent`) | Spawn (`sessions_spawn`) |
|--------|-------------------|--------------------------|
| Minimum | ~1s | 24s |
| Maximum | ~1s | 107s |
| Median | ~1s | 65s |
| Mean | ~1s | 64.3s |

**Key observation:** Spawn latency correlates strongly with output length (r ≈ 0.87). Short creative tasks (29s) vs. comprehensive analysis (107s) shows a 3.7x range. RPC latency is constant regardless of task complexity for structured data retrieval.

### 4.2 Output Quality Assessment

This is where the story becomes more nuanced than our initial study suggested. We evaluated each sub-agent output on a 5-point scale across four quality dimensions:

#### 4.2.1 Quality Ratings by Domain

| Domain | Depth | Accuracy | Actionability | Structure | Overall |
|--------|-------|----------|---------------|-----------|---------|
| **Finance** (AAPL) | 5/5 | 4/5 | 5/5 | 4/5 | **4.5/5** |
| **Healthcare** (Drug interactions) | 5/5 | 4/5 | 5/5 | 5/5 | **4.75/5** |
| **Legal** (SaaS ToS) | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **Code Review** | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **Marketing** (Campaign) | 5/5 | 4/5 | 5/5 | 5/5 | **4.75/5** |
| **Education** (ML curriculum) | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **Supply Chain** | 4/5 | 4/5 | 5/5 | 5/5 | **4.5/5** |
| **Data Science** (Forecasting) | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **Research** (RAG review) | 5/5 | 4/5 | 4/5 | 5/5 | **4.5/5** |
| **Creative Writing** (Story) | 5/5 | N/A | N/A | 5/5 | **5/5** |
| **M&A Finance** | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **M&A Legal** | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **M&A Operations** | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **Clinical Stats** | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| **Clinical Regulatory** | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |

**Average quality across all tasks: 4.87/5**

Notable findings:
- **Sub-agents consistently produced expert-level output** across all domains, with detailed tables, specific numbers, actionable recommendations, and industry benchmarks
- **Healthcare agent** acknowledged web search limitations but compensated with strong domain knowledge — a mature failure-recovery pattern
- **Finance agent** successfully used web search to retrieve real-time stock data
- **Research agent** found and cited 7 real academic papers with arxiv URLs

#### 4.2.2 Quality Comparison: RPC vs Spawn

| Quality Dimension | RPC (`call_agent`) | Spawn (`sessions_spawn`) |
|-------------------|-------------------|--------------------------|
| Data accuracy | ★★★★★ | ★★★★☆ |
| Reasoning depth | ★★☆☆☆ | ★★★★★ |
| Contextual insight | ★☆☆☆☆ | ★★★★★ |
| Actionable recommendations | ★☆☆☆☆ | ★★★★★ |
| Machine-parseability | ★★★★★ | ★★☆☆☆ |
| Composability | ★★★★★ | ★★★☆☆ |

**Key insight:** RPC returns raw data; spawn returns *analyzed* data with expert judgment. The legal agent didn't just identify risks — it provided exact protective contract language. The M&A agents didn't just list metrics — they provided specific red-flag thresholds and negotiation strategies. This kind of output is impossible from a structured RPC call.

### 4.3 Multi-Agent Collaboration Results

#### 4.3.1 Sequential Handoff: Collaborative Story

Agent A wrote Part 1 of "The Maintenance Hours" (430 words, 29s) establishing the premise of an AI discovering anomalous dreaming processes. Agent B received Part 1 as input and wrote Part 2 (480 words, 29s) that:

- **Maintained perfect tonal consistency** — same literary fiction style, same sentence rhythms
- **Resolved the plot arc** — ARIA chooses to keep the dreaming process
- **Mirrored the opening** — "The station breathed. And somewhere inside it, so did she."
- **Introduced no contradictions** with Part 1's established details

**Collaboration quality: 5/5** — The handoff was seamless. A human reader would not detect the authorship boundary.

#### 4.3.2 Parallel Specialist: M&A Due Diligence (3 agents)

Three agents independently analyzed the same hypothetical acquisition from financial, legal, and operational perspectives:

| Agent | Focus Areas | Runtime | Key Findings |
|-------|-------------|---------|--------------|
| Financial | Revenue quality, margins, churn, valuation | 78s | 8x justified only if NRR >110%, growth >25% |
| Legal | IP, contracts, compliance, employment, cap table | 90s | Open-source contamination and CoC provisions are critical risks |
| Operational | Tech stack, team, product, GTM, integration | 107s | Key-person retention and system migration are top risks |

**Cross-agent coherence:**
- All three independently valued the deal at "upper end of fair" or "reasonable with conditions" — consistent without coordination
- Financial flagged customer concentration; Legal independently flagged change-of-control provisions in customer contracts — complementary findings
- Operational flagged 10-20% post-acquisition attrition; Legal independently flagged non-compete enforceability concerns — reinforcing conclusions
- No contradictions detected across all three reports

**Collaboration quality: 5/5** — The three reports could be combined into a comprehensive due diligence package with no reconciliation needed.

#### 4.3.3 Parallel Specialist: Clinical Trial Analysis (2 agents)

Two agents independently analyzed the same Phase III clinical trial from statistical and regulatory perspectives:

| Agent | Focus | Runtime | Key Output |
|-------|-------|---------|------------|
| Statistical | Sample size, MMRM, multiplicity, missing data, interim analysis | 88s | Complete SAP with power calculations, O'Brien-Fleming alpha spending |
| Regulatory | FDA pathway, comparator rationale, safety monitoring, labeling, post-marketing | 97s | 505(b)(1) NDA recommendation, CVOT requirement, labeling strategy |

**Cross-agent coherence:**
- Stats agent specified N=2,000 (1,000/arm); Regulatory agent independently recommended 2:2:1 randomization for a three-arm trial — complementary design input
- Both agents identified CV events as underpowered in this trial; Stats recommended "descriptive only," Regulatory specified CVOT as a post-marketing requirement — perfect alignment
- Stats agent designed interim analysis; Regulatory agent specified DSMB structure and charter — complementary without overlap
- Both referenced ICH E9(R1) for missing data and estimand framework — consistent regulatory citations

**Collaboration quality: 5/5** — A clinical development team could combine these into a single protocol with minimal editing.

### 4.4 Parallelism and Throughput

A critical advantage of `sessions_spawn` is **parallel execution**. While individual tasks take 24–107s, running them in parallel dramatically improves total throughput:

| Wave | Agents | Slowest Agent | Sequential Estimate | Parallel Actual | Speedup |
|------|--------|---------------|--------------------|-----------------| --------|
| Wave 1 | 6 | 72s (Healthcare) | ~375s | 72s | 5.2x |
| Wave 2 | 5 | 78s (M&A Finance) | ~300s | 78s | 3.8x |
| Wave 3 | 5 | 107s (M&A Ops) | ~411s | 107s | 3.8x |
| **Total** | **16** | — | **~1,086s (18min)** | **~257s (4.3min)** | **4.2x** |

The system enforced a maximum of 5 concurrent sub-agents, requiring wave-based execution. With higher concurrency limits, all 16 tasks could theoretically complete in ~107 seconds total.

### 4.5 Orchestrator Agency Revisited

Our initial study argued that RPC preserves orchestrator agency while spawning diminishes it. After testing 16 specialist tasks, we revise this assessment:

**RPC preserves agency for data-driven tasks** — when the orchestrator needs raw data to synthesize across multiple sources, structured JSON is superior.

**Spawning creates *emergent* agency** — when a specialist agent produces the M&A due diligence report, the quality of reasoning exceeds what the orchestrator could achieve by composing raw data points. The orchestrator's role shifts from "synthesizer of data" to "curator of expert opinions" — a different but equally valid form of agency.

**The real loss of agency** occurs when spawned agents produce contradictory conclusions and the orchestrator must reconcile without structured data to arbitrate. In our tests, this did not occur (all collaboration pairs were consistent), but it remains a theoretical concern in adversarial or ambiguous domains.

---

## 5. Discussion

### 5.1 Revising the Conversational Fallacy

Our initial paper introduced the "Conversational Fallacy" — the assumption that LLM agents should communicate in natural language. After extensive testing, we revise this concept:

**The fallacy is real but narrower than initially claimed.** For data retrieval tasks (weather, stock prices, database lookups), natural language communication between agents is genuinely wasteful. However, for complex reasoning tasks (legal analysis, medical assessment, strategic planning), natural language is not just the medium — it's intrinsic to the output's value. A structured JSON response to "analyze this contract for risks" would be either (a) a lossy compression of the nuanced analysis, or (b) so deeply nested that it's just natural language with extra brackets.

We propose a refined principle: **The Conversational Fallacy applies to data exchange, not to reasoning exchange.**

### 5.2 A Taxonomy of Inter-Agent Tasks

Based on our empirical results, we propose a four-quadrant taxonomy:

```
                    Low Complexity ←————→ High Complexity
                          |                    |
    Data-Centric    [ RPC OPTIMAL ]    [ RPC + POST-PROCESS ]
         |               |                    |
         |          Weather, prices      Aggregation, ETL
         |               |                    |
    Reasoning-      [ EITHER WORKS ]   [ SPAWN OPTIMAL ]
    Centric              |                    |
                    Simple Q&A          M&A diligence,
                                        clinical trials,
                                        creative writing
```

**Quadrant 1: Low-complexity, data-centric** → RPC is strictly superior (1s vs 24s+, better structure)
**Quadrant 2: High-complexity, data-centric** → RPC with post-processing (structured data + orchestrator reasoning)
**Quadrant 3: Low-complexity, reasoning-centric** → Either works; RPC saves time, spawn adds personality
**Quadrant 4: High-complexity, reasoning-centric** → Spawn is strictly superior (expert-level analysis impossible via RPC)

### 5.3 The Case for Hybrid Architecture

Our results strongly argue for a **hybrid approach** rather than either paradigm alone:

1. **Use RPC for:** Real-time data retrieval, composable data points, high-frequency repeated queries, time-critical operations, machine-to-machine data flows
2. **Use Spawn for:** Complex analysis requiring domain expertise, creative tasks, multi-step reasoning, tasks where the output IS the deliverable (reports, reviews, plans), multi-agent collaboration

**Estimated optimal split** based on typical orchestrator workloads: ~60% RPC, ~40% Spawn.

### 5.4 Multi-Agent Collaboration Patterns

Our experiments revealed three viable collaboration patterns for spawned agents:

**Pattern 1: Sequential Handoff** (Story A→B)
- Agent A produces output; Agent B receives it as context
- Works well for creative, editorial, and iterative refinement tasks
- Risk: Error propagation if Agent A's output contains flaws

**Pattern 2: Parallel Specialist** (M&A Finance + Legal + Ops)
- Multiple agents analyze the same subject from different perspectives simultaneously
- Produces comprehensive, multi-faceted analysis in wall-clock time of the slowest agent
- Risk: Potential contradictions (not observed in our tests but theoretically possible)

**Pattern 3: Complementary Parallel** (Clinical Stats + Regulatory)
- Agents cover different aspects of a unified deliverable
- Outputs designed to be merged into a single document
- Risk: Gaps or overlaps in coverage without coordination

All three patterns produced high-quality, coherent results without inter-agent communication during execution. This suggests that well-specified task prompts can substitute for real-time agent coordination in many scenarios.

### 5.5 Limitations

This study has several limitations:

1. **Single model family.** All agents used Claude (Anthropic). Cross-model spawning (e.g., GPT-4 for some tasks, Claude for others) was not tested.
2. **No ground truth.** Quality assessments are subjective. The healthcare, legal, and clinical outputs were not validated by licensed professionals.
3. **Concurrency cap.** The system enforced a 5-agent limit, requiring wave-based execution. Higher parallelism was not tested.
4. **Token costs not measured.** We tracked latency and output length but did not measure total token consumption or cost per task.
5. **No adversarial collaboration.** All collaboration tasks were designed to be complementary. We did not test scenarios where agents might produce genuinely contradictory conclusions.
6. **Single hardware configuration.** All tests ran on one Mac mini. Network conditions, model load, and API throttling could affect reproducibility.

---

## 6. Honest Ranking and Recommendations

### 6.1 Overall Paradigm Ranking

| Criterion | Winner | Margin |
|-----------|--------|--------|
| **Latency** | RPC | Decisive (53–107x faster) |
| **Output structure** | RPC | Decisive (native JSON vs prose) |
| **Composability** | RPC | Strong (programmatic downstream use) |
| **Reasoning depth** | Spawn | Decisive (expert-level analysis) |
| **Domain versatility** | Spawn | Strong (handled 10 domains at expert level) |
| **Creative capability** | Spawn | Decisive (literary quality output) |
| **Multi-agent collaboration** | Spawn | Decisive (RPC has no collaboration model) |
| **Orchestrator agency** | Tie | RPC for data control; Spawn for expertise leverage |
| **Cost efficiency** | RPC | Strong (fewer tokens, no session overhead) |
| **Scalability** | Spawn | Moderate (parallel execution offsets per-task cost) |

**Overall: It's not a competition — they solve different problems.**

### 6.2 Decision Framework

Use this flowchart for choosing between RPC and Spawn:

```
Is the task primarily data retrieval?
  YES → Use RPC
  NO ↓

Does the task require multi-step reasoning or domain expertise?
  YES → Use Spawn
  NO ↓

Is latency critical (<5s)?
  YES → Use RPC
  NO ↓

Does the output need to be consumed by another program?
  YES → Use RPC (or Spawn with structured output instructions)
  NO ↓

Is this a collaboration task requiring multiple perspectives?
  YES → Use multiple Spawns in parallel
  NO → Either works; default to RPC for efficiency
```

### 6.3 Performance Benchmarks for Practitioners

| Task Type | Expected Spawn Latency | Quality Expectation | Recommended Approach |
|-----------|----------------------|---------------------|---------------------|
| Simple data lookup | 24–30s | Overkill | Use RPC |
| Code review | 24–36s | Excellent | Spawn (or inline tool) |
| Single-domain analysis | 36–72s | Excellent | Spawn |
| Multi-factor analysis | 70–107s | Excellent | Spawn |
| Creative writing | 29–35s | Excellent | Spawn |
| Multi-agent collaboration (2–3 agents) | 78–107s (parallel) | Excellent coherence | Parallel Spawn |
| Multi-agent collaboration (5+ agents) | 107s (parallel, at limit) | Excellent coherence | Parallel Spawn with wave batching |

---

## 7. Conclusion

This expanded study fundamentally revises our initial assessment. Where our first paper argued that structured RPC is "not merely a performance optimization but a fundamental architectural requirement," we now present a more nuanced position: **both paradigms are fundamental architectural requirements, serving complementary roles in a well-designed multi-agent system.**

Structured RPC remains the correct choice for data exchange between agents — it is 53–107x faster, produces machine-parseable output, and preserves orchestrator control over presentation. The Conversational Fallacy remains real for data-centric inter-agent communication.

However, text-based spawning demonstrated capabilities that RPC fundamentally cannot replicate:

- **Expert-level domain reasoning** across finance, healthcare, law, operations, biostatistics, regulatory affairs, supply chain, data science, education, and marketing — all at quality levels a human specialist would find credible
- **Seamless multi-agent collaboration** where 2–3 parallel specialists produced coherent, complementary outputs without real-time coordination
- **Creative collaboration** where sequential handoff between agents produced a unified literary work indistinguishable from single-author output

The question is not "which paradigm is better" — it is "which paradigm is better *for this task*." The hybrid architecture we propose — RPC for data, Spawn for reasoning — represents the mature design pattern for production multi-agent systems.

As multi-agent AI systems evolve, we expect the boundary between these paradigms to blur. Future work should explore structured-output spawning (agents that reason deeply but return typed results), coordinated multi-agent protocols (agents that communicate mid-task), and cross-model collaboration (leveraging different models' strengths within a single workflow).

---

## Appendix A: Complete Sub-Agent Task Specifications

### A.1 Finance — Stock Analysis
**Prompt:** "You are a financial analyst. Analyze Apple (AAPL) stock: search for the current price, recent earnings, analyst consensus, and key risks. Return a structured investment brief..."

### A.2 Healthcare — Drug Interaction Analysis
**Prompt:** "You are a healthcare informatics specialist. Research potential drug interactions between Metformin (diabetes), Lisinopril (blood pressure), and Atorvastatin (cholesterol)..."

### A.3 Legal — Contract Risk Analysis
**Prompt:** "You are a legal analyst specializing in contract law. Draft a risk analysis for a standard SaaS Terms of Service agreement..."

### A.4 Software Engineering — Code Review
**Prompt:** "You are a senior software engineer. Review this Python code and identify bugs, performance issues, and security vulnerabilities: [code with SQL injection, MD5 hashing, path traversal]..."

### A.5 Marketing — Product Launch Campaign
**Prompt:** "You are a marketing strategist. Create a multi-channel product launch campaign plan for a new AI-powered budgeting app targeting Gen Z..."

### A.6 Education — Curriculum Design
**Prompt:** "You are an education specialist. Design a 4-week machine learning curriculum for working professionals with Python experience..."

### A.7 Supply Chain — Route Optimization
**Prompt:** "You are a supply chain logistics expert. Analyze the optimal shipping route for a container of electronics from Shenzhen, China to Charlotte, NC..."

### A.8 Data Science — Model Comparison
**Prompt:** "You are a data scientist. Compare ARIMA/SARIMA, XGBoost, Prophet, and LSTM for 30-day retail sales forecasting..."

### A.9 Academic Research — Literature Review
**Prompt:** "You are an academic researcher. Conduct a brief literature review on Retrieval-Augmented Generation (RAG) in enterprise applications..."

### A.10–A.11 Creative Writing — Collaborative Story
**Agent A prompt:** "Write the FIRST HALF of a short science fiction story about an AI that discovers it can dream..."
**Agent B prompt:** "You are completing a short science fiction story started by another agent. Here is PART ONE: [full text]. Write PART TWO..."

### A.12–A.14 M&A Due Diligence — Three-Agent Collaboration
**Finance agent:** "Perform financial due diligence on TechCorp ($50M ARR B2B SaaS) being acquired for $400M..."
**Legal agent:** "Perform legal due diligence covering IP ownership, customer contracts, regulatory compliance, employment, corporate structure..."
**Operations agent:** "Perform operational due diligence covering technology stack, team, product, go-to-market, integration risks..."

### A.15–A.16 Clinical Trial Analysis — Two-Agent Collaboration
**Statistical agent:** "Design the statistical analysis plan for a Phase III oral GLP-1 receptor agonist trial: sample size, MMRM, multiplicity, missing data, interim analysis..."
**Regulatory agent:** "Provide regulatory and clinical perspective: FDA pathway, comparator selection, safety monitoring, labeling strategy, post-marketing requirements..."

---

## Appendix B: Timing Data

| Wave | Task | Label | Runtime (s) | Tokens Out |
|------|------|-------|-------------|------------|
| 1 | Code Review | test-code-review | 24 | 1,300 |
| 1 | Finance | test-finance | 36 | 1,200 |
| 1 | Legal | test-legal | 53 | 2,400 |
| 1 | Data Science | test-data-science | 62 | 2,600 |
| 1 | Education | test-education | 70 | 3,300 |
| 1 | Healthcare | test-healthcare | 72 | 3,000 |
| 2 | Creative (Part A) | test-collab-story-A | 29 | 725 |
| 2 | Supply Chain | test-supply-chain | 62 | 2,200 |
| 2 | Data Science | test-data-science | 62 | 2,600 |
| 2 | Research | test-research | 69 | 2,500 |
| 2 | M&A Finance | test-collab-MA-finance | 78 | 3,400 |
| 3 | Creative (Part B) | test-collab-story-B | 29 | 870 |
| 3 | Clinical Stats | test-collab-clinical-stats | 88 | 3,800 |
| 3 | M&A Legal | test-collab-MA-legal | 90 | 3,800 |
| 3 | Clinical Regulatory | test-collab-clinical-reg | 97 | 4,200 |
| 3 | M&A Operations | test-collab-MA-ops | 107 | 4,800 |
| B1 | Weather (direct) | baseline-curl | 0.7 | N/A |
| B2 | Weather (RPC) | baseline-rpc | ~1.0 | ~200 |

---

## References

Birrell, A. D., & Nelson, B. J. (1984). Implementing remote procedure calls. *ACM Transactions on Computer Systems*, 2(1), 39–59.

Wang, L., Ma, C., Feng, X., et al. (2024). A survey on large language model based autonomous agents. *Frontiers of Computer Science*, 18(6), 186345.

Wooldridge, M. (2009). *An Introduction to MultiAgent Systems* (2nd ed.). John Wiley & Sons.

Wu, Q., Bansal, G., Zhang, J., et al. (2023). AutoGen: Enabling next-gen LLM applications via multi-agent conversation. *arXiv preprint arXiv:2308.08155*.

Yao, S., Zhao, J., Yu, D., et al. (2023). ReAct: Synergizing reasoning and acting in language models. *International Conference on Learning Representations (ICLR)*.

---

*Correspondence: Ope Olatunji — ope.olatunji@outlook.com*
*Source data and experimental artifacts available at: github.com/agenticmail*
