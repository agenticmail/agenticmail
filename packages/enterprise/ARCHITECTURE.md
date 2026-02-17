# AgenticMail Enterprise Architecture

## Vision
Company installs `npx agenticmail-enterprise` → runs setup wizard → gets a cloud-hosted admin dashboard URL → manages AI agent identities, email, auth, compliance from that dashboard.

## Core Principles
1. **Cloud-first**: No local servers. Deploys to user's cloud or our managed infra.
2. **Bring your own database**: Support Postgres, MySQL, SQLite, MongoDB, DynamoDB, CockroachDB, PlanetScale, Turso, Supabase, Neon — anything.
3. **Bring your own cloud**: Deploy to Fly.io, Railway, Render, AWS, GCP, Azure, Vercel, or managed by us.
4. **Auto-provisioned URL**: Instant `<company>.agenticmail.cloud` subdomain, with custom domain support.
5. **Admin UI**: Web dashboard for agent CRUD, audit logs, rules, compliance.

## User Journey

```
$ npx agenticmail-enterprise

🏢 AgenticMail Enterprise Setup

? Company name: Acme Corp
? Admin email: admin@acme.com
? Database: (choose one)
  ▸ PostgreSQL (connection string)
    MySQL (connection string)
    MongoDB (connection string)
    SQLite (embedded)
    Turso (LibSQL)
    PlanetScale (MySQL-compatible)
    Supabase (Postgres)
    Neon (Postgres)
    DynamoDB (AWS)
    CockroachDB
    
? Database connection: postgresql://...
? Deploy to: (choose one)
  ▸ AgenticMail Cloud (managed, free tier)
    Fly.io
    Railway
    Render
    Docker (self-hosted)
    
? Custom domain (optional): mail.acme.com

⏳ Provisioning...
  ✓ Database schema created
  ✓ Admin account created  
  ✓ DKIM/SPF/DMARC configured
  ✓ Deployed to agenticmail.cloud
  
🎉 Your dashboard is live!
   URL: https://acme.agenticmail.cloud
   Admin: admin@acme.com (check email for password)
   
   Add custom domain later:
   CNAME mail.acme.com → acme.agenticmail.cloud
```

## Package Structure

```
@agenticmail/enterprise
├── src/
│   ├── index.ts              # CLI entry point
│   ├── setup/
│   │   ├── wizard.ts         # Interactive setup flow
│   │   ├── database.ts       # DB adapter factory
│   │   └── deploy.ts         # Cloud deployment orchestrator
│   ├── db/
│   │   ├── adapter.ts        # Abstract DB interface
│   │   ├── postgres.ts       # PostgreSQL adapter
│   │   ├── mysql.ts          # MySQL adapter
│   │   ├── mongodb.ts        # MongoDB adapter
│   │   ├── sqlite.ts         # SQLite adapter (dev/small teams)
│   │   ├── turso.ts          # Turso/LibSQL adapter
│   │   ├── dynamodb.ts       # DynamoDB adapter
│   │   └── migrations/       # Schema migrations (per adapter)
│   ├── auth/
│   │   ├── saml.ts           # SAML 2.0 SP
│   │   ├── oidc.ts           # OAuth 2.0 / OpenID Connect
│   │   ├── scim.ts           # SCIM provisioning
│   │   ├── api-keys.ts       # API key management
│   │   └── sessions.ts       # Session management
│   ├── admin/
│   │   ├── dashboard.ts      # Admin API routes
│   │   ├── agents.ts         # Agent CRUD
│   │   ├── audit.ts          # Audit log viewer
│   │   ├── rules.ts          # Email rules management
│   │   ├── compliance.ts     # DLP, retention policies
│   │   └── billing.ts        # Usage tracking, plans
│   ├── deploy/
│   │   ├── fly.ts            # Fly.io deployment
│   │   ├── railway.ts        # Railway deployment
│   │   ├── render.ts         # Render deployment
│   │   ├── docker.ts         # Docker/self-hosted
│   │   └── managed.ts        # AgenticMail Cloud (our infra)
│   ├── ui/                   # Admin dashboard (React/Next.js)
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx          # Dashboard home
│   │   │   ├── agents/           # Agent management
│   │   │   ├── audit/            # Audit logs
│   │   │   ├── settings/         # Company settings
│   │   │   ├── auth/             # SSO config
│   │   │   └── compliance/       # DLP, retention
│   │   └── components/
│   └── server.ts             # Express/Hono server (API + UI)
└── package.json
```

## Database Adapter Interface

```typescript
interface DatabaseAdapter {
  // Connection
  connect(config: DatabaseConfig): Promise<void>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;
  
  // Agents
  createAgent(agent: AgentInput): Promise<Agent>;
  getAgent(id: string): Promise<Agent | null>;
  listAgents(filters?: AgentFilters): Promise<Agent[]>;
  updateAgent(id: string, updates: Partial<Agent>): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;
  archiveAgent(id: string): Promise<DeletionReport>;
  
  // Email
  storeEmail(email: StoredEmail): Promise<void>;
  getEmail(uid: number): Promise<StoredEmail | null>;
  searchEmails(query: SearchQuery): Promise<StoredEmail[]>;
  
  // Audit
  logEvent(event: AuditEvent): Promise<void>;
  queryAuditLog(filters: AuditFilters): Promise<AuditEvent[]>;
  
  // Auth
  createUser(user: UserInput): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  
  // API Keys
  createApiKey(key: ApiKeyInput): Promise<ApiKey>;
  validateApiKey(key: string): Promise<ApiKey | null>;
  revokeApiKey(id: string): Promise<void>;
  
  // Rules & Compliance
  createRule(rule: RuleInput): Promise<Rule>;
  getRules(): Promise<Rule[]>;
  getRetentionPolicy(): Promise<RetentionPolicy>;
  setRetentionPolicy(policy: RetentionPolicy): Promise<void>;
}
```

## Deployment Architecture

### AgenticMail Cloud (Managed)
- Fly.io multi-region (us-east, eu-west, ap-southeast)
- Customer gets `<company>.agenticmail.cloud` subdomain
- Wildcard TLS via Fly.io
- Shared Fly.io org, isolated apps per customer
- Customer can add custom domain (CNAME → our subdomain)

### Self-Hosted
- Single Docker image: `docker run -p 3000:3000 agenticmail/enterprise`
- Or via CLI: `npx agenticmail-enterprise start`
- Env vars for DB connection, SMTP, domain

## Admin Dashboard Pages

1. **Dashboard** — Overview: active agents, emails sent/received, health
2. **Agents** — Create, edit, archive, delete. Role assignment. Email config per agent.
3. **Audit Log** — Who did what, when. Filterable, exportable.
4. **Authentication** — SAML/OIDC setup, user management, API keys
5. **Compliance** — DLP rules, retention policies, outbound guards
6. **Email Rules** — Server-side rules (auto-tag, auto-move, auto-reply)
7. **Settings** — Company info, domain, SMTP config, billing
8. **Integrations** — Slack, Teams, Discord notifications

## Pricing Tiers (Future)
- **Free**: 3 agents, 1K emails/mo, community support
- **Team**: 25 agents, 50K emails/mo, SSO, audit logs — $49/mo
- **Enterprise**: Unlimited, SCIM, DLP, retention, SLA, dedicated support — $299/mo
- **Self-Hosted**: Unlimited, your infra — $99/mo license
