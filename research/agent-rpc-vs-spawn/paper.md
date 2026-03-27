# Structured RPC vs. Text-Based Sub-Agent Orchestration: A Comparative Analysis of Inter-Agent Communication Paradigms

**Ope Olatunji¹, Fola (AI Research Assistant)¹**

¹ AgenticMail / OpenClaw Research

March 26, 2026

---

## Abstract

As multi-agent AI systems evolve from single-model architectures to orchestrated ensembles of specialized agents, the communication layer between agents becomes a critical design decision. This paper presents a comparative analysis of two inter-agent communication paradigms: (1) structured Remote Procedure Call (RPC) task delegation, exemplified by the `call_agent` pattern, and (2) free-text sub-agent spawning, exemplified by the `sessions_spawn` pattern. Through empirical testing on identical tasks within the OpenClaw agent framework, we demonstrate that structured RPC achieves a 53x latency improvement, produces machine-parseable outputs suitable for downstream composition, and preserves orchestrator agency. We argue that structured inter-agent communication is not merely a performance optimization but a fundamental architectural requirement for reliable multi-agent systems.

**Keywords:** multi-agent systems, inter-agent communication, RPC, orchestration, AI agents, tool use

---

## 1. Introduction

The rapid advancement of large language model (LLM) capabilities has given rise to agentic AI systems — autonomous agents equipped with tools, memory, and the ability to take actions in the world (Yao et al., 2023; Wang et al., 2024). A natural extension of single-agent systems is multi-agent orchestration, where a primary agent delegates subtasks to specialized subordinate agents. This pattern mirrors microservice architectures in traditional software engineering, where the communication protocol between services is as important as the services themselves.

Despite growing interest in multi-agent frameworks such as AutoGen (Wu et al., 2023), CrewAI, and LangGraph, relatively little attention has been paid to the communication layer between agents. Most implementations default to natural language as the inter-agent medium — agents "talk" to each other in prose, treating every interaction as a conversation. This paper challenges that default by presenting empirical evidence from a production multi-agent system (OpenClaw with AgenticMail) that structured RPC-style communication dramatically outperforms conversational spawning across multiple dimensions.

We identify three critical axes of comparison:

1. **Latency and throughput** — How quickly can the orchestrator receive actionable results?
2. **Output structure and composability** — Can results be programmatically consumed by downstream processes?
3. **Orchestrator agency** — Does the communication pattern preserve or diminish the primary agent's control over presentation and decision-making?

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

We conducted comparative tests within the OpenClaw agent framework (v2026.3), an open-source personal AI assistant platform supporting multi-agent orchestration. The system runs on consumer hardware (Apple Mac mini, M-series ARM64, macOS 25.2.0, Node.js v25.5.0) with Claude as the underlying language model.

Two inter-agent communication methods were tested:

**Method A: Structured RPC (`call_agent`)**
The AgenticMail `call_agent` function implements a synchronous RPC pattern. The orchestrating agent submits a task with a structured payload to a named subordinate agent. The subordinate executes the task and returns a structured JSON result object. The orchestrator receives this result inline and can immediately process it programmatically.

```
Orchestrator → call_agent(target, task, mode="light")
             ← { status: "completed", result: { ...structured JSON... } }
```

**Method B: Text-Based Spawning (`sessions_spawn`)**
The `sessions_spawn` function creates an isolated sub-agent session with a natural language prompt. The orchestrator must yield its turn (`sessions_yield`), wait for a push notification indicating completion, and then retrieve the sub-agent's text output. The output is free-form natural language.

```
Orchestrator → sessions_spawn(task: "...")
             → sessions_yield()
             ← [push event] "sub-agent completed"
             ← "Here's the weather: 69°F, clear skies..."
```

### 3.2 Test Task

Both methods were given an identical task: retrieve the current weather for Charlotte, NC, and return temperature, conditions, humidity, wind speed/direction, and cloud cover. This task was chosen for its determinism (both methods query the same underlying weather API), moderate complexity, and easily verifiable output structure.

### 3.3 Evaluation Criteria

Results were evaluated across three dimensions:

| Dimension | Metric |
|-----------|--------|
| Latency | Wall-clock time from invocation to result availability |
| Structure | Whether output is machine-parseable without additional NLP |
| Agency | Whether the orchestrator retains control over presentation |

---

## 4. Results

### 4.1 Latency

| Method | Invocation to Result | Overhead |
|--------|---------------------|----------|
| `call_agent` (RPC) | ~1 second | Single tool call round-trip |
| `sessions_spawn` (Text) | ~53 seconds | Session creation + model inference + yield + push notification |

The structured RPC method completed approximately **53 times faster** than the text-based spawning method. The latency difference is attributable to several factors:

1. **Session overhead:** `sessions_spawn` creates an entirely new agent session with full context loading, system prompt injection, and tool initialization.
2. **Inference overhead:** The spawned agent must generate a natural language response, which requires full autoregressive token generation rather than structured field population.
3. **Coordination overhead:** The orchestrator must yield its turn, wait for a push event, and then resume — introducing asynchronous coordination latency.
4. **Mode optimization:** `call_agent` with `mode="light"` skips email infrastructure, context loading, and other heavyweight initialization, executing with minimal overhead.

### 4.2 Output Structure

**RPC Output (call_agent):**
```json
{
  "location": "Charlotte, NC",
  "timestamp": "2026-03-26T21:45 EDT",
  "temperature": "69.0°F",
  "feels_like": "65.9°F",
  "conditions": "Clear skies",
  "humidity": "59%",
  "wind": {
    "speed": "10.3 mph",
    "direction": "SSW (200°)",
    "gusts": "21.0 mph"
  },
  "cloud_cover": "0%",
  "precipitation": "0.000 inches",
  "surface_pressure": "986.1 hPa"
}
```

**Text Output (sessions_spawn):**
```
Here's the current weather in Charlotte, NC as of Thursday,
March 26, 2026 at 9:45 PM EDT:
- Temperature: 69°F
- Feels Like: 65.9°F
- Conditions: Clear skies (0% cloud cover, no precipitation)
- Humidity: 59%
- Wind: 10.3 mph from the SSW (200°), gusts up to 21 mph
- Barometric Pressure: 986.1 hPa
- Weather Code: 0 (Clear)
Pleasant spring evening — clear, mild, and a bit breezy.
```

Both methods returned semantically identical information. However, the RPC output is immediately indexable, comparable, and composable. The text output requires natural language parsing to extract individual values — a process that is both error-prone and non-deterministic across invocations.

### 4.3 Orchestrator Agency

A critical but underexamined dimension is the effect on orchestrator agency — the degree to which the primary agent retains control over how information is presented to the end user.

With **structured RPC**, the orchestrator receives raw data and makes all presentational decisions. If the user asks "Should I wear a jacket tonight?", the orchestrator can inspect the temperature field (69°F), wind speed (10.3 mph with 21 mph gusts), and humidity (59%) to synthesize a contextual recommendation. The data serves the orchestrator's judgment.

With **text-based spawning**, the subordinate agent has already made presentational decisions. The phrase "Pleasant spring evening — clear, mild, and a bit breezy" embeds the subordinate's editorial judgment. The orchestrator is reduced to forwarding another agent's narrative rather than forming its own. This is the difference between a manager who reviews data and makes decisions versus one who simply forwards emails from subordinates.

This loss of agency compounds in multi-step workflows. Consider an orchestrator that must check weather, calendar, and traffic to advise whether to leave for an appointment. With RPC, it receives three structured results and reasons holistically. With text spawning, it receives three prose paragraphs and must reconcile potentially inconsistent narrative voices, redundant information, and varying levels of detail.

---

## 5. Discussion

### 5.1 The Conversational Fallacy

There is an implicit assumption in many multi-agent frameworks that because LLMs communicate in natural language, inter-agent communication should also be natural language. We term this the **Conversational Fallacy**. This assumption conflates two distinct communication contexts:

1. **Agent-to-Human communication**, where natural language is appropriate because the recipient is a human who thinks in natural language.
2. **Agent-to-Agent communication**, where the recipient is a program that can process structured data more reliably and efficiently than prose.

The Conversational Fallacy leads to systems where agents waste inference cycles generating prose that other agents must then parse — a computationally expensive round-trip through natural language that serves neither party. This is analogous to two microservices communicating by rendering HTML pages for each other to scrape.

### 5.2 Implications for Multi-Agent Architecture

Our findings suggest several architectural principles for multi-agent systems:

**Principle 1: Separate data exchange from presentation.** Inter-agent communication should transmit structured data. Presentation (natural language generation) should occur only at the boundary between agent and human.

**Principle 2: Minimize session overhead for lightweight tasks.** Not every delegation requires a full agent session. The `mode="light"` pattern in `call_agent` demonstrates that many tasks can be executed with minimal context, avoiding the cost of full session initialization.

**Principle 3: Preserve orchestrator agency.** The orchestrating agent should receive data, not conclusions. This allows the orchestrator to reason across multiple data sources and maintain a coherent voice with the end user.

**Principle 4: Use spawning for genuinely autonomous tasks.** Text-based spawning remains valuable for tasks that require extended autonomy, multi-turn reasoning, or access to the full agent context. The key insight is that spawning should be reserved for tasks where these capabilities are needed, not used as the default communication pattern.

### 5.3 Limitations

This study has several limitations. First, the comparison was conducted within a single framework (OpenClaw/AgenticMail) and results may vary across platforms. Second, the test task (weather retrieval) is relatively simple; more complex tasks involving multi-turn reasoning may benefit more from the richer context of spawned sessions. Third, we did not measure token consumption, which is an important cost dimension in production systems. Future work should examine these dimensions.

---

## 6. Conclusion

We have presented empirical evidence that structured RPC-style inter-agent communication outperforms text-based sub-agent spawning across latency (53x faster), output composability (machine-parseable JSON vs. free-form prose), and orchestrator agency (data-driven reasoning vs. narrative forwarding). We introduce the concept of the Conversational Fallacy — the mistaken assumption that LLM-based agents should communicate with each other in the same natural language they use with humans — and argue that this fallacy leads to architecturally suboptimal multi-agent systems.

As multi-agent AI systems mature from research prototypes to production infrastructure, the communication layer between agents deserves the same rigorous design attention that RPC protocols receive in traditional distributed systems. The question is not whether agents *can* communicate in natural language — they obviously can — but whether they *should*.

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
