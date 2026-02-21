# MR Agent

基于 TypeScript + NestJS 构建的 AI 代码评审服务。通过 LLM 自动评审 Pull Request 和 Merge Request，支持 GitHub（App 与 Webhook）及 GitLab。

[English README](./README.md)

## 目录

- [功能特性](#功能特性)
- [评审触发](#评审触发)
- [路线图与流程资产](#路线图与流程资产)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [部署指南](#部署指南)
- [平台接入](#平台接入)
- [评论命令](#评论命令)
- [仓库策略配置](#仓库策略配置)
- [可观测性](#可观测性)
- [测试](#测试)
- [许可证](#许可证)

---

## 功能特性

**核心评审**
- PR 打开 / 更新 / 合并时自动 AI 代码评审
- 行内评论，支持 GitHub Suggested Changes 建议代码块
- Report 模式汇总评审，含风险等级评估
- 增量评审（仅评审上次评审后的新提交）
- 报告内 Mermaid 变更结构图（按目录/文件可视化）
- Diff 中疑似密钥泄露检测（轻量正则扫描）
- 自动标签（bugfix / feature / refactor / docs / security）
- GitLab 可通过 Webhook Header 指定评审模式（`x-ai-mode: report|comment`）

**交互命令**
- `/ai-review` — 手动触发评审（comment 或 report 模式）
- `/ask <问题>` — 多轮代码问答
- `/checks [问题]` — CI 失败诊断分析
- `/generate_tests [重点]` — 自动生成测试代码
- `/changelog [--apply]` — 生成或提交 Changelog
- `/describe [--apply]` — 生成或更新 PR 描述
- `/improve [重点]` — 仅输出改进建议导向的评审
- `/add_doc [重点]`（`/add-doc`）— 仅输出文档/注释改进建议
- `/reflect [目标]` — 生成需求澄清与验收标准问题
- `/similar_issue [关键词]`（`/similar-issue`）— 检索同仓库相似 Issue
- `/feedback` — 评审质量反馈，持续优化后续评审

**流程守卫**
- `.mr-agent.yml` 仓库级策略（提醒 / 强制模式）
- Issue 与 PR 模板完整性检查
- GitHub Check 集成，可接 Branch Protection（`enforce` 模式）
- `.github/.gitlab` 模板/流程文件识别（workflow/template/CODEOWNERS/CONTRIBUTING）并给出流程建议
- Issue 创建/编辑时流程预检、PR 创建/编辑/同步时合并前预检（GitHub）

**多平台支持**
- GitHub App（推荐）
- 普通 GitHub Webhook
- GitLab Webhook

**多模型 Provider**
- OpenAI
- OpenAI 兼容（DeepSeek 等）
- Anthropic（Claude）
- Google Gemini

### 评审触发

| 触发方式 | 评审模式 | 去重窗口 |
|---|---|---|
| PR 打开（`opened`） | comment / report（按配置） | 5 分钟 |
| PR 更新（`synchronize`） | comment / report | 5 分钟（按新 commit SHA） |
| PR 编辑（`edited`） | comment / report | 5 分钟 |
| PR 合并（`closed` + merged） | report | 24 小时（可配置） |
| `/ai-review` 评论命令 | comment / report | 5 分钟 |
| `/ai-review report` | report | 5 分钟 |
| `/ai-review comment` | comment | 5 分钟 |
| Webhook Header `x-ai-mode`（仅 GitLab） | report / comment | 5 分钟 |
| Issue 创建 / 编辑 | 流程预检（GitHub） | — |
| PR 创建 / 编辑 / 同步 | 合并前预检（GitHub） | — |

### 路线图与流程资产

- 竞争差距落地 backlog：`docs/roadmap/2026-02-19-competitive-gap-backlog.md`
- GitHub Issue 模板：`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`
- GitHub PR 模板：`.github/pull_request_template.md`
- GitLab Issue 模板：`.gitlab/issue_templates/Bug.md`、`.gitlab/issue_templates/Feature.md`
- GitLab MR 模板：`.gitlab/merge_request_templates/default.md`

**建议的 GitHub Flow 基线：**

1. 开启 Branch Protection，至少要求 `MR Agent Policy` 与 CI 必过。
2. 在仓库启用 `.mr-agent.yml` 的 `mode: enforce`（可先从核心仓库灰度）。
3. 统一使用 Issue/PR 模板，避免需求与验证信息缺失。

---

## 系统架构

### 整体架构

```mermaid
graph TB
    subgraph 平台入口
        GH_APP[GitHub App<br/>Probot]
        GH_WH[GitHub Webhook]
        GL_WH[GitLab Webhook]
    end

    subgraph NestJS 应用
        direction TB
        CTRL[Controllers<br/>路由 & 校验]
        SVC[Services<br/>签名验证 & 分发]
        INT[集成层<br/>GitHub / GitLab 适配器]
        RE[评审引擎<br/>AI Reviewer + Patch 解析]
        RR[报告渲染器<br/>Markdown + 建议代码块]
    end

    subgraph 外部服务
        AI[AI Providers<br/>OpenAI / Anthropic / Gemini]
        GH_API[GitHub API]
        GL_API[GitLab API]
        NOTIFY[通知推送<br/>Slack / Discord / 企业微信]
    end

    GH_APP -->|Webhook 事件| CTRL
    GH_WH -->|Webhook 事件| CTRL
    GL_WH -->|Webhook 事件| CTRL
    CTRL --> SVC
    SVC --> INT
    INT --> RE
    RE -->|LLM 调用| AI
    RE --> RR
    RR -->|发布评论 / 报告| GH_API
    RR -->|发布评论 / 报告| GL_API
    INT -.->|可选| NOTIFY
```

### 请求处理流程

```mermaid
sequenceDiagram
    participant P as 平台 (GitHub/GitLab)
    participant C as Controller
    participant S as Service
    participant D as 去重模块
    participant I as 集成层
    participant A as AI 评审引擎
    participant R as 报告渲染器

    P->>C: Webhook 事件
    C->>S: 验证签名 & 解析请求体
    S->>D: 去重检查（FNV 哈希，5 分钟窗口）
    alt 重复请求
        D-->>S: 跳过（已处理过）
    else 新请求
        D-->>S: 放行
        S->>I: 分发到平台处理器
        I->>I: 获取 diff、文件内容、策略配置
        I->>A: 发送上下文 + diff 给 AI 模型
        A-->>I: 结构化评审结果（Zod 校验）
        I->>R: 格式化报告 / 行内评论
        R->>P: 通过 API 发布评审
        I-->>P: 可选：通知 Webhook
    end
```

### 模块依赖关系

```mermaid
graph LR
    subgraph NestJS 模块
        APP[AppModule]
        GH[GithubModule]
        GL[GitlabModule]
        GHA[GithubAppModule]
    end

    subgraph 集成层
        GHR[github-review]
        GHW[github-webhook]
        GHP[github-policy]
        GHC[github-content]
        GLR[gitlab-review]
        NTF[notification]
    end

    subgraph 核心层
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

## 技术栈

| 层级 | 技术 |
|---|---|
| 运行时 | Node.js 22 (Alpine) |
| 语言 | TypeScript 5.7（ES2022，严格模式） |
| 框架 | NestJS 11 |
| HTTP 服务 | Express 4 |
| GitHub App | Probot 13 |
| AI 客户端 | OpenAI SDK 4（同时用于兼容 Provider） |
| 校验 | Zod 3 |
| 状态存储 | 内存 / JSON 文件 / SQLite（Node.js 内置 `node:sqlite`） |
| 容器 | Docker（多阶段构建） |

---

## 项目结构

```
mr-agent/
├── src/
│   ├── main.ts                     # NestJS 启动入口
│   ├── app.module.ts               # 根模块（导入所有子模块）
│   ├── app.controller.ts           # 健康检查、指标、回放路由
│   ├── app.ts                      # Probot 事件处理（GitHub App）
│   │
│   ├── core/                       # 公共基础设施
│   │   ├── cache.ts                #   TTL 内存缓存
│   │   ├── dedupe.ts               #   FNV 哈希请求去重
│   │   ├── env.ts                  #   环境变量工具
│   │   ├── errors.ts               #   类型化错误类（4xx/5xx）
│   │   ├── http.ts                 #   HTTP 客户端（重试 & 退避）
│   │   ├── i18n.ts                 #   语言检测（中文/英文）
│   │   ├── rate-limit.ts           #   按作用域限流
│   │   ├── runtime-state.ts        #   可插拔状态后端
│   │   └── secret-patterns.ts      #   正则密钥检测
│   │
│   ├── review/                     # AI 评审领域
│   │   ├── ai-reviewer.ts          #   多 Provider AI 抽象
│   │   ├── patch.ts                #   Git diff 解析 & 行号映射
│   │   ├── report-renderer.ts      #   Markdown 报告格式化
│   │   ├── review-policy.ts        #   Zod Schema & 策略配置
│   │   └── review-types.ts         #   数据模型
│   │
│   ├── integrations/
│   │   ├── github/                 #   GitHub 评审、策略、内容获取
│   │   ├── gitlab/                 #   GitLab 评审 & 命令处理
│   │   └── notify/                 #   Webhook 通知推送
│   │
│   ├── modules/
│   │   ├── github/                 #   NestJS GitHub Webhook 模块
│   │   ├── gitlab/                 #   NestJS GitLab Webhook 模块
│   │   ├── github-app/             #   NestJS GitHub App 模块（Probot）
│   │   └── webhook/                #   健康检查、指标、关停、回放
│   │
│   └── common/
│       └── filters/
│           └── http-error.filter.ts  # 全局异常过滤器
│
├── tests/                          # Node.js 测试（20+ 测试文件）
├── README.md                       # 当前文档的英文版本
├── docs/                           # 设计文档 & 路线图
├── Dockerfile                      # 多阶段 Docker 构建
├── docker-compose.yml              # Docker Compose 配置
├── .env.example                    # 完整环境变量参考
├── .env.github-app.min.example     # GitHub App 最小配置
└── .env.github-webhook.min.example # GitHub Webhook 最小配置
```

### 路径别名

项目使用 Node.js ESM subpath imports（在 `tsconfig.json` 和 `package.json` 中同步配置）：

| 别名 | 映射路径 |
|---|---|
| `#core` | `src/core/index.ts` |
| `#review` | `src/review/index.ts` |
| `#integrations/github` | `src/integrations/github/index.ts` |
| `#integrations/gitlab` | `src/integrations/gitlab/index.ts` |
| `#integrations/notify` | `src/integrations/notify/index.ts` |

---

## 快速开始

### 前置条件

- Node.js >= 22
- npm

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务（tsx 热加载）
npm run dev

# 生产构建
npm run build

# 启动生产服务
npm start
```

服务默认监听 `3000` 端口（可通过 `PORT` 环境变量配置）。

### 健康检查

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health?deep=true   # 测试 AI Provider 连通性
curl http://localhost:3000/github/health       # GitHub 配置状态
curl http://localhost:3000/gitlab/health       # GitLab 配置状态
```

---

## 配置说明

### 环境变量

复制 `.env.example` 并填入所需值。也提供了最小配置模板：

- `.env.github-app.min.example` — GitHub App 最小配置
- `.env.github-webhook.min.example` — 普通 GitHub Webhook 最小配置

### AI Provider 配置

```mermaid
graph LR
    ENV[AI_PROVIDER 环境变量]
    ENV -->|openai| OAI[OpenAI<br/>OPENAI_API_KEY + OPENAI_MODEL]
    ENV -->|openai-compatible| OC[OpenAI 兼容<br/>OPENAI_BASE_URL + OPENAI_COMPATIBLE_MODEL]
    ENV -->|anthropic| ANT[Anthropic<br/>ANTHROPIC_API_KEY + ANTHROPIC_MODEL]
    ENV -->|gemini| GEM[Gemini<br/>GEMINI_API_KEY + GEMINI_MODEL]
```

**OpenAI（默认）**
```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

**OpenAI 兼容（如 DeepSeek）**
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

### 状态持久化

| 后端 | 环境变量值 | 适用场景 |
|---|---|---|
| 内存 | `memory`（默认） | 无状态容器、开发环境 |
| JSON 文件 | `file` | 简单单实例 |
| SQLite | `sqlite`（推荐） | 生产单实例部署 |

```env
RUNTIME_STATE_BACKEND=sqlite
RUNTIME_STATE_SQLITE_FILE=/data/mr-agent/runtime-state.sqlite3
```

### 通知推送（可选）

支持企业微信、Slack、Discord 和通用 JSON Webhook：

```env
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/...
NOTIFY_WEBHOOK_FORMAT=slack   # wecom | slack | discord | generic
```

### 关键调参

**全局运行时与命令限流**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WEBHOOK_BODY_LIMIT` | `1mb` | 全局 Express body-parser 上限（超限返回 `413`） |
| `COMMAND_RATE_LIMIT_MAX` | `10` | 每用户、每 PR/MR、每命令在窗口内的最大触发次数 |
| `COMMAND_RATE_LIMIT_WINDOW_MS` | `3600000`（1 小时） | 命令限流时间窗口 |

**GitHub 专属**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GITHUB_MERGED_DEDUPE_TTL_MS` | `86400000`（24 小时） | `merged + report` 事件去重窗口 |
| `GITHUB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000`（30 天） | 反馈学习信号保留时长 |
| `GITHUB_INCREMENTAL_STATE_TTL_MS` | `604800000`（7 天） | 增量评审 SHA 缓存有效期 |
| `GITHUB_POLICY_CONFIG_CACHE_TTL_MS` | `300000`（5 分钟） | `.mr-agent.yml` 策略/评审配置缓存 |
| `GITHUB_POLICY_COMMENT_DEDUPE_TTL_MS` | `600000`（10 分钟） | 流程提醒评论去重窗口 |
| `GITHUB_WEBHOOK_MAX_BODY_BYTES` | `10485760`（10MB） | `/github/trigger` 的额外请求体硬上限 |
| `GITHUB_WEBHOOK_SKIP_SIGNATURE` | `false` | 仅调试可用；`NODE_ENV=production` 时禁止开启 |

**GitLab 专属**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `GITLAB_MERGED_DEDUPE_TTL_MS` | `86400000`（24 小时） | `merged + report` 去重窗口 |
| `GITLAB_INCREMENTAL_STATE_TTL_MS` | `604800000`（7 天） | 增量评审状态缓存 |
| `GITLAB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000`（30 天） | 反馈学习信号保留窗口 |
| `GITLAB_POLICY_CONFIG_CACHE_TTL_MS` | `300000`（5 分钟） | `.mr-agent.yml` 策略缓存 |
| `GITLAB_CHANGELOG_PATH` | `CHANGELOG.md` | `/changelog --apply` 写回路径 |
| `GITLAB_WEBHOOK_MAX_BODY_BYTES` | `10485760`（10MB） | `/gitlab/trigger` 的额外请求体硬上限 |
| `GITLAB_REQUIRE_WEBHOOK_SECRET` | `false` | 设为 `true` 时必须配置 `GITLAB_WEBHOOK_SECRET` |
| `ALLOW_INSECURE_GITLAB_HTTP` | `false` | 仅本地调试允许 `http://` GitLab 地址 |

**调参建议：**

- `MERGED_DEDUPE_TTL_MS` — 控制 `merged + report` 事件的去重窗口，防止 Webhook 重投时重复评审。遇到较多 Webhook 重试/Redeliver 时可调大到 `48h~72h`；需要更快允许同一 PR 合并事件再次触发时可调小到 `1h~6h`。该变量只影响合并自动触发；手动评论命令触发（`/ai-review ...`）仍使用短窗口（5 分钟）去重策略。
- `FEEDBACK_SIGNAL_TTL_MS` — 控制 `/feedback` 与 review thread resolved/unresolved 信号的保留时长。团队评审节奏慢、希望长期记忆偏好可设为 `60~90` 天；规则变化快、希望更快"遗忘"历史偏好可设为 `7~14` 天。
- `COMMAND_RATE_LIMIT_*` — 控制评论命令的防滥用阈值。高活跃仓库可适当上调，命令刷屏场景可下调。

`.env.example` 提供基础变量参考；上方补充的是代码已实现但通常不在最小模板中的高级开关。

---

## 部署指南

### Docker 部署（推荐）

```mermaid
graph LR
    subgraph Docker 构建
        B1[阶段 1：构建<br/>node:22-alpine<br/>npm ci + tsc]
        B2[阶段 2：运行时<br/>node:22-alpine<br/>仅生产依赖]
        B1 -->|COPY dist/| B2
    end
    B2 -->|暴露 3000 端口| SRV[mr-agent 容器]
```

**构建 & 运行**

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
# 启动
docker compose up -d --build

# 查看日志
docker compose logs -f mr-agent

# 重启
docker compose restart mr-agent

# 停止
docker compose down
```

`docker-compose.yml` 挂载的卷：
- `./data:/data` — 持久化状态（SQLite、事件存储）
- `./secrets/github-app.private-key.pem:/run/secrets/github-app-private-key.pem:ro` — GitHub App 私钥

### 生产部署清单

```mermaid
graph TD
    A[选择平台模式] -->|GitHub App| B1[创建 GitHub App]
    A -->|普通 Webhook| B2[生成 PAT Token]
    A -->|GitLab| B3[生成 API Token]

    B1 --> C[配置 AI Provider]
    B2 --> C
    B3 --> C

    C --> D[设置状态后端 = sqlite]
    D --> E[部署容器]
    E --> F[配置 Webhook URL]
    F --> G[验证健康检查端点]
    G --> H[测试 /ai-review 命令]
```

1. **选择接入模式** — 推荐 GitHub App，权限粒度更细
2. **配置 AI Provider** — 设置 `AI_PROVIDER` 及对应的 API Key / 模型名称
3. **启用状态持久化** — 生产环境推荐 `RUNTIME_STATE_BACKEND=sqlite`
4. **部署容器** — Docker、Docker Compose、Render、Railway、Fly.io 或 K8s
5. **在平台配置 Webhook URL**：
   - GitHub App：`https://<域名>/api/github/webhooks`
   - GitHub Webhook：`https://<域名>/github/trigger`
   - GitLab：`https://<域名>/gitlab/trigger`
6. **验证** — 访问健康检查端点，并在 PR 中测试 `/ai-review` 命令

### 快速部署参考

这是一个适用于 Render/Railway/Fly.io/Docker/K8s 的精简部署路径。

1. **选择模式**
   - GitHub App（推荐）
   - 普通 GitHub Webhook
   - 可选 GitLab Webhook
2. **使用最小环境变量**

**GitHub App 最小配置（`.env.github-app.min.example`）**

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
WEBHOOK_SECRET=replace-with-webhook-secret
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

**普通 GitHub Webhook 最小配置（`.env.github-webhook.min.example`）**

```env
GITHUB_WEBHOOK_SECRET=replace-with-webhook-secret
GITHUB_WEBHOOK_TOKEN=replace-with-github-token
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

**推荐的单实例补充配置**

```env
RUNTIME_STATE_BACKEND=sqlite
RUNTIME_STATE_SQLITE_FILE=/data/mr-agent/runtime-state.sqlite3
WEBHOOK_EVENT_STORE_ENABLED=false
WEBHOOK_REPLAY_ENABLED=false
```

**排障时临时开启 replay**

```env
WEBHOOK_EVENT_STORE_ENABLED=true
WEBHOOK_REPLAY_ENABLED=true
WEBHOOK_REPLAY_TOKEN=replace-with-strong-random-token
```

3. **启动应用**

```bash
npm install
npm run build
npm start
```

服务监听 `PORT`（默认 `3000`）。

4. **配置 Webhook 地址**
   - GitHub App：`https://<域名>/api/github/webhooks`
   - GitHub Webhook：`https://<域名>/github/trigger`
   - GitLab Webhook：`https://<域名>/gitlab/trigger`
5. **GitLab 推荐请求头**
   - `x-ai-mode: report|comment`
   - `x-gitlab-api-token: <api token>`
   - `x-gitlab-token: <webhook secret>`（仅当已配置 `GITLAB_WEBHOOK_SECRET`）
6. **Docker 一键启动**

```bash
docker build -t mr-agent:latest .
docker run -d --name mr-agent -p 3000:3000 --env-file .env mr-agent:latest
```

7. **验证清单**
   - `GET /health`
   - `GET /github/health`
   - `GET /gitlab/health`
   - `GET /metrics`
   - 在 PR/MR 评论中测试：`/ai-review`、`/ai-review comment`
   - Webhook 失败响应应包含结构化字段：`error/type/status/path/method/timestamp`

如果开启 replay：
- `GET /webhook/events`
- `POST /github/replay/:eventId`
- `POST /gitlab/replay/:eventId`
- 请求头：`x-mr-agent-replay-token: <WEBHOOK_REPLAY_TOKEN>`

### Nginx 反向代理

当前仓库未提交 `deploy/nginx/` 示例文件，可直接使用下方片段作为基线：

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

## 平台接入

### GitHub App（推荐）

1. 创建 GitHub App，配置以下权限：
   - **Pull requests**：Read & write
   - **Issues**：Read & write
   - **Contents**：Read & write（`/changelog --apply` 需要）
   - **Checks**：Read & write（`mode=enforce` 时必需）
   - **Metadata**：Read-only
2. 订阅事件：
   - `Pull request`（`opened` / `edited` / `synchronize` / `closed`）
   - `Issues`（`opened` / `edited`）
   - `Issue comment`
   - `Pull request review thread`（`resolved` / `unresolved`，用于反馈学习）
3. Webhook URL 设为 `https://<域名>/api/github/webhooks`
4. 配置环境变量：

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
WEBHOOK_SECRET=your-webhook-secret
```

> 若未配置 `APP_ID` + `PRIVATE_KEY`（+ `WEBHOOK_SECRET`），GitHub App 模式会自动禁用，但普通 Webhook 仍可用。

### 普通 GitHub Webhook

1. 在仓库 Settings > Webhooks 中添加 `https://<域名>/github/trigger`
2. Content type 选择 `application/json`
3. 选择事件：`Pull requests`、`Issues`、`Issue comments`、`Pull request review threads`
4. 配置环境变量：

```env
GITHUB_WEBHOOK_SECRET=your-secret
GITHUB_WEBHOOK_TOKEN=ghp_...    # 具有 repo 权限的 PAT（可用 GITHUB_TOKEN 兜底）
```

可选（仅调试）：

```env
GITHUB_WEBHOOK_SKIP_SIGNATURE=false
```

> `GITHUB_WEBHOOK_SKIP_SIGNATURE=true` 在生产环境（`NODE_ENV=production`）会被拒绝。

### GitLab Webhook

1. 在项目 Settings > Webhooks 中添加 `https://<域名>/gitlab/trigger`
2. 选择触发事件：
   - `Merge request events`（open / reopen / update / merge）
   - `Note events`（在 MR 评论里触发 `/ai-review`、`/ask`、`/checks`、`/describe`、`/generate_tests`、`/changelog`、`/improve`、`/add_doc`、`/reflect`、`/similar_issue`、`/feedback`）
3. 可选配置 Secret Token
4. 配置环境变量：

```env
GITLAB_TOKEN=glpat-...
GITLAB_WEBHOOK_SECRET=your-secret    # 可选
GITLAB_REQUIRE_WEBHOOK_SECRET=false  # 可选强制开关
```

GitLab 特有请求头：
- `x-ai-mode: report|comment` — 覆盖评审模式
- `x-gitlab-api-token: <token>` — 按请求指定 API Token（推荐）
- `x-gitlab-token` — Webhook 签名验证（仅当配置了 `GITLAB_WEBHOOK_SECRET` 时使用）
- `x-push-url` / `x-qwx-robot-url` — 可选，覆盖通知 Webhook 地址

> **兼容行为**：当未配置 `GITLAB_WEBHOOK_SECRET` 时，`x-gitlab-token` 会兼容作为 API Token 使用，而非用于签名验证。

---

## 评论命令

所有命令通过 PR/MR 评论触发：

| 命令 | 说明 |
|---|---|
| `/ai-review` | 触发 AI 评审（未显式指定时默认 `report`） |
| `/ai-review report` | 强制 Report 模式（汇总评论） |
| `/ai-review comment` | 强制 Comment 模式（行内评论） |
| `/ai-review --mode=report` / `--mode=comment` | 参数方式指定评审模式（与位置参数等价） |
| `/ask <问题>` | 针对 PR 代码提问（支持多轮对话） |
| `/checks [问题]` | 分析 CI 检查失败原因 |
| `/generate_tests [重点]` | 为变更生成测试代码 |
| `/changelog [重点]` | 生成 Changelog 条目 |
| `/changelog --apply [重点]` | 生成并提交 Changelog 到仓库 |
| `/describe` | 生成 PR/MR 描述 |
| `/describe --apply` | 生成并更新 PR/MR 描述 |
| `/improve [重点]` | 以改进建议为主进行评审 |
| `/add_doc [重点]` / `/add-doc [重点]` | 仅输出文档/注释改进建议 |
| `/reflect [目标]` | 生成需求澄清与验收标准问题 |
| `/similar_issue [关键词]` / `/similar-issue [关键词]` | 检索同仓库相似 Issue |
| `/feedback resolved\|dismissed\|up\|down [备注]` | 评审质量反馈 |

支持别名写法，例如：`/ai-review ask ...`、`/ai-review checks ...`、`/ai-review generate-tests ...`、`/ai-review add-doc ...`。
`.mr-agent.yml` 的命令开关覆盖 `/describe`、`/ask`、`/checks`、`/generate_tests`、`/changelog`、`/feedback`；`/reflect` 依赖 `askCommandEnabled`。

---

## 仓库策略配置

在仓库根目录添加 `.mr-agent.yml` 来配置仓库级行为：

```yaml
mode: remind          # remind = 仅评论提醒，enforce = 写入失败 GitHub Check

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
  onOpened: true        # PR 打开时评审
  onEdited: false
  onSynchronize: true   # 新提交时评审
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
  secretScanCustomPatterns:  # 可选：仓库自定义密钥正则
    - "(?i)my_internal_token_[a-z0-9]{16,}"
  customRules:
    - 所有公开 API 必须提供类型注释
    - 不允许新增 any 类型
```

GitLab 当前只读取 `.mr-agent.yml` 中的 `review:` 段。顶层 `mode`、`issue`、`pullRequest` 的流程校验是 GitHub 流程能力。

**模式说明：**
- `remind` — 评论提醒缺失项，不阻止合并
- `enforce` — 创建失败的 GitHub Check（`MR Agent Policy`），可在 Branch Protection 中设为必需

**模板回退行为：**
- 未配置 `requiredSections` 时，会自动从仓库模板提取段落标题进行检查：
  - Issue：`.github/ISSUE_TEMPLATE/*` 或 `.github/ISSUE_TEMPLATE.md`
  - PR：`.github/pull_request_template.md` 或 `.github/PULL_REQUEST_TEMPLATE.md`
- 若仓库无上述模板，回退到内置默认段落（Issue：`Summary / Steps to Reproduce / Expected Behavior`；PR：`Summary / Test Plan / Related Issue`）。

**review 字段说明：**

| 字段 | 说明 |
|---|---|
| `enabled` / `mode` | 启用 AI 评审，设置默认模式（comment / report） |
| `onOpened` / `onEdited` / `onSynchronize` | 控制哪些 PR 事件自动触发评审 |
| `describeEnabled` | 是否启用 `/describe` 命令 |
| `describeAllowApply` | 是否允许 `/describe --apply` 直接改写 PR 描述 |
| `checksCommandEnabled` | 是否启用 `/checks` 命令 |
| `includeCiChecks` | 是否把 CI 检查结果带入 AI 上下文 |
| `askCommandEnabled` | 是否启用 `/ask` 命令 |
| `generateTestsCommandEnabled` | 是否启用 `/generate_tests` 命令 |
| `changelogCommandEnabled` | 是否启用 `/changelog` 命令 |
| `changelogAllowApply` | 是否允许 `/changelog --apply` 直接写回仓库 Changelog |
| `feedbackCommandEnabled` | 是否启用 `/feedback` 命令 |
| `secretScanEnabled` | 是否扫描 diff 中疑似密钥泄露并发布安全提示 |
| `secretScanCustomPatterns` | 仓库自定义密钥正则补充规则 |
| `autoLabelEnabled` | 是否根据变更内容自动追加 PR 标签 |
| `customRules` | 团队自定义评审规则（自然语言），在评审与问答中都会强制纳入 |

---

## 可观测性

### 指标

Prometheus 格式指标通过 `GET /metrics` 暴露：

- `mr_agent_webhook_requests_total` — 按平台和事件统计的 Webhook 请求数
- `mr_agent_webhook_results_total` — 按平台和结果（ok/error）统计
- `mr_agent_webhook_replay_total` — 回放执行结果统计
- `mr_agent_webhook_store_writes_total` — 调试事件存储写入次数
- `mr_agent_webhook_store_trim_total` — 调试事件存储裁剪次数
- `mr_agent_health_checks_total` — 健康检查端点调用次数
- `mr_agent_http_errors_total` — 全局 HTTP 错误计数
- `mr_agent_process_uptime_seconds` — 进程运行时间
- `mr_agent_ai_requests_active` — 当前 AI 活跃请求数
- `mr_agent_ai_wait_queue_size` — AI 并发等待队列长度
- `mr_agent_ai_shutdown_requested` — AI 关停标记（0/1）
- `mr_agent_runtime_state_backend_info{backend=...}` — 当前状态后端信息指标

### 健康检查

| 端点 | 用途 |
|---|---|
| `GET /health` | 存活探针 |
| `GET /health?deep=true` | 深度检查（AI Provider 连通性） |
| `GET /github/health` | GitHub Webhook 配置校验 |
| `GET /gitlab/health` | GitLab Webhook 配置校验 |

### 错误处理

Webhook 错误返回结构化 JSON：

```json
{
  "ok": false,
  "error": "详细错误信息",
  "type": "BadWebhookRequestError",
  "status": 400,
  "path": "/github/trigger",
  "method": "POST",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

请求体超过 `WEBHOOK_BODY_LIMIT`（默认 `1mb`）时返回 `413 Payload Too Large`。

### Webhook 回放（调试用）

排障时临时启用：

```env
WEBHOOK_EVENT_STORE_ENABLED=true
WEBHOOK_REPLAY_ENABLED=true
WEBHOOK_REPLAY_TOKEN=your-secret-token
```

端点（需携带 `x-mr-agent-replay-token` 请求头）：
- `GET /webhook/events` — 列出已存储的事件
- `POST /github/replay/:eventId` — 回放 GitHub 事件
- `POST /gitlab/replay/:eventId` — 回放 GitLab 事件

### 韧性机制

- **HTTP 重试**：指数退避（2 次重试，400ms 基础延迟），针对 408/429/5xx 状态码
- **请求去重**：FNV 哈希，5 分钟窗口（合并事件 24 小时）
- **限流**：按作用域限制，防止 API 滥用
- **优雅关停**：收到 SIGTERM/SIGINT 后排空进行中的请求

---

## 测试

```bash
# 运行测试
npm test

# 带覆盖率运行
npm run test:coverage

# 仅类型检查
npm run check
```

测试使用 Node.js 内置测试运行器（`node:test`），覆盖范围包括：
- AI 并发控制
- 缓存与去重行为
- Diff 解析与 Hunk 优先级
- GitHub/GitLab 集成逻辑
- HTTP 重试与错误处理
- 策略校验
- 通知适配器
- NestJS 模块装配

---

## 许可证

私有项目 — 详见仓库说明。
