# MR Agent

AI-powered code review service built with TypeScript + NestJS. Automatically reviews Pull Requests and Merge Requests using LLM providers, with support for GitHub (App & Webhook) and GitLab.

[中文文档](./README-zh.md)

## Table of Contents

- [Features](#features)
- [Review Triggers](#review-triggers)
- [Roadmap & Process Assets](#roadmap--process-assets)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Platform Integration](#platform-integration)
- [Commands](#commands)
- [Repository Policy](#repository-policy)
- [Observability](#observability)
- [Testing](#testing)
- [License](#license)

---

## Features

**Core Review**
- Automatic AI code review on PR open / update / merge
- Inline comments with GitHub Suggested Changes
- Report-mode summaries with risk assessment
- Incremental review (only new commits since last review)
- Mermaid change-structure diagrams in reports (directory/file visualization)
- Secret leak detection in diffs (lightweight regex-based scanning)
- Auto-labeling (bugfix / feature / refactor / docs / security)
- GitLab review-mode override via webhook header (`x-ai-mode: report|comment`)

**Interactive Commands**
- `/ai-review` — trigger manual review (comment or report mode)
- `/ask <question>` — multi-turn Q&A about the code
- `/checks [question]` — diagnose CI failures
- `/generate_tests [focus]` — generate test code
- `/changelog [--apply]` — generate or commit changelog
- `/describe [--apply]` — generate or update PR description
- `/improve [focus]` — force improvement-focused review output
- `/add_doc [focus]` (`/add-doc`) — documentation-only review suggestions
- `/reflect [goal]` — ask AI to generate requirement/acceptance clarifying questions
- `/similar_issue [query]` (`/similar-issue`) — find related issues in the same repository
- `/feedback` — provide learning signals to improve future reviews

**Process Guardrails**
- `.mr-agent.yml` per-repo policy (remind or enforce mode)
- Issue & PR template completeness checks
- GitHub Check integration for branch protection (`enforce` mode)
- Process guideline detection (`.github/.gitlab` workflows, templates, CODEOWNERS, CONTRIBUTING) with compliance suggestions
- Issue creation/edit pre-check and PR pre-merge validation (GitHub)

**Multi-Platform**
- GitHub App (recommended)
- Plain GitHub Webhook
- GitLab Webhook

**Multi-Provider AI**
- OpenAI
- OpenAI-compatible (DeepSeek, etc.)
- Anthropic (Claude)
- Google Gemini

### Review Triggers

| Trigger | Mode | Dedup Window |
|---|---|---|
| PR opened (`opened`) | comment / report (per config) | 5 min |
| PR updated (`synchronize`) | comment / report | 5 min (per new commit SHA) |
| PR edited (`edited`) | comment / report | 5 min |
| PR merged (`closed` + merged) | report | 24h (configurable) |
| `/ai-review` comment command | comment / report | 5 min |
| `/ai-review report` | report | 5 min |
| `/ai-review comment` | comment | 5 min |
| Webhook header `x-ai-mode` (GitLab only) | report / comment | 5 min |
| Issue created / edited | pre-check (GitHub) | — |
| PR created / edited / synced | pre-merge check (GitHub) | — |

### Roadmap & Process Assets

- Competitive gap backlog: `docs/roadmap/2026-02-19-competitive-gap-backlog.md`
- GitHub issue templates: `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`
- GitHub PR template: `.github/pull_request_template.md`
- GitLab issue templates: `.gitlab/issue_templates/Bug.md`, `.gitlab/issue_templates/Feature.md`
- GitLab MR template: `.gitlab/merge_request_templates/default.md`

**Recommended GitHub Flow baseline:**

1. Enable branch protection — require `MR Agent Policy` check and CI to pass.
2. Set `mode: enforce` in `.mr-agent.yml` (start with core repositories, then roll out).
3. Use standardized issue/PR templates to prevent missing requirements and test plans.

---

## Architecture

### High-Level Overview

```mermaid
graph TB
    subgraph Platforms
        GH_APP[GitHub App<br/>Probot]
        GH_WH[GitHub Webhook]
        GL_WH[GitLab Webhook]
    end

    subgraph NestJS Application
        direction TB
        CTRL[Controllers<br/>Route & Validate]
        SVC[Services<br/>Signature Verify & Dispatch]
        INT[Integration Layer<br/>GitHub / GitLab Adapters]
        RE[Review Engine<br/>AI Reviewer + Patch Parser]
        RR[Report Renderer<br/>Markdown + Suggestions]
    end

    subgraph External
        AI[AI Providers<br/>OpenAI / Anthropic / Gemini]
        GH_API[GitHub API]
        GL_API[GitLab API]
        NOTIFY[Notifications<br/>Slack / Discord / WeChat]
    end

    GH_APP -->|Webhook Event| CTRL
    GH_WH -->|Webhook Event| CTRL
    GL_WH -->|Webhook Event| CTRL
    CTRL --> SVC
    SVC --> INT
    INT --> RE
    RE -->|LLM Call| AI
    RE --> RR
    RR -->|Post Comment / Report| GH_API
    RR -->|Post Comment / Report| GL_API
    INT -.->|Optional| NOTIFY
```

### Request Processing Flow

```mermaid
sequenceDiagram
    participant P as Platform (GitHub/GitLab)
    participant C as Controller
    participant S as Service
    participant D as Deduplication
    participant I as Integration
    participant A as AI Reviewer
    participant R as Report Renderer

    P->>C: Webhook Event
    C->>S: Validate signature & parse payload
    S->>D: Check dedup (FNV hash, 5min window)
    alt Duplicate
        D-->>S: Skip (already processed)
    else New request
        D-->>S: Proceed
        S->>I: Dispatch to platform handler
        I->>I: Fetch diff, file contents, policy
        I->>A: Send context + diff to AI model
        A-->>I: Structured review result (Zod-validated)
        I->>R: Format report / inline comments
        R->>P: Post review via API
        I-->>P: Optional notification webhook
    end
```

### Module Dependency Graph

```mermaid
graph LR
    subgraph NestJS Modules
        APP[AppModule]
        GH[GithubModule]
        GL[GitlabModule]
        GHA[GithubAppModule]
    end

    subgraph Integration Layer
        GHR[github-review]
        GHW[github-webhook]
        GHP[github-policy]
        GHC[github-content]
        GLR[gitlab-review]
        NTF[notification]
    end

    subgraph Core
        REV[ai-reviewer]
        PAT[patch parser]
        RPT[report-renderer]
        POL[review-policy]
        DDP[dedupe]
        HTTP[http client]
        STA[runtime-state]
        SEC[secret-patterns]
        CACHE[cache]
    end

    APP --> GH
    APP --> GL
    APP --> GHA

    GH --> GHR
    GH --> GHW
    GHA --> GHR

    GHR --> GHP
    GHR --> GHC
    GHR --> REV
    GHR --> RPT
    GHR --> NTF

    GLR --> REV
    GLR --> RPT
    GLR --> NTF
    GL --> GLR

    REV --> PAT
    REV --> POL
    REV --> HTTP

    GHR --> DDP
    GLR --> DDP
    DDP --> STA
    GHR --> SEC
    GLR --> SEC
    GHP --> CACHE
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (Alpine) |
| Language | TypeScript 5.7 (ES2022, strict mode) |
| Framework | NestJS 11 |
| HTTP Server | Express 4 |
| GitHub App | Probot 13 |
| AI Client | OpenAI SDK 4 (also used for compatible providers) |
| Validation | Zod 3 |
| State Store | In-memory / JSON file / SQLite (Node.js built-in `node:sqlite`) |
| Container | Docker (multi-stage build) |

---

## Project Structure

```
mr-agent/
├── src/
│   ├── main.ts                     # NestJS bootstrap & server startup
│   ├── app.module.ts               # Root module (imports all sub-modules)
│   ├── app.controller.ts           # Health, metrics, replay endpoints
│   ├── app.ts                      # Probot event handlers (GitHub App)
│   │
│   ├── core/                       # Shared infrastructure
│   │   ├── cache.ts                #   TTL-based in-memory cache
│   │   ├── dedupe.ts               #   FNV hash request deduplication
│   │   ├── env.ts                  #   Environment variable helpers
│   │   ├── errors.ts               #   Typed error classes (4xx/5xx)
│   │   ├── http.ts                 #   HTTP client with retry & backoff
│   │   ├── i18n.ts                 #   Locale detection (zh/en)
│   │   ├── rate-limit.ts           #   Per-scope rate limiting
│   │   ├── runtime-state.ts        #   Pluggable state backend
│   │   └── secret-patterns.ts      #   Regex-based secret detection
│   │
│   ├── review/                     # AI review domain
│   │   ├── ai-reviewer.ts          #   Multi-provider AI abstraction
│   │   ├── patch.ts                #   Git diff parsing & line mapping
│   │   ├── report-renderer.ts      #   Markdown report formatting
│   │   ├── review-policy.ts        #   Zod schemas & policy config
│   │   └── review-types.ts         #   Data models
│   │
│   ├── integrations/
│   │   ├── github/                 #   GitHub review, policy, content
│   │   ├── gitlab/                 #   GitLab review & command handling
│   │   └── notify/                 #   Webhook notifications
│   │
│   ├── modules/
│   │   ├── github/                 #   NestJS GitHub Webhook module
│   │   ├── gitlab/                 #   NestJS GitLab Webhook module
│   │   ├── github-app/             #   NestJS GitHub App module (Probot)
│   │   └── webhook/                #   Health, metrics, shutdown, replay
│   │
│   └── common/
│       └── filters/
│           └── http-error.filter.ts  # Global exception filter
│
├── tests/                          # Node.js test runner (20+ test files)
├── README-zh.md                    # Chinese version of this documentation
├── docs/                           # Design docs & roadmap
├── Dockerfile                      # Multi-stage Docker build
├── docker-compose.yml              # Docker Compose setup
├── .env.example                    # Full env var reference
├── .env.github-app.min.example     # Minimal GitHub App config
└── .env.github-webhook.min.example # Minimal GitHub Webhook config
```

### Path Aliases

The project uses Node.js ESM subpath imports (configured in both `tsconfig.json` and `package.json`):

| Alias | Maps to |
|---|---|
| `#core` | `src/core/index.ts` |
| `#review` | `src/review/index.ts` |
| `#integrations/github` | `src/integrations/github/index.ts` |
| `#integrations/gitlab` | `src/integrations/gitlab/index.ts` |
| `#integrations/notify` | `src/integrations/notify/index.ts` |

---

## Getting Started

### Prerequisites

- Node.js >= 22
- npm

### Local Development

```bash
# Install dependencies
npm install

# Start dev server (with tsx hot-reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

The server listens on port `3000` by default (configurable via `PORT`).

### Health Check

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health?deep=true   # Tests AI provider connectivity
curl http://localhost:3000/github/health       # GitHub config status
curl http://localhost:3000/gitlab/health       # GitLab config status
```

---

## Configuration

### Environment Variables

Copy `.env.example` and fill in the required values. Minimal configs are also available:

- `.env.github-app.min.example` — GitHub App minimum
- `.env.github-webhook.min.example` — Plain GitHub Webhook minimum

### AI Provider

```mermaid
graph LR
    ENV[AI_PROVIDER env var]
    ENV -->|openai| OAI[OpenAI<br/>OPENAI_API_KEY + OPENAI_MODEL]
    ENV -->|openai-compatible| OC[OpenAI-Compatible<br/>OPENAI_BASE_URL + OPENAI_COMPATIBLE_MODEL]
    ENV -->|anthropic| ANT[Anthropic<br/>ANTHROPIC_API_KEY + ANTHROPIC_MODEL]
    ENV -->|gemini| GEM[Gemini<br/>GEMINI_API_KEY + GEMINI_MODEL]
```

**OpenAI (default)**
```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

**OpenAI-Compatible (e.g., DeepSeek)**
```env
AI_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=deepseek-chat
```

**Anthropic**
```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-haiku-latest
ANTHROPIC_MAX_TOKENS=8192
```

**Gemini**
```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
```

### State Persistence

| Backend | Env Value | Use Case |
|---|---|---|
| Memory | `memory` (default) | Stateless containers, dev |
| JSON File | `file` | Simple single-instance |
| SQLite | `sqlite` (recommended) | Production single-instance |

```env
RUNTIME_STATE_BACKEND=sqlite
RUNTIME_STATE_SQLITE_FILE=/data/mr-agent/runtime-state.sqlite3
```

### Notifications (Optional)

Supports WeChat (WeCom), Slack, Discord, and generic JSON webhooks:

```env
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/...
NOTIFY_WEBHOOK_FORMAT=slack   # wecom | slack | discord | generic
```

### Key Tuning Parameters

**Global runtime and command limits**

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_BODY_LIMIT` | `1mb` | Global Express body-parser limit for webhook requests (returns `413` when exceeded) |
| `COMMAND_RATE_LIMIT_MAX` | `10` | Max command invocations per user per PR/MR per window |
| `COMMAND_RATE_LIMIT_WINDOW_MS` | `3600000` (1h) | Command rate-limit window |

**GitHub-specific**

| Variable | Default | Description |
|---|---|---|
| `GITHUB_MERGED_DEDUPE_TTL_MS` | `86400000` (24h) | Dedup window for merged + report events |
| `GITHUB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000` (30d) | Feedback signal retention window |
| `GITHUB_INCREMENTAL_STATE_TTL_MS` | `604800000` (7d) | Incremental review SHA cache lifetime |
| `GITHUB_POLICY_CONFIG_CACHE_TTL_MS` | `300000` (5min) | `.mr-agent.yml` cache for policy/review behavior |
| `GITHUB_POLICY_COMMENT_DEDUPE_TTL_MS` | `600000` (10min) | Dedup window for policy reminder comments |
| `GITHUB_WEBHOOK_MAX_BODY_BYTES` | `10485760` (10MB) | Extra hard cap for `/github/trigger` payload size |
| `GITHUB_WEBHOOK_SKIP_SIGNATURE` | `false` | Debug-only signature bypass; forbidden when `NODE_ENV=production` |

**GitLab-specific**

| Variable | Default | Description |
|---|---|---|
| `GITLAB_MERGED_DEDUPE_TTL_MS` | `86400000` (24h) | Merged + report event dedup window |
| `GITLAB_INCREMENTAL_STATE_TTL_MS` | `604800000` (7d) | Incremental review SHA cache |
| `GITLAB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000` (30d) | Feedback learning signal retention |
| `GITLAB_POLICY_CONFIG_CACHE_TTL_MS` | `300000` (5min) | `.mr-agent.yml` policy cache |
| `GITLAB_CHANGELOG_PATH` | `CHANGELOG.md` | File path for `/changelog --apply` |
| `GITLAB_WEBHOOK_MAX_BODY_BYTES` | `10485760` (10MB) | Extra hard cap for `/gitlab/trigger` payload size |
| `GITLAB_REQUIRE_WEBHOOK_SECRET` | `false` | Require `GITLAB_WEBHOOK_SECRET`, otherwise reject unsigned webhooks |
| `ALLOW_INSECURE_GITLAB_HTTP` | `false` | Allow `http://` GitLab base URL for local testing only |

**Tuning guidance:**

- `MERGED_DEDUPE_TTL_MS` — Controls the dedup window for `merged + report` events to prevent duplicate reviews on webhook retries. Increase to `48h–72h` if you experience frequent webhook redelivery; decrease to `1h–6h` if you need faster re-trigger. This only affects merged auto-triggers; manual `/ai-review` commands use the short (5 min) dedup window.
- `FEEDBACK_SIGNAL_TTL_MS` — Controls how long `/feedback` and review-thread resolved/unresolved signals are retained. Increase to `60–90d` for teams with slower review cadence; decrease to `7–14d` if review rules change frequently.
- `COMMAND_RATE_LIMIT_*` — Controls abuse protection for comment commands. Increase limits for very active repos; lower limits if bots/users spam command threads.

See `.env.example` for the baseline variable reference; advanced runtime knobs are listed above.

---

## Deployment

### Docker (Recommended)

```mermaid
graph LR
    subgraph Docker Build
        B1[Stage 1: Build<br/>node:22-alpine<br/>npm ci + tsc]
        B2[Stage 2: Runtime<br/>node:22-alpine<br/>prod deps only]
        B1 -->|COPY dist/| B2
    end
    B2 -->|Expose 3000| SRV[mr-agent container]
```

**Build & Run**

```bash
docker build -t mr-agent:latest .
docker run -d \
  --name mr-agent \
  -p 3000:3000 \
  --env-file .env \
  -v ./data:/data \
  mr-agent:latest
```

### Docker Compose

```bash
# Start
docker compose up -d --build

# View logs
docker compose logs -f mr-agent

# Restart
docker compose restart mr-agent

# Stop
docker compose down
```

The `docker-compose.yml` mounts:
- `./data:/data` — persistent state (SQLite, event store)
- `./secrets/github-app.private-key.pem:/run/secrets/github-app-private-key.pem:ro` — GitHub App private key

### Production Deployment Checklist

```mermaid
graph TD
    A[Choose Platform Mode] -->|GitHub App| B1[Create GitHub App]
    A -->|Plain Webhook| B2[Generate PAT Token]
    A -->|GitLab| B3[Generate API Token]

    B1 --> C[Configure AI Provider]
    B2 --> C
    B3 --> C

    C --> D[Set State Backend = sqlite]
    D --> E[Deploy Container]
    E --> F[Configure Webhook URL]
    F --> G[Verify Health Endpoints]
    G --> H[Test with /ai-review Command]
```

1. **Choose integration mode** — GitHub App is recommended for fine-grained permissions
2. **Configure AI provider** — Set `AI_PROVIDER` and the corresponding API key / model
3. **Enable state persistence** — Use `RUNTIME_STATE_BACKEND=sqlite` for production
4. **Deploy the container** — Docker, Docker Compose, Render, Railway, Fly.io, or K8s
5. **Set webhook URL** on your platform:
   - GitHub App: `https://<domain>/api/github/webhooks`
   - GitHub Webhook: `https://<domain>/github/trigger`
   - GitLab: `https://<domain>/gitlab/trigger`
6. **Verify** via health endpoints and a test `/ai-review` comment

### Quick Deployment Reference

This is a compact deployment path for Render/Railway/Fly.io/Docker/K8s.

1. **Choose mode**
   - GitHub App (recommended)
   - Plain GitHub Webhook
   - Optional GitLab Webhook
2. **Use minimal environment variables**

**GitHub App minimum (`.env.github-app.min.example`)**

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
WEBHOOK_SECRET=replace-with-webhook-secret
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

**Plain GitHub Webhook minimum (`.env.github-webhook.min.example`)**

```env
GITHUB_WEBHOOK_SECRET=replace-with-webhook-secret
GITHUB_WEBHOOK_TOKEN=replace-with-github-token
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

**Recommended single-instance extras**

```env
RUNTIME_STATE_BACKEND=sqlite
RUNTIME_STATE_SQLITE_FILE=/data/mr-agent/runtime-state.sqlite3
WEBHOOK_EVENT_STORE_ENABLED=false
WEBHOOK_REPLAY_ENABLED=false
```

**Temporary replay settings for debugging**

```env
WEBHOOK_EVENT_STORE_ENABLED=true
WEBHOOK_REPLAY_ENABLED=true
WEBHOOK_REPLAY_TOKEN=replace-with-strong-random-token
```

3. **Start application**

```bash
npm install
npm run build
npm start
```

Server listens on `PORT` (default `3000`).

4. **Configure webhook addresses**
   - GitHub App: `https://<domain>/api/github/webhooks`
   - GitHub Webhook: `https://<domain>/github/trigger`
   - GitLab Webhook: `https://<domain>/gitlab/trigger`
5. **GitLab recommended headers**
   - `x-ai-mode: report|comment`
   - `x-gitlab-api-token: <api token>`
   - `x-gitlab-token: <webhook secret>` (only when `GITLAB_WEBHOOK_SECRET` is configured)
6. **Docker one-liner**

```bash
docker build -t mr-agent:latest .
docker run -d --name mr-agent -p 3000:3000 --env-file .env mr-agent:latest
```

7. **Verification checklist**
   - `GET /health`
   - `GET /github/health`
   - `GET /gitlab/health`
   - `GET /metrics`
   - Test PR/MR commands: `/ai-review`, `/ai-review comment`
   - Webhook failure response includes structured fields: `error/type/status/path/method/timestamp`

If replay is enabled:
- `GET /webhook/events`
- `POST /github/replay/:eventId`
- `POST /gitlab/replay/:eventId`
- Header: `x-mr-agent-replay-token: <WEBHOOK_REPLAY_TOKEN>`

### Nginx Reverse Proxy

There is no committed `deploy/nginx/` sample in this repository; use the snippet below as a baseline:

```nginx
server {
    listen 443 ssl;
    server_name mr-agent.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Platform Integration

### GitHub App (Recommended)

1. Create a GitHub App with the following permissions:
   - **Pull requests**: Read & write
   - **Issues**: Read & write
   - **Contents**: Read & write (required for `/changelog --apply`)
   - **Checks**: Read & write (required for `mode=enforce`)
   - **Metadata**: Read-only
2. Subscribe to events:
   - `Pull request` (`opened` / `edited` / `synchronize` / `closed`)
   - `Issues` (`opened` / `edited`)
   - `Issue comment`
   - `Pull request review thread` (`resolved` / `unresolved`, for feedback learning)
3. Set webhook URL to `https://<domain>/api/github/webhooks`
4. Configure environment variables:

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
WEBHOOK_SECRET=your-webhook-secret
```

> If `APP_ID` + `PRIVATE_KEY` (+ `WEBHOOK_SECRET`) are not configured, GitHub App mode is automatically disabled; plain webhook mode remains available.

### Plain GitHub Webhook

1. In repo Settings > Webhooks, add `https://<domain>/github/trigger`
2. Set content type to `application/json`
3. Select events: `Pull requests`, `Issues`, `Issue comments`, `Pull request review threads`
4. Configure:

```env
GITHUB_WEBHOOK_SECRET=your-secret
GITHUB_WEBHOOK_TOKEN=ghp_...    # PAT with repo scope (falls back to GITHUB_TOKEN)
```

Optional debug-only switch:

```env
GITHUB_WEBHOOK_SKIP_SIGNATURE=false
```

> `GITHUB_WEBHOOK_SKIP_SIGNATURE=true` is rejected in production (`NODE_ENV=production`).

### GitLab Webhook

1. In project Settings > Webhooks, add `https://<domain>/gitlab/trigger`
2. Select triggers:
   - `Merge request events` (open / reopen / update / merge)
   - `Note events` (for comment commands: `/ai-review`, `/ask`, `/checks`, `/describe`, `/generate_tests`, `/changelog`, `/improve`, `/add_doc`, `/reflect`, `/similar_issue`, `/feedback`)
3. Optionally add secret token
4. Configure:

```env
GITLAB_TOKEN=glpat-...
GITLAB_WEBHOOK_SECRET=your-secret    # Optional
GITLAB_REQUIRE_WEBHOOK_SECRET=false  # Optional hard-enforcement switch
```

GitLab-specific headers:
- `x-ai-mode: report|comment` — override review mode
- `x-gitlab-api-token: <token>` — per-request API token (recommended)
- `x-gitlab-token` — webhook signature verification (only when `GITLAB_WEBHOOK_SECRET` is set)
- `x-push-url` / `x-qwx-robot-url` — optional notification webhook override

> **Compatibility**: When `GITLAB_WEBHOOK_SECRET` is not configured, `x-gitlab-token` is used as the API token instead of for signature verification.

---

## Commands

All commands are triggered via PR/MR comments:

| Command | Description |
|---|---|
| `/ai-review` | Trigger AI review (defaults to `report` when no mode is provided) |
| `/ai-review report` | Force report mode (summary comment) |
| `/ai-review comment` | Force comment mode (inline comments) |
| `/ai-review --mode=report` / `--mode=comment` | Flag-style mode override (same effect as positional mode) |
| `/ask <question>` | Ask about the PR code (multi-turn conversation) |
| `/checks [question]` | Analyze CI check failures |
| `/generate_tests [focus]` | Generate test code for changes |
| `/changelog [focus]` | Generate changelog entry |
| `/changelog --apply [focus]` | Generate and commit changelog to repo |
| `/describe` | Generate PR/MR description |
| `/describe --apply` | Generate and update PR/MR description |
| `/improve [focus]` | Run review in improvement-only mode |
| `/add_doc [focus]` / `/add-doc [focus]` | Generate documentation-only suggestions |
| `/reflect [goal]` | Generate clarifying requirement/acceptance questions |
| `/similar_issue [query]` / `/similar-issue [query]` | Search related issues in the same repository |
| `/feedback resolved\|dismissed\|up\|down [note]` | Provide review quality feedback |

Additional aliases are supported, for example: `/ai-review ask ...`, `/ai-review checks ...`, `/ai-review generate-tests ...`, `/ai-review add-doc ...`.
Policy toggles in `.mr-agent.yml` exist for `/describe`, `/ask`, `/checks`, `/generate_tests`, `/changelog`, `/feedback`; `/reflect` depends on `askCommandEnabled`.

---

## Repository Policy

Add `.mr-agent.yml` to the repository root to configure per-repo behavior:

```yaml
mode: remind          # remind = comment only, enforce = fail GitHub Check

issue:
  enabled: true
  minBodyLength: 20
  requiredSections:
    - Summary
    - Steps to Reproduce
    - Expected Behavior

pullRequest:
  enabled: true
  minBodyLength: 20
  requireLinkedIssue: false
  requiredSections:
    - Summary
    - Test Plan

review:
  enabled: true
  mode: comment         # comment | report
  onOpened: true        # Review on PR open
  onEdited: false
  onSynchronize: true   # Review on new commits
  describeEnabled: true
  describeAllowApply: false
  checksCommandEnabled: true
  includeCiChecks: true
  askCommandEnabled: true
  generateTestsCommandEnabled: true
  changelogCommandEnabled: true
  changelogAllowApply: false
  feedbackCommandEnabled: true
  secretScanEnabled: true
  autoLabelEnabled: true
  secretScanCustomPatterns:  # optional extra secret regex patterns
    - "(?i)my_internal_token_[a-z0-9]{16,}"
  customRules:
    - All public APIs must have type annotations
    - No new `any` types allowed
```

GitLab currently reads only the `review:` section from `.mr-agent.yml`. Top-level `mode`, `issue`, and `pullRequest` checks are enforced in GitHub policy flows.

**Modes:**
- `remind` — posts a comment noting missing fields; does not block merge
- `enforce` — creates a failing GitHub Check (`MR Agent Policy`) that can be required in branch protection rules

**Template fallback behavior:**
- When `requiredSections` is not configured, section headings are automatically extracted from repository templates:
  - Issue: `.github/ISSUE_TEMPLATE/*` or `.github/ISSUE_TEMPLATE.md`
  - PR: `.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE.md`
- If no templates exist, built-in defaults are used (Issue: `Summary / Steps to Reproduce / Expected Behavior`; PR: `Summary / Test Plan / Related Issue`).

**Review field reference:**

| Field | Description |
|---|---|
| `enabled` / `mode` | Enable AI review and set default mode (comment / report) |
| `onOpened` / `onEdited` / `onSynchronize` | Control which PR events auto-trigger review |
| `describeEnabled` | Enable `/describe` command |
| `describeAllowApply` | Allow `/describe --apply` to directly update PR description |
| `checksCommandEnabled` | Enable `/checks` command |
| `includeCiChecks` | Include CI check results in AI context |
| `askCommandEnabled` | Enable `/ask` command |
| `generateTestsCommandEnabled` | Enable `/generate_tests` command |
| `changelogCommandEnabled` | Enable `/changelog` command |
| `changelogAllowApply` | Allow `/changelog --apply` to commit directly to the repo |
| `feedbackCommandEnabled` | Enable `/feedback` command |
| `secretScanEnabled` | Scan diffs for potential secret leaks and post security warnings |
| `secretScanCustomPatterns` | Additional repository-specific secret regex patterns |
| `autoLabelEnabled` | Auto-add PR labels based on change content |
| `customRules` | Team-specific review rules (natural language); enforced in both reviews and Q&A |

---

## Observability

### Metrics

Prometheus-format metrics are exposed at `GET /metrics`:

- `mr_agent_webhook_requests_total` — webhook request count by platform & event
- `mr_agent_webhook_results_total` — results by platform & outcome (ok/error)
- `mr_agent_webhook_replay_total` — replay execution outcomes
- `mr_agent_webhook_store_writes_total` — persisted debug-event write count
- `mr_agent_webhook_store_trim_total` — debug-event store trim operations
- `mr_agent_health_checks_total` — health endpoint call count
- `mr_agent_http_errors_total` — global HTTP error count
- `mr_agent_process_uptime_seconds` — process uptime
- `mr_agent_ai_requests_active` — active AI request count
- `mr_agent_ai_wait_queue_size` — queued AI request count
- `mr_agent_ai_shutdown_requested` — AI shutdown flag (0/1)
- `mr_agent_runtime_state_backend_info{backend=...}` — selected runtime-state backend info gauge

### Health Checks

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /health?deep=true` | Deep check (AI provider connectivity) |
| `GET /github/health` | GitHub webhook config validation |
| `GET /gitlab/health` | GitLab webhook config validation |

### Error Handling

Webhook errors return structured JSON:

```json
{
  "ok": false,
  "error": "Detailed error message",
  "type": "BadWebhookRequestError",
  "status": 400,
  "path": "/github/trigger",
  "method": "POST",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Payloads exceeding `WEBHOOK_BODY_LIMIT` (default `1mb`) return `413 Payload Too Large`.

### Webhook Replay (Debug)

Enable temporarily for debugging:

```env
WEBHOOK_EVENT_STORE_ENABLED=true
WEBHOOK_REPLAY_ENABLED=true
WEBHOOK_REPLAY_TOKEN=your-secret-token
```

Endpoints (require `x-mr-agent-replay-token` header):
- `GET /webhook/events` — list stored events
- `POST /github/replay/:eventId` — replay a GitHub event
- `POST /gitlab/replay/:eventId` — replay a GitLab event

### Resilience

- **HTTP Retry**: exponential backoff (2 retries, 400ms base delay) on 408/429/5xx
- **Deduplication**: FNV hash with 5-min window (24h for merged events)
- **Rate Limiting**: per-scope limits to prevent API abuse
- **Graceful Shutdown**: drains in-flight requests on SIGTERM/SIGINT

---

## Testing

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage

# Type check only
npm run check
```

Tests use the Node.js built-in test runner (`node:test`). Coverage includes:
- AI concurrency control
- Cache & dedup behavior
- Diff parsing & hunk prioritization
- GitHub/GitLab integration logic
- HTTP retry & error handling
- Policy validation
- Notification adapters
- NestJS module wiring

---

## License

Private — see repository for details.
