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
- PR CI 诊断命令（`/checks [附加问题]`）
- PR 测试生成命令（`/generate_tests [重点]`）
- PR Changelog 命令（`/changelog [重点]`、`/changelog --apply [重点]`）
- PR 描述生成命令（`/describe`、`/describe --apply`）
- PR 反馈学习命令（`/feedback resolved|dismissed|up|down [备注]`）
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
- 报告内 Mermaid 变更结构图（按目录/文件可视化）
- 反馈学习信号（`/feedback` 与 review thread `resolved/unresolved`）
- Changelog 自动写回（`/changelog --apply`，可直接更新仓库文件）
- 超时/重试与错误分层（Webhook 鉴权错误、请求错误）
- `.github/.gitlab` 模板/流程文件识别（workflow/template/CODEOWNERS/CONTRIBUTING）并给出流程建议
- 外部 webhook 调用失败时返回结构化错误（含 `type/status/path/method/timestamp`）

## 路线图与流程资产

- 竞争差距落地 backlog：`docs/roadmap/2026-02-19-competitive-gap-backlog.md`
- GitHub issue 模板：`.github/ISSUE_TEMPLATE/bug_report.md`、`.github/ISSUE_TEMPLATE/feature_request.md`
- GitHub PR 模板：`.github/pull_request_template.md`
- GitLab issue 模板：`.gitlab/issue_templates/Bug.md`、`.gitlab/issue_templates/Feature.md`
- GitLab MR 模板：`.gitlab/merge_request_templates/default.md`

建议的 GitHub Flow 基线：

1. 开启 branch protection，至少要求 `MR Agent Policy` 与 CI 必过。
2. 在仓库启用 `.mr-agent.yml` 的 `mode: enforce`（可先从核心仓库灰度）。
3. 统一使用 issue/PR 模板，避免需求与验证信息缺失。

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
   - `Pull request review thread`（`resolved` / `unresolved`，用于反馈学习）
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
/checks 为什么这个 CI 失败？
/generate_tests 并发与异常路径
/changelog 用户可见行为变化
/changelog --apply 用户可见行为变化
/feedback resolved 这个建议很实用
/describe
/describe --apply
```

说明：若未配置 `APP_ID + PRIVATE_KEY(+WEBHOOK_SECRET)`，GitHub App 模式会自动禁用，但普通 Webhook 仍可用。

### 2) 普通 GitHub Webhook 模式

Webhook URL：

```text
https://<your-domain>/github/trigger
```

事件：`Pull request` + `Issues` + `Issue comment` + `Pull request review thread`

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

事件建议订阅：

- `Merge request`（open/reopen/update/merge）
- `Note`（在 MR 评论里触发 `/ai-review`、`/ask`、`/checks`、`/describe`、`/generate_tests`、`/changelog`、`/feedback`）

兼容行为：当未配置 `GITLAB_WEBHOOK_SECRET` 时，`x-gitlab-token` 仍可兼容作为 API token 使用。

GitLab MR 评论命令示例：

```text
/ai-review
/ai-review report
/ask 这个变更会引入并发问题吗？
/checks 为什么 pipeline 失败？
/generate_tests 边界与回归场景
/changelog 用户可见行为变化
/changelog --apply 用户可见行为变化
/describe
/describe --apply
/feedback down 这条建议噪音偏高
```

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

说明：请求体超过 `WEBHOOK_BODY_LIMIT`（默认 `1mb`）时会返回 `413 Payload Too Large`。

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

### 单实例部署推荐（状态持久化 + 默认关闭 replay）

```env
RUNTIME_STATE_BACKEND=sqlite
RUNTIME_STATE_SQLITE_FILE=/data/mr-agent/runtime-state.sqlite3
WEBHOOK_EVENT_STORE_ENABLED=false
WEBHOOK_REPLAY_ENABLED=false
```

### 排障时临时开启 replay（仅临时）

```env
WEBHOOK_EVENT_STORE_ENABLED=true
WEBHOOK_REPLAY_ENABLED=true
WEBHOOK_REPLAY_TOKEN=replace-with-strong-random-token
```

可用接口：

- `GET /webhook/events`（列出已存储 webhook 事件）
- `POST /github/replay/:eventId`
- `POST /gitlab/replay/:eventId`

以上接口需请求头：`x-mr-agent-replay-token: <WEBHOOK_REPLAY_TOKEN>`

### `GITHUB_MERGED_DEDUPE_TTL_MS`（推荐值与调参）

- 作用：控制 GitHub `merged + report` 事件的去重窗口（单位毫秒），防止 webhook 重投时重复评审。
- 推荐值：`86400000`（24 小时）。
- 调大：如果你遇到较多 webhook 重试/Redeliver，或希望更强幂等，建议调到 `48h~72h`（如 `172800000` / `259200000`）。
- 调小：如果你需要更快允许同一 PR 合并事件再次触发自动评审，可调到 `1h~6h`（如 `3600000` / `21600000`）。
- 注意：该变量只影响 `merged + report` 自动触发；手动评论命令触发（`/ai-review ...`）仍使用短窗口去重策略。

### `GITHUB_FEEDBACK_SIGNAL_TTL_MS`（反馈学习窗口）

- 作用：控制评审反馈信号（`/feedback` + review thread resolved/unresolved）保留时长（毫秒）。
- 推荐值：`2592000000`（30 天）。
- 调大：团队评审节奏慢、希望长期记忆偏好，可设为 `60~90` 天。
- 调小：规则变化快、希望更快“遗忘”历史偏好，可设为 `7~14` 天。

### GitLab 侧常用调参

- `GITLAB_MERGED_DEDUPE_TTL_MS`：`merged + report` 去重窗口（默认 24 小时）。
- `GITLAB_INCREMENTAL_STATE_TTL_MS`：增量评审状态缓存窗口（默认 7 天）。
- `GITLAB_FEEDBACK_SIGNAL_TTL_MS`：反馈学习信号保留窗口（默认 30 天）。
- `GITLAB_POLICY_CONFIG_CACHE_TTL_MS`：`.mr-agent.yml` 策略缓存窗口（默认 5 分钟）。
- `GITLAB_CHANGELOG_PATH`：`/changelog --apply` 写回路径（默认 `CHANGELOG.md`）。
- `WEBHOOK_BODY_LIMIT`：Webhook 请求体大小上限（默认 `1mb`，超限返回 `413`）。

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
  checksCommandEnabled: true
  includeCiChecks: true
  askCommandEnabled: true
  generateTestsCommandEnabled: true
  changelogCommandEnabled: true
  changelogAllowApply: false
  feedbackCommandEnabled: true
  secretScanEnabled: true
  autoLabelEnabled: true
  customRules:
    - 所有公开 API 必须提供类型注释
    - 不允许新增 any 类型
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
  - `checksCommandEnabled`：控制 `/checks` 是否可用。
  - `askCommandEnabled`：控制 `/ask` 是否可用。
  - `generateTestsCommandEnabled`：控制 `/generate_tests` 是否可用。
  - `changelogCommandEnabled`：控制 `/changelog` 是否可用。
  - `changelogAllowApply`：控制 `/changelog --apply` 是否允许直接写回仓库 changelog。
  - `feedbackCommandEnabled`：控制 `/feedback` 是否可用。
  - `includeCiChecks`：是否把 CI 检查结果带入 AI 上下文。
  - `secretScanEnabled`：控制是否扫描 diff 中疑似密钥泄露并发布安全提示评论。
  - `autoLabelEnabled`：控制是否根据变更内容自动追加 PR 标签。
  - `customRules`：团队自定义评审规则（自然语言），在评审与问答中都会强制纳入。

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
ANTHROPIC_MAX_TOKENS=8192
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
