# MR Agent Deployment

用于部署平台（Render / Railway / Fly / Docker / K8s）快速落地。

## 1) 选择模式

- GitHub App（推荐）
- 普通 GitHub Webhook
- 可选同时开启 GitLab Webhook

## 2) 最小环境变量

### GitHub App

复制 `.env.github-app.min.example`：

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
WEBHOOK_SECRET=replace-with-webhook-secret
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

### 普通 GitHub Webhook

复制 `.env.github-webhook.min.example`：

```env
GITHUB_WEBHOOK_SECRET=replace-with-webhook-secret
GITHUB_WEBHOOK_TOKEN=replace-with-github-token
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
```

### 单实例推荐补充配置

```env
RUNTIME_STATE_BACKEND=sqlite
RUNTIME_STATE_SQLITE_FILE=/data/mr-agent/runtime-state.sqlite3
WEBHOOK_EVENT_STORE_ENABLED=false
WEBHOOK_REPLAY_ENABLED=false
```

排障时临时开启 replay：

```env
WEBHOOK_EVENT_STORE_ENABLED=true
WEBHOOK_REPLAY_ENABLED=true
WEBHOOK_REPLAY_TOKEN=replace-with-strong-random-token
```

## 3) 启动

```bash
npm install
npm run build
npm start
```

服务监听：`PORT`（默认 `3000`）

## 4) Webhook 地址

### GitHub App

```text
https://<your-domain>/api/github/webhooks
```

事件：`Pull request`, `Issue comment`

### 普通 GitHub Webhook

```text
https://<your-domain>/github/trigger
```

事件：`Pull request`, `Issue comment`

### GitLab Webhook（兼容）

```text
https://<your-domain>/gitlab/trigger
```

推荐 Header：

- `x-ai-mode: report|comment`
- `x-gitlab-api-token: <api token>`

如果配置了 `GITLAB_WEBHOOK_SECRET`，则还需：

- `x-gitlab-token: <webhook secret>`

## 5) Docker

```bash
docker build -t mr-agent:latest .
docker run -d --name mr-agent -p 3000:3000 --env-file .env mr-agent:latest
```

## 6) 验证

- `GET /health`
- `GET /github/health`
- `GET /gitlab/health`
- `GET /metrics`
- 在 PR 评论：`/ai-review` / `/ai-review comment`
- 失败时 webhook 会返回结构化错误 JSON（`error/type/status/path/method/timestamp`）

若开启 replay：

- `GET /webhook/events`
- `POST /github/replay/:eventId`
- `POST /gitlab/replay/:eventId`
- 请求头：`x-mr-agent-replay-token: <WEBHOOK_REPLAY_TOKEN>`
