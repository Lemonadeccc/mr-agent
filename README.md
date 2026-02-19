# MR Agent

基于 TypeScript + NestJS 的 AI 代码评审服务，支持：

- GitHub App 模式（推荐）
- 普通 GitHub Webhook 模式
- GitLab Webhook 兼容模式

支持的评审触发：

- PR 打开/更新时自动评审（`opened` / `synchronize`，可在 `.mr-agent.yml` 配置）
- PR 合并后自动评审（`report`）
- PR 评论命令触发（`/ai-review`）
- PR 问答命令（`/ask <问题>`）
- PR 描述生成命令（`/describe`、`/describe --apply`）
- Webhook Header 指定 `report/comment`
- Issue 创建/编辑时流程预检（GitHub）
- PR 创建/编辑/同步时合并前流程预检（GitHub）

支持的模型 Provider：

- OpenAI
- OpenAI-compatible
- Anthropic
- Gemini

## 功能对齐目标（相对 `mr-agent/mr-agent`）

当前版本已覆盖参考实现的核心链路，并增加：

- GitHub App + 普通 GitHub Webhook 双模式
- OpenAI-compatible provider
- GitHub 与 GitLab 双平台
- 重复请求去重（5 分钟）
- `merged + report` 独立去重窗口（默认 24 小时，可配置）
- Issue/PR 流程守卫（模板完整性检查、GitHub Flow 预检）
- 仓库级策略配置（`.mr-agent.yml`，支持 `remind/enforce`）
- GitHub Suggested Changes 建议代码块（模型返回 `suggestion` 时）
- PR 增量评审（`synchronize/edited` 优先按新增 commit 对比）
- `enforce` 模式可写 GitHub Check（可接 branch protection）
- 疑似密钥泄露提示（基于 diff 的轻量规则扫描）
- 自动标签（bugfix/feature/refactor/docs/security 等）
- 超时/重试与错误分层（Webhook 鉴权错误、请求错误）
- `.github/.gitlab` 模板/流程文件识别（workflow/template/CODEOWNERS/CONTRIBUTING）并给出流程建议
- 外部 webhook 调用失败时返回结构化错误（含 `type/status/path/method/timestamp`）

## 快速开始

```bash
npm install
npm run dev
```

默认端口：`3000`

健康检查：

- `GET /health`
- `GET /github/health`
- `GET /gitlab/health`

## 触发方式

### 1) GitHub App 模式（推荐）

1. 创建 GitHub App，并安装到目标仓库。
2. 权限：
   - `Pull requests`: Read & write
   - `Issues`: Read & write
   - `Checks`: Read & write（仅当使用 `mode=enforce` 时必需）
   - `Metadata`: Read-only
3. 订阅事件：
   - `Pull request`（`opened` / `edited` / `synchronize` / `closed`）
   - `Issues`（`opened` / `edited`）
   - `Issue comment`
4. Webhook URL：

```text
https://<your-domain>/api/github/webhooks
```

评论命令：

```text
/ai-review
/ai-review report
/ai-review comment
/ask 这个函数有并发风险吗？
/describe
/describe --apply
```

说明：若未配置 `APP_ID + PRIVATE_KEY(+WEBHOOK_SECRET)`，GitHub App 模式会自动禁用，但普通 Webhook 仍可用。

### 2) 普通 GitHub Webhook 模式

Webhook URL：

```text
https://<your-domain>/github/trigger
```

事件：`Pull request` + `Issues` + `Issue comment`

Secret：`GITHUB_WEBHOOK_SECRET`

用于回写评论的 token：`GITHUB_WEBHOOK_TOKEN`（可用 `GITHUB_TOKEN` 兜底）

### 3) GitLab Webhook 兼容模式

Webhook URL：

```text
https://<your-domain>/gitlab/trigger
```

请求头：

- `x-ai-mode`: `report` 或 `comment`
- `x-gitlab-api-token`: GitLab API Token（推荐）
- `x-gitlab-token`: 仅当配置 `GITLAB_WEBHOOK_SECRET` 时用于 webhook 鉴权
- 可选：`x-push-url` / `x-qwx-robot-url`

兼容行为：当未配置 `GITLAB_WEBHOOK_SECRET` 时，`x-gitlab-token` 仍可兼容作为 API token 使用。

## Webhook 错误响应

当 webhook 请求失败时，会返回结构化 JSON（HTTP 非 2xx）：

```json
{
  "ok": false,
  "error": "详细错误信息",
  "type": "ErrorType",
  "status": 400,
  "path": "/github/trigger",
  "method": "POST",
  "timestamp": "2026-02-17T00:00:00.000Z"
}
```

## 最小化环境变量

### 方案 A：GitHub App

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
WEBHOOK_SECRET=replace-with-webhook-secret
# GITHUB_MERGED_DEDUPE_TTL_MS=86400000

AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

### 方案 B：普通 GitHub Webhook

```env
GITHUB_WEBHOOK_SECRET=replace-with-webhook-secret
GITHUB_WEBHOOK_TOKEN=replace-with-github-token
GITHUB_MERGED_DEDUPE_TTL_MS=86400000

AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

### `GITHUB_MERGED_DEDUPE_TTL_MS`（推荐值与调参）

- 作用：控制 GitHub `merged + report` 事件的去重窗口（单位毫秒），防止 webhook 重投时重复评审。
- 推荐值：`86400000`（24 小时）。
- 调大：如果你遇到较多 webhook 重试/Redeliver，或希望更强幂等，建议调到 `48h~72h`（如 `172800000` / `259200000`）。
- 调小：如果你需要更快允许同一 PR 合并事件再次触发自动评审，可调到 `1h~6h`（如 `3600000` / `21600000`）。
- 注意：该变量只影响 `merged + report` 自动触发；手动评论命令触发（`/ai-review ...`）仍使用短窗口去重策略。

更多变量见：`.env.example`

## 仓库策略配置（`.mr-agent.yml`）

在仓库根目录新增 `.mr-agent.yml`，可配置“仅提醒”或“强制失败检查”模式，并定义 Issue/PR 必填项：

```yaml
mode: remind # remind | enforce

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
  mode: comment # comment | report
  onOpened: true
  onEdited: false
  onSynchronize: true
  describeEnabled: true
  describeAllowApply: false
  secretScanEnabled: true
  autoLabelEnabled: true
```

说明：

- `mode=remind`：仅评论提醒缺失项，不写失败检查。
- `mode=enforce`：PR 预检不通过时写 GitHub Check 为 `failure`（默认检查名 `MR Agent Policy`）。
- 未配置 `requiredSections` 时，会自动从仓库模板提取段落标题进行检查：
  - Issue: `.github/ISSUE_TEMPLATE/*` 或 `.github/ISSUE_TEMPLATE.md`
  - PR: `.github/pull_request_template.md` 或 `.github/PULL_REQUEST_TEMPLATE.md`
- 若目标仓库没有上述模板，会回退到 MR Agent 内置默认模板段落（Issue: `Summary/Steps to Reproduce/Expected Behavior`；PR: `Summary/Test Plan/Related Issue`）。
- `review` 段用于控制自动评审与描述命令：
  - `enabled/mode/onOpened/onEdited/onSynchronize`：控制 PR 事件是否自动触发 AI 评审及模式。
  - `describeEnabled`：控制 `/describe` 是否可用。
  - `describeAllowApply`：控制 `/describe --apply` 是否允许直接改写 PR 描述。
  - `secretScanEnabled`：控制是否扫描 diff 中疑似密钥泄露并发布安全提示评论。
  - `autoLabelEnabled`：控制是否根据变更内容自动追加 PR 标签。

## 多 Provider 配置示例

### OpenAI-compatible

```env
AI_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://your-compatible-endpoint/v1
OPENAI_COMPATIBLE_API_KEY=replace-with-compatible-key
OPENAI_COMPATIBLE_MODEL=deepseek-chat
```

### Anthropic

```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=replace-with-anthropic-key
ANTHROPIC_MODEL=claude-3-5-haiku-latest
ANTHROPIC_MAX_TOKENS=4096
```

### Gemini

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=replace-with-gemini-key
GEMINI_MODEL=gemini-2.0-flash
```

## Docker 部署

```bash
docker build -t mr-agent:latest .
docker run -d --name mr-agent -p 3000:3000 --env-file .env mr-agent:latest
```

## 项目结构

经典 NestJS 分层（Controller / Service / Module）：

- `src/main.ts`: 启动入口
- `src/app.module.ts`: 根模块
- `src/app.controller.ts`: 全局健康检查路由
- `src/app.service.ts`: 全局服务
- `src/common/filters/http-error.filter.ts`: 全局异常过滤器
- `src/modules/github/github.webhook.controller.ts`: GitHub 普通 Webhook 控制器
- `src/modules/github/github.webhook.service.ts`: GitHub 普通 Webhook 服务
- `src/modules/gitlab/gitlab.webhook.controller.ts`: GitLab Webhook 控制器
- `src/modules/gitlab/gitlab.webhook.service.ts`: GitLab Webhook 服务
- `src/modules/github-app/github-app.bootstrap.service.ts`: GitHub App webhook 挂载
- `src/app.ts`: Probot GitHub App 事件处理
- `src/core/*`: 通用基础能力（错误模型、HTTP 重试、去重）
- `src/review/*`: 评审领域能力（模型调用、diff 行号、报告渲染、类型）
- `src/integrations/github/*`: GitHub 评审与普通 webhook 适配
- `src/integrations/gitlab/*`: GitLab 评审流程
- `src/integrations/notify/*`: 外部通知推送

### 路径别名

已启用 Node ESM + TS 路径别名（含运行时 `package.json#imports`）：

- `#core`
- `#review`
- `#integrations/github`
- `#integrations/gitlab`
- `#integrations/notify`

## 参考环境模板

- `.env.example`
- `.env.github-app.min.example`
- `.env.github-webhook.min.example`
