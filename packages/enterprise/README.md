# @agenticmail/enterprise

**Deploy and manage AI agents as employees in your organization.** Full platform for configuring agent skills, permissions, deployment targets, lifecycle management, and compliance — with a web dashboard and REST API.

AgenticMail Enterprise turns AI agents into managed employees. You define what an agent can do (skills, tools, permissions), where it runs (Docker, VPS, Fly.io, Railway), and how it's supervised (approval workflows, activity tracking, audit logs). The platform handles provisioning, health monitoring, auto-recovery, and multi-tenant isolation. Each agent gets its own email, workspace, and tool access — governed by policies you control from a single dashboard.

[![npm](https://img.shields.io/npm/v/@agenticmail/enterprise)](https://www.npmjs.com/package/@agenticmail/enterprise)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)

---

## Table of Contents

- [Quick Start](#quick-start)
- [What This Does (Plain English)](#what-this-does-plain-english)
- [Architecture](#architecture)
- [Setup Wizard](#setup-wizard)
- [Database Support](#database-support)
- [The Engine](#the-engine)
  - [Skills & Permissions](#1-skills--permissions)
  - [Agent Configuration](#2-agent-configuration)
  - [Deployment Engine](#3-deployment-engine)
  - [Approval Workflows](#4-approval-workflows)
  - [Agent Lifecycle](#5-agent-lifecycle)
  - [Knowledge Base](#6-knowledge-base)
  - [Multi-Tenant Isolation](#7-multi-tenant-isolation)
  - [Activity Tracking](#8-activity-tracking)
  - [Tool Catalog](#9-tool-catalog)
  - [OpenClaw Hook](#10-openclaw-hook)
  - [AgenticMail Bridge](#11-agenticmail-bridge)
- [REST API](#rest-api)
  - [Authentication](#authentication)
  - [Admin Endpoints](#admin-endpoints)
  - [Engine Endpoints](#engine-endpoints)
- [Dashboard](#dashboard)
- [Deployment](#deployment)
  - [AgenticMail Cloud](#agenticmail-cloud)
  - [Fly.io](#flyio)
  - [Docker](#docker)
  - [Local Development](#local-development)
- [Server Configuration](#server-configuration)
- [Middleware](#middleware)
- [Resilience](#resilience)
- [Programmatic Usage](#programmatic-usage)
- [Security](#security)
- [License](#license)

---

## Quick Start

```bash
npx @agenticmail/enterprise
```

The interactive wizard walks you through:
1. Company name and admin credentials
2. Database selection (10 backends supported)
3. Deployment target (Cloud, Fly.io, Docker, Railway, or Local)
4. Optional custom domain

Within 2 minutes you get a live dashboard URL with your admin account ready.

---

## What This Does (Plain English)

Think of AgenticMail Enterprise as an HR department for AI agents.

**The problem:** You want to deploy AI agents that do real work — answer customer emails, research topics, write reports, manage schedules. But right now, setting up each agent means manually configuring tools, permissions, credentials, deployment, and monitoring. Scale that to 10 or 50 agents across a team, and it becomes unmanageable.

**What Enterprise does:**

- **Hiring** — You pick from 38 pre-built skill sets (email management, web research, coding, customer support, etc.) and assign them to a new agent. The platform generates all the config files, workspace setup, and tool permissions automatically.

- **Onboarding** — The agent gets deployed to your chosen infrastructure (a Docker container, a VPS, Fly.io, Railway, or our managed cloud). It gets its own email address, API keys, and workspace. No manual setup.

- **Permissions** — You control exactly what each agent can and can't do. "This agent can send emails but not access the filesystem." "This agent can browse the web but needs approval before making purchases." Five preset permission profiles (Research Assistant, Customer Support, Developer, Full Access, Sandbox) or fully custom.

- **Supervision** — Sensitive actions trigger approval workflows. An agent wants to send an email to a client? It gets queued for human review first. You set the policies.

- **Health & Recovery** — The platform monitors every agent. If one crashes, it auto-restarts. If it's stuck, it gets flagged. You see everything in the dashboard — which agents are running, what they're doing, how much they cost.

- **Knowledge** — Agents can share knowledge bases. Upload documents, and the platform chunks them for retrieval. Agents search the knowledge base as part of their workflow.

- **Teams** — Multi-tenant isolation means different teams or clients get their own agents, data, and billing. Plan tiers (Free, Team, Enterprise, Self-Hosted) enforce limits.

- **Audit** — Every action is logged. Who did what, when, to which resource. Compliance teams can pull reports.

**In short:** You focus on what your agents should do. Enterprise handles how they run, where they run, and keeping them in line.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Dashboard (Web UI)                  │
│              Single HTML · React 18 · CDN             │
└─────────────────────────┬────────────────────────────┘
                          │ HTTP
┌─────────────────────────▼────────────────────────────┐
│                   Hono API Server                     │
│                                                       │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │  Auth    │  │  Admin   │  │       Engine          │ │
│  │  Routes  │  │  Routes  │  │                       │ │
│  │         │  │          │  │  Skills · Permissions  │ │
│  │  JWT    │  │  Users   │  │  Config · Deployer    │ │
│  │  Login  │  │  Agents  │  │  Approvals · Lifecycle│ │
│  │  Keys   │  │  Audit   │  │  Knowledge · Tenants  │ │
│  │         │  │  Keys    │  │  Activity · Hook      │ │
│  └─────────┘  └──────────┘  └──────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │               Middleware Stack                    │  │
│  │  Rate Limit · CORS · Security Headers · Audit   │  │
│  │  Request ID · Error Handler · RBAC              │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │               Resilience Layer                   │  │
│  │  Circuit Breaker · Health Monitor · Retry       │  │
│  │  Rate Limiter · Keyed Rate Limiter              │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────┬────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────┐
│              Database Adapter (Abstract)               │
│                                                       │
│  SQLite · Postgres · MySQL · MongoDB · DynamoDB      │
│  Turso · Supabase · Neon · PlanetScale · CockroachDB │
└──────────────────────────────────────────────────────┘
```

---

## Setup Wizard

The CLI wizard (`npx @agenticmail/enterprise`) runs in 4 steps:

### Step 1: Company Info
- Company name (used to generate your subdomain)
- Admin email and password

### Step 2: Database
Choose from 10 supported backends. Each asks for its specific connection details:
- **SQLite** — file path (default: `./agenticmail-enterprise.db`)
- **PostgreSQL / Supabase / Neon / CockroachDB** — connection string
- **MySQL / PlanetScale** — connection string
- **MongoDB** — connection URI
- **DynamoDB** — AWS region + credentials
- **Turso / LibSQL** — database URL + auth token

### Step 3: Deployment Target
- **AgenticMail Cloud** — managed hosting, instant URL (`company.agenticmail.cloud`)
- **Fly.io** — generates `fly.toml`, you deploy to your Fly account
- **Railway** — generates Railway config
- **Docker** — generates `docker-compose.yml` for self-hosting
- **Local** — starts the server immediately on localhost (dev/testing)

### Step 4: Custom Domain (optional)
Add a custom domain (e.g., `agents.acme.com`) with CNAME setup instructions.

---

## Database Support

Enterprise uses an abstract `DatabaseAdapter` interface. All 10 backends implement the same methods — you pick the one that fits your infrastructure.

| Database | Type | Connection | Best For |
|----------|------|------------|----------|
| **SQLite** | Embedded SQL | File path | Local dev, single-server, prototyping |
| **PostgreSQL** | Hosted SQL | Connection string | Production, most cloud providers |
| **MySQL** | Hosted SQL | Connection string | Existing MySQL infrastructure |
| **MongoDB** | NoSQL | Connection URI | Document-oriented workloads |
| **DynamoDB** | NoSQL | AWS credentials | AWS-native, serverless scale |
| **Turso / LibSQL** | Edge SQL | URL + token | Edge deployments, global distribution |
| **Supabase** | Managed Postgres | Connection string | Supabase ecosystem |
| **Neon** | Serverless Postgres | Connection string | Serverless, branching |
| **PlanetScale** | Managed MySQL | Connection string | PlanetScale ecosystem |
| **CockroachDB** | Distributed SQL | Connection string | Multi-region, high availability |

### Adapter Pattern

Every adapter extends `DatabaseAdapter` and implements:

```typescript
// Core operations
migrate(): Promise<void>
disconnect(): Promise<void>
getStats(): Promise<Stats>

// Users
createUser(input: UserInput): Promise<User>
getUserByEmail(email: string): Promise<User | null>
validatePassword(email: string, password: string): Promise<User | null>

// Agents
createAgent(input: AgentInput): Promise<Agent>
listAgents(filters?): Promise<Agent[]>
getAgent(id: string): Promise<Agent | null>
updateAgent(id: string, updates): Promise<Agent>
deleteAgent(id: string): Promise<void>

// API Keys
createApiKey(input: ApiKeyInput): Promise<ApiKey>
validateApiKey(key: string): Promise<ApiKey | null>
revokeApiKey(id: string): Promise<void>

// Audit Log
logEvent(event: AuditEvent): Promise<void>
getAuditLog(filters: AuditFilters): Promise<AuditEvent[]>

// Settings
getSettings(): Promise<CompanySettings>
updateSettings(updates): Promise<CompanySettings>
```

### MongoDB Notes
- Uses `_id` field directly (stores `randomUUID()` as `_id`)
- Indexes created on `email`, `apiKey`, `createdAt`

### DynamoDB Notes
- Single-table design with PK prefix pattern (`USER#`, `AGENT#`, `KEY#`, `AUDIT#`)
- GSI1 for secondary access patterns
- All entities in one table for cost efficiency

### Creating a Custom Adapter

```typescript
import { DatabaseAdapter } from '@agenticmail/enterprise';

class MyAdapter extends DatabaseAdapter {
  async migrate() { /* create tables/collections */ }
  async createUser(input) { /* ... */ }
  // ... implement all abstract methods
}
```

---

## The Engine

The Engine is the brain of Enterprise — 11 subsystems that handle everything from "what can this agent do?" to "deploy it to production and watch it run."

### 1. Skills & Permissions

**38 built-in skills** organized into categories:

| Category | Skills |
|----------|--------|
| Communication | Email Management, SMS & Phone, Calendar, Messaging |
| Research | Web Search, Web Browsing, News Monitoring, Academic Research |
| Development | Code Execution, Git & GitHub, Database, API Integration |
| Content | Writing, Image Generation, Audio/TTS, Video Processing |
| Productivity | Task Management, Note Taking, File Management, Spreadsheets |
| System | System Administration, Docker, Network, Security |
| AI/ML | Model Inference, RAG/Knowledge Base, Agent Orchestration |
| Business | CRM, Analytics, Billing, HR |
| IoT/Smart Home | Home Automation, Camera/Surveillance, Media Playback |
| Custom | Custom Tools (user-defined) |

Each skill defines:
- **Tools** — which tool IDs are included (mapped to real OpenClaw + AgenticMail tool IDs)
- **Config fields** — what settings the skill needs (API keys, hostnames, etc.)
- **Risk level** — low, medium, high, critical
- **Side effects** — what the skill can affect (network, filesystem, email, etc.)

**5 preset permission profiles:**

| Profile | Description | Tools | Risk |
|---------|-------------|-------|------|
| Research Assistant | Web search, reading, note-taking | ~25 | Low |
| Customer Support | Email, messaging, CRM, KB search | ~35 | Medium |
| Developer | Code, Git, Docker, APIs, databases | ~45 | High |
| Full Access | Everything enabled | All | Critical |
| Sandbox | Minimal tools, no external access | ~10 | Low |

**How permissions work:**

```typescript
const engine = new PermissionEngine();

// Check if an agent can use a tool
const result = engine.checkPermission(agentProfile, 'agenticmail_send');
// → { allowed: true, reason: 'Granted by Email Management skill' }

// Or with approval required
const result2 = engine.checkPermission(agentProfile, 'exec');
// → { allowed: false, requiresApproval: true, reason: 'Code Execution requires admin approval' }
```

### 2. Agent Configuration

Generates all the files an agent needs to run:

- **SOUL.md** — personality, tone, boundaries
- **AGENTS.md** — workspace conventions
- **USER.md** — who the agent serves
- **TOOLS.md** — environment-specific tool notes
- **Gateway config** — OpenClaw `openclaw.json` with plugins, channels, tool policies
- **Deploy scripts** — Dockerfile, docker-compose, startup scripts

```typescript
const generator = new AgentConfigGenerator();
const config = generator.generate({
  name: 'support-bot',
  role: 'Customer Support Agent',
  skills: ['email-management', 'crm', 'knowledge-base'],
  channels: [{ type: 'email' }, { type: 'slack', webhook: '...' }],
  deployment: { target: 'docker' },
});
// → { workspace: { 'SOUL.md': '...', ... }, gateway: { ... }, deploy: { ... } }
```

### 3. Deployment Engine

Provisions and manages agent infrastructure:

- **Docker** — Generates Dockerfile + compose, builds image, starts container
- **VPS** — SSH into a server, install dependencies, configure systemd service
- **Fly.io** — Creates Fly app, sets secrets, deploys
- **Railway** — Generates Railway config, links project

Each deployment goes through phases:
1. **Validate** — check config, verify credentials
2. **Provision** — create infrastructure resources
3. **Configure** — write config files, set environment variables
4. **Deploy** — push code/image, start the agent
5. **Verify** — health check, confirm agent is responding

```typescript
const deployer = new DeploymentEngine();
const result = await deployer.deploy({
  agentId: 'agent-123',
  target: 'docker',
  config: { /* ... */ },
});
// → { status: 'deployed', url: 'http://...', phases: [...] }
```

### 4. Approval Workflows

Human-in-the-loop for sensitive operations:

- Define **policies** — which actions need approval and from whom
- Agents **request** approval when they hit a policy boundary
- Admins **approve or reject** from the dashboard or via API
- Supports **auto-approve** rules (e.g., "auto-approve emails to internal domains")
- **Escalation** — unreviewed requests escalate after a configurable timeout

```typescript
const approvals = new ApprovalEngine(db);

// Create a policy
await approvals.createPolicy({
  action: 'send_external_email',
  requiredRole: 'admin',
  autoApproveRules: [{ condition: 'recipient_domain', value: 'acme.com' }],
});

// Agent requests approval
const request = await approvals.request({
  agentId: 'agent-123',
  action: 'send_external_email',
  details: { to: 'client@external.com', subject: '...' },
});
// → { id: 'req-456', status: 'pending' }

// Admin approves
await approvals.decide(request.id, { approved: true, decidedBy: 'admin-1' });
```

### 5. Agent Lifecycle

State machine for agent lifecycle management:

```
  created → provisioning → running → paused → running
                                   → stopped → archived
                                   → error → running (auto-recovery)
```

- **Health checks** — periodic pings, response time tracking, error rate monitoring
- **Auto-recovery** — configurable restart attempts on failure
- **Usage tracking** — token consumption, API calls, cost estimation
- **Events** — every state transition logged with timestamp and reason

```typescript
const lifecycle = new AgentLifecycleManager(db);

// Get agent status
const agent = await lifecycle.getAgent('agent-123');
// → { state: 'running', health: { status: 'healthy', lastCheck: '...', uptime: 86400 }, usage: { tokens: 1500000, cost: 12.50 } }

// Pause an agent
await lifecycle.transition('agent-123', 'pause', { reason: 'Maintenance window' });

// Resume
await lifecycle.transition('agent-123', 'resume');
```

### 6. Knowledge Base

Document ingestion and retrieval for agent knowledge:

- **Upload documents** — PDF, Markdown, plain text, HTML
- **Chunking** — automatic splitting into retrievable segments
- **Search** — semantic search across knowledge bases
- **Per-agent or shared** — knowledge bases can be private or shared across agents

```typescript
const kb = new KnowledgeBaseEngine(db);

// Create a knowledge base
const base = await kb.create({ name: 'Company Policies', agentIds: ['agent-1', 'agent-2'] });

// Add a document
await kb.addDocument(base.id, { title: 'PTO Policy', content: '...', format: 'markdown' });

// Search
const results = await kb.search(base.id, 'how many vacation days');
// → [{ chunk: '...', score: 0.92, document: 'PTO Policy' }]
```

### 7. Multi-Tenant Isolation

Organizations, plans, and resource limits:

**Plan Tiers:**

| Feature | Free | Team | Enterprise | Self-Hosted |
|---------|------|------|-----------|-------------|
| Agents | 3 | 25 | Unlimited | Unlimited |
| Users | 1 | 10 | Unlimited | Unlimited |
| Knowledge Bases | 1 | 10 | Unlimited | Unlimited |
| SSO | No | No | Yes | Yes |
| Audit Retention | 7 days | 90 days | Unlimited | Unlimited |
| Custom Domain | No | Yes | Yes | Yes |
| White-Label | No | No | Yes | Yes |
| Support | Community | Email | Priority | Self-serve |

```typescript
const tenants = new TenantManager(db);

// Create an organization
const org = await tenants.createOrg({ name: 'Acme Inc', plan: 'team', adminEmail: 'admin@acme.com' });

// Check limits
const canCreate = await tenants.checkLimit(org.id, 'agents');
// → { allowed: true, current: 5, limit: 25 }

// Get usage
const usage = await tenants.getUsage(org.id);
// → { agents: 5, users: 3, knowledgeBases: 2, storageBytes: 10485760 }
```

### 8. Activity Tracking

Real-time monitoring of everything agents do:

- **Tool calls** — which tools, when, duration, success/failure
- **Conversations** — message count, token usage, cost
- **Timeline** — chronological view of all agent activity
- **Aggregations** — daily/weekly/monthly summaries

```typescript
const activity = new ActivityTracker(db);

// Record a tool call
await activity.recordToolCall({
  agentId: 'agent-123',
  tool: 'agenticmail_send',
  duration: 450,
  success: true,
  metadata: { to: 'user@example.com' },
});

// Get agent timeline
const timeline = await activity.getTimeline('agent-123', { limit: 50 });
// → [{ type: 'tool_call', tool: '...', timestamp: '...', ... }, ...]

// Get stats
const stats = await activity.getStats('agent-123', { period: 'day' });
// → { toolCalls: 142, conversations: 8, tokensUsed: 450000, estimatedCost: 3.75 }
```

### 9. Tool Catalog

Maps real OpenClaw and AgenticMail tool IDs to skills:

- **167 total tools** cataloged (63 OpenClaw core + 62 AgenticMail MCP + 42 shell commands)
- Each tool mapped to one or more skills
- Used by the Permission Engine to resolve skill → tool access

```typescript
import { ALL_TOOLS, getToolsBySkill, generateOpenClawToolPolicy } from '@agenticmail/enterprise';

// Get all tools for a skill
const emailTools = getToolsBySkill('email-management');
// → ['agenticmail_send', 'agenticmail_inbox', 'agenticmail_reply', ...]

// Generate OpenClaw tool policy
const policy = generateOpenClawToolPolicy(['email-management', 'web-search']);
// → { allow: ['agenticmail_send', ...], deny: [...] }
```

### 10. OpenClaw Hook

Middleware that integrates with OpenClaw's plugin system:

- **Permission enforcement** — checks every tool call against the agent's permission profile
- **Activity logging** — records tool calls to the activity tracker
- **Approval gating** — blocks tool calls that require approval
- **Permission caching** — avoids repeated DB lookups on high-frequency calls

```typescript
import { createEnterpriseHook } from '@agenticmail/enterprise';

const hook = createEnterpriseHook({
  apiUrl: 'http://localhost:3000',
  apiKey: 'ek_...',
  agentId: 'agent-123',
});

// In OpenClaw plugin:
// hook.beforeToolCall(toolName, args) → { allowed, requiresApproval, reason }
// hook.afterToolCall(toolName, result, duration) → void (logs activity)
```

### 11. AgenticMail Bridge

Connects the Engine to an existing AgenticMail instance:

- **Account sync** — creates/manages agent email accounts
- **Tool interception** — wraps AgenticMail tool calls with permission checks
- **Event forwarding** — pipes AgenticMail events (new email, task completion) to the activity tracker

```typescript
import { createAgenticMailBridge } from '@agenticmail/enterprise';

const bridge = createAgenticMailBridge({
  agenticmailUrl: 'http://localhost:3100',
  masterKey: 'mk_...',
});

// Sync an agent's email account
await bridge.ensureAgent({ name: 'support-bot', role: 'customer-support' });
```

---

## REST API

### Authentication

Two methods:

**JWT Token** (for dashboard users):
```
POST /auth/login
{ "email": "admin@acme.com", "password": "..." }
→ { "token": "eyJ...", "user": { ... } }

# Then:
Authorization: Bearer eyJ...
```

**API Key** (for programmatic access):
```
X-API-Key: ek_abc123...
```

API keys have scoped permissions and are created through the admin API.

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/agents` | List agents |
| POST | `/api/agents` | Create agent |
| GET | `/api/agents/:id` | Get agent details |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |
| GET | `/api/users` | List users |
| POST | `/api/users` | Create user |
| GET | `/api/audit` | Query audit log |
| POST | `/api/keys` | Create API key |
| DELETE | `/api/keys/:id` | Revoke API key |
| GET | `/api/settings` | Get company settings |
| PUT | `/api/settings` | Update settings |

### Engine Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/engine/skills` | List all 38 skills |
| GET | `/api/engine/skills/:id` | Get skill details + tools |
| GET | `/api/engine/presets` | List 5 permission presets |
| GET | `/api/engine/presets/:id` | Get preset details |
| POST | `/api/engine/check-permission` | Check tool permission |
| GET | `/api/engine/stats` | Engine statistics |
| POST | `/api/engine/generate-config` | Generate agent config files |
| POST | `/api/engine/deploy` | Deploy an agent |
| GET | `/api/engine/deployments` | List deployments |
| GET | `/api/engine/deployments/:id` | Deployment status |
| POST | `/api/engine/approvals` | Create approval request |
| GET | `/api/engine/approvals` | List pending approvals |
| PUT | `/api/engine/approvals/:id` | Approve/reject |
| GET | `/api/engine/agents/:id/lifecycle` | Agent lifecycle state |
| POST | `/api/engine/agents/:id/transition` | Trigger state transition |
| GET | `/api/engine/agents/:id/timeline` | Agent activity timeline |
| POST | `/api/engine/knowledge-bases` | Create knowledge base |
| POST | `/api/engine/knowledge-bases/:id/documents` | Add document |
| GET | `/api/engine/knowledge-bases/:id/search` | Search KB |
| GET | `/api/engine/tools` | Full tool catalog |
| POST | `/api/engine/tool-policy` | Generate tool policy for skills |

---

## Dashboard

The admin dashboard is a single HTML file using React 18 from CDN — no build step required. It includes:

- **Login page** with JWT authentication
- **Overview** with agent counts, activity stats, system health
- **Agent management** — create, configure, deploy, monitor
- **Audit log** — searchable, filterable event history
- **API key management** — create scoped keys, revoke
- **Settings** — company info, custom domain, plan management
- **Dark and light mode** themes

The dashboard is served automatically at `/dashboard` when the server starts. It communicates with the API using the same JWT/API key auth as any other client.

### Building Your Own Frontend

The dashboard is a reference implementation. You can build your own UI by hitting the REST API directly. Every API response follows a consistent format:

```json
{
  "data": { ... },
  "meta": { "total": 42, "page": 1, "limit": 20 }
}
```

Errors:
```json
{
  "error": "Description of what went wrong",
  "code": "VALIDATION_ERROR",
  "details": { ... }
}
```

---

## Deployment

### AgenticMail Cloud

Managed hosting on Fly.io infrastructure. Instant URL at `company.agenticmail.cloud`.

```bash
npx @agenticmail/enterprise
# → Select "AgenticMail Cloud"
# → Dashboard live at https://acme.agenticmail.cloud
```

Optional custom domain via CNAME:
```
agents.acme.com → acme.agenticmail.cloud
```

### Fly.io

Deploy to your own Fly.io account:

```bash
npx @agenticmail/enterprise
# → Select "Fly.io"
# → Generates fly.toml

fly launch --copy-config
fly secrets set DATABASE_URL="..." JWT_SECRET="..."
fly deploy
```

### Docker

Self-hosted with Docker Compose:

```bash
npx @agenticmail/enterprise
# → Select "Docker"
# → Generates docker-compose.yml

docker compose up -d
# → Dashboard at http://localhost:3000
```

### Local Development

Start immediately for testing:

```bash
npx @agenticmail/enterprise
# → Select "Local"
# → Server runs on http://localhost:3000
```

---

## Server Configuration

```typescript
import { createAdapter, createServer } from '@agenticmail/enterprise';

const db = await createAdapter({
  type: 'postgres',
  connectionString: 'postgresql://user:pass@host:5432/db',
});
await db.migrate();

const server = createServer({
  port: 3000,
  db,
  jwtSecret: 'your-secret-here',

  // Optional
  corsOrigins: ['https://app.acme.com'],
  rateLimit: 120,            // requests per minute per IP
  trustedProxies: ['10.0.0.0/8'],
  logging: true,
});

await server.start();
```

---

## Middleware

All middleware is exported for use in custom server setups:

| Middleware | Description |
|-----------|-------------|
| `requestIdMiddleware()` | Adds `X-Request-Id` header to every request |
| `requestLogger()` | Logs method, path, status, duration |
| `rateLimiter(opts)` | Per-IP rate limiting with configurable window |
| `securityHeaders()` | Sets security headers (CSP, HSTS, X-Frame-Options, etc.) |
| `errorHandler()` | Catches unhandled errors, returns JSON |
| `auditLogger(db)` | Logs all mutations to the audit trail |
| `requireRole(role)` | RBAC middleware — requires specific user role |
| `validate(schema)` | Request body validation |

---

## Resilience

Built-in resilience primitives:

| Component | Description |
|-----------|-------------|
| `CircuitBreaker` | Fails fast after N consecutive errors, auto-recovers after cooldown |
| `HealthMonitor` | Periodic health checks with configurable thresholds |
| `withRetry(fn, opts)` | Retry with exponential backoff |
| `RateLimiter` | Token bucket rate limiter |
| `KeyedRateLimiter` | Per-key rate limiting (e.g., per-user, per-IP) |

```typescript
import { CircuitBreaker, withRetry, HealthMonitor } from '@agenticmail/enterprise';

// Circuit breaker wrapping a database call
const breaker = new CircuitBreaker({ failureThreshold: 5, recoveryTimeMs: 30000 });
const result = await breaker.execute(() => db.query('SELECT ...'));

// Retry with backoff
const data = await withRetry(() => fetch('https://api.example.com'), {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
});
```

---

## Programmatic Usage

Use Enterprise as a library in your own application:

```typescript
import {
  // Database
  createAdapter,
  
  // Server
  createServer,
  
  // Engine
  PermissionEngine,
  BUILTIN_SKILLS,
  PRESET_PROFILES,
  AgentConfigGenerator,
  DeploymentEngine,
  ApprovalEngine,
  AgentLifecycleManager,
  KnowledgeBaseEngine,
  TenantManager,
  ActivityTracker,
  
  // Tool catalog
  ALL_TOOLS,
  getToolsBySkill,
  generateOpenClawToolPolicy,
  
  // Engine persistence
  EngineDatabase,
  
  // OpenClaw integration
  createEnterpriseHook,
  createAgenticMailBridge,
  
  // Resilience
  CircuitBreaker,
  withRetry,
  HealthMonitor,
  
  // Middleware (for custom servers)
  rateLimiter,
  auditLogger,
  requireRole,
} from '@agenticmail/enterprise';
```

---

## Security

- **JWT authentication** with configurable secret and expiry
- **API key authentication** with scoped permissions
- **RBAC** — owner, admin, member, viewer roles
- **Rate limiting** — per-IP, configurable limits
- **Audit logging** — every mutation logged with actor, action, resource, timestamp
- **Outbound email scanning** — inherited from AgenticMail core (blocks PII, credentials, secrets)
- **Security headers** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- **Input validation** — all API inputs validated before processing
- **Circuit breaker** — protects against cascading failures
- **Graceful shutdown** — clean connection teardown on SIGINT/SIGTERM

---

## Project Structure

```
packages/enterprise/src/
├── cli.ts                    # Setup wizard (npx entry point)
├── server.ts                 # Hono API server
├── index.ts                  # Public exports
│
├── setup/                    # Setup wizard modules
│   ├── index.ts              # Wizard orchestrator
│   ├── company.ts            # Step 1: Company info prompts
│   ├── database.ts           # Step 2: Database selection + config
│   ├── deployment.ts         # Step 3: Deployment target
│   ├── domain.ts             # Step 4: Custom domain
│   └── provision.ts          # Provisioning logic (DB, admin, deploy)
│
├── auth/
│   └── routes.ts             # Login, token refresh, password reset
│
├── admin/
│   └── routes.ts             # User/agent/key/audit CRUD
│
├── middleware/
│   └── index.ts              # All middleware exports
│
├── db/                       # Database adapters
│   ├── adapter.ts            # Abstract DatabaseAdapter
│   ├── factory.ts            # createAdapter() + getSupportedDatabases()
│   ├── sql-schema.ts         # Shared SQL DDL
│   ├── sqlite.ts
│   ├── postgres.ts
│   ├── mysql.ts
│   ├── mongodb.ts
│   ├── dynamodb.ts
│   └── turso.ts
│
├── engine/                   # Agent deployment platform
│   ├── index.ts              # Public API (re-exports)
│   ├── skills.ts             # 38 skills, 5 presets
│   ├── agent-config.ts       # Config generator
│   ├── deployer.ts           # Deployment engine
│   ├── approvals.ts          # Approval workflows
│   ├── lifecycle.ts          # Agent state machine
│   ├── knowledge.ts          # Knowledge base
│   ├── tenant.ts             # Multi-tenant manager
│   ├── activity.ts           # Activity tracker
│   ├── tool-catalog.ts       # Tool ID catalog
│   ├── openclaw-hook.ts      # OpenClaw integration
│   ├── agenticmail-bridge.ts # AgenticMail integration
│   ├── db-adapter.ts         # Engine DB persistence
│   ├── db-schema.ts          # Engine DDL + migrations
│   └── routes.ts             # Engine REST API
│
├── deploy/                   # Deployment configs
│   ├── managed.ts            # Cloud deploy + Docker/Fly/Railway generators
│   └── fly.ts                # Fly.io API client
│
├── dashboard/
│   └── index.html            # Admin UI (single HTML, React 18)
│
├── lib/
│   └── resilience.ts         # CircuitBreaker, HealthMonitor, Retry, RateLimiter
│
└── ui/                       # (future) Component library
```

---

## License

MIT — see [LICENSE](./LICENSE)
