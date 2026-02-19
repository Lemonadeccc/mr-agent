import {
  BadWebhookRequestError,
  WebhookAuthError,
  encodePath,
  fetchWithRetry,
  readNumberEnv,
} from "#core";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  type GitHubPullsListFilesMethod,
  type GitHubRepositoryContentFile,
  runGitHubAsk,
  runGitHubDescribe,
  runGitHubReview,
  type GitHubPullFile,
  type GitHubPullSummary,
  type GitHubReviewContext,
  type LoggerLike,
  type MinimalGitHubOctokit,
} from "./github-review.js";
import {
  resolveGitHubDescribePolicy,
  resolveGitHubPullRequestAutoReviewPolicy,
  resolveGitHubReviewBehaviorPolicy,
  runGitHubIssuePolicyCheck,
  runGitHubPullRequestPolicyCheck,
} from "./github-policy.js";
import { parseAskCommand, parseDescribeCommand, parseReviewCommand } from "#review";

const COMMAND = "/ai-review";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";

interface RestGitHubClientConfig {
  token: string;
  baseUrl: string;
}

const repositoryInfoPayloadSchema = z.object({
  name: z.string().min(1),
  owner: z.object({
    login: z.string().optional(),
    name: z.string().optional(),
  }),
  default_branch: z.string().optional(),
});

const pullRequestWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().optional(),
    html_url: z.string().optional(),
    merged: z.boolean().optional(),
    base: z
      .object({
        ref: z.string().optional(),
      })
      .optional(),
    head: z
      .object({
        ref: z.string().optional(),
        sha: z.string().optional(),
      })
      .optional(),
  }),
});

const issuesWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    body: z.string().optional(),
    pull_request: z.unknown().optional(),
  }),
});

const issueCommentWebhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string().optional(),
  }),
});

export async function handlePlainGitHubWebhook(params: {
  payload: unknown;
  rawBody: string;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const eventName = params.headers["x-github-event"]?.toLowerCase();
  if (!eventName) {
    throw new BadWebhookRequestError("missing x-github-event header");
  }

  verifyWebhookSignature(params.rawBody, params.headers);

  const token = process.env.GITHUB_WEBHOOK_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new BadWebhookRequestError(
      "Missing GITHUB_WEBHOOK_TOKEN (or GITHUB_TOKEN) for plain webhook mode",
    );
  }

  const apiBaseUrl = (process.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL).replace(
    /\/$/,
    "",
  );
  const octokit = createRestBackedOctokit({ token, baseUrl: apiBaseUrl });

  if (eventName === "pull_request") {
    const payload = parsePayload(
      pullRequestWebhookPayloadSchema,
      params.payload,
      "pull_request",
    );
    const owner = payload.repository.owner.login ?? payload.repository.owner.name;
    const repo = payload.repository.name;

    if (!owner || !repo || !payload.pull_request.number) {
      throw new BadWebhookRequestError("invalid pull_request payload");
    }

    const context = createReviewContext(owner, repo, octokit, params.logger);
    const action = payload.action?.toLowerCase();
    if (action === "closed" && payload.pull_request?.merged) {
      await runGitHubReview({
        context,
        pullNumber: payload.pull_request.number,
        mode: "report",
        trigger: "merged",
        throwOnError: true,
      });

      return { ok: true, message: "pull_request review triggered" };
    }

    if (
      action === "opened" ||
      action === "edited" ||
      action === "synchronize"
    ) {
      await runGitHubPullRequestPolicyCheck({
        context,
        pullNumber: payload.pull_request.number,
        title: payload.pull_request.title ?? "",
        body: payload.pull_request.body ?? "",
        headSha: payload.pull_request.head?.sha,
        baseRef:
          payload.pull_request.base?.ref ?? payload.repository.default_branch,
        detailsUrl: payload.pull_request.html_url,
      });

      const autoReview = await resolveGitHubPullRequestAutoReviewPolicy({
        context,
        baseRef:
          payload.pull_request.base?.ref ?? payload.repository.default_branch,
        action,
      });
      if (autoReview.enabled) {
        await runGitHubReview({
          context,
          pullNumber: payload.pull_request.number,
          mode: autoReview.mode,
          trigger:
            action === "opened"
              ? "pr-opened"
              : action === "edited"
                ? "pr-edited"
                : "pr-synchronize",
          dedupeSuffix: payload.pull_request.head?.sha,
          enableSecretScan: autoReview.secretScanEnabled,
          enableAutoLabel: autoReview.autoLabelEnabled,
        });
      }

      return { ok: true, message: "pull_request policy check triggered" };
    }

    return { ok: true, message: "ignored pull_request action" };
  }

  if (eventName === "issues") {
    const payload = parsePayload(issuesWebhookPayloadSchema, params.payload, "issues");
    const action = payload.action?.toLowerCase();
    if (action !== "opened" && action !== "edited") {
      return { ok: true, message: "ignored issues action" };
    }
    if (payload.issue.pull_request) {
      return { ok: true, message: "ignored issue converted from pull request" };
    }

    const owner = payload.repository.owner.login ?? payload.repository.owner.name;
    const repo = payload.repository.name;
    if (!owner || !repo || !payload.issue.number) {
      throw new BadWebhookRequestError("invalid issues payload");
    }

    const context = createReviewContext(owner, repo, octokit, params.logger);
    await runGitHubIssuePolicyCheck({
      context,
      issueNumber: payload.issue.number,
      title: payload.issue.title ?? "",
      body: payload.issue.body ?? "",
      ref: payload.repository.default_branch,
    });

    return { ok: true, message: "issue policy check triggered" };
  }

  if (eventName === "issue_comment") {
    const payload = parsePayload(
      issueCommentWebhookPayloadSchema,
      params.payload,
      "issue_comment",
    );
    const body = payload.comment?.body?.trim() ?? "";

    if (payload.action !== "created") {
      return { ok: true, message: "ignored issue_comment action" };
    }

    if (!payload.issue?.pull_request) {
      return { ok: true, message: "ignored issue_comment content" };
    }

    const owner = payload.repository.owner.login ?? payload.repository.owner.name;
    const repo = payload.repository.name;
    if (!owner || !repo || !payload.issue.number) {
      throw new BadWebhookRequestError("invalid issue_comment payload");
    }

    const context = createReviewContext(owner, repo, octokit, params.logger);
    const describe = parseDescribeCommand(body);
    if (describe.matched) {
      const describePolicy = await resolveGitHubDescribePolicy({
        context,
      });
      if (!describePolicy.enabled) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/describe` 在当前仓库已被禁用（.mr-agent.yml -> review.describeEnabled=false）。",
        });
        return { ok: true, message: "describe command ignored by policy" };
      }

      if (describe.apply && !describePolicy.allowApply) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/describe --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.describeAllowApply=false）。",
        });
        return { ok: true, message: "describe apply ignored by policy" };
      }

      await runGitHubDescribe({
        context,
        pullNumber: payload.issue.number,
        apply: describe.apply && describePolicy.allowApply,
        trigger: "describe-command",
        throwOnError: true,
      });

      return { ok: true, message: "describe command triggered" };
    }

    const ask = parseAskCommand(body);
    if (ask.matched) {
      await runGitHubAsk({
        context,
        pullNumber: payload.issue.number,
        question: ask.question,
        trigger: "comment-command",
        throwOnError: true,
      });
      return { ok: true, message: "ask command triggered" };
    }

    if (!body.startsWith(COMMAND)) {
      return { ok: true, message: "ignored issue_comment content" };
    }

    const command = parseReviewCommand(body);
    if (!command.matched) {
      return { ok: true, message: "ignored issue_comment content" };
    }

    const mode = command.mode;
    const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
      context,
    });

    await runGitHubReview({
      context,
      pullNumber: payload.issue.number,
      mode,
      trigger: "comment-command",
      enableSecretScan: reviewBehavior.secretScanEnabled,
      enableAutoLabel: reviewBehavior.autoLabelEnabled,
      throwOnError: true,
    });

    return { ok: true, message: "issue_comment review triggered" };
  }

  return { ok: true, message: `ignored event ${eventName}` };
}

function parsePayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  eventName: string,
): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join(".") || "payload";
  throw new BadWebhookRequestError(
    `invalid ${eventName} payload: ${issuePath} ${firstIssue?.message ?? "schema validation failed"}`,
  );
}

function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string | undefined>,
): void {
  const skipSignature =
    (process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE ?? "").toLowerCase() === "true";
  if (skipSignature) {
    return;
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new WebhookAuthError(
      "Missing GITHUB_WEBHOOK_SECRET (or WEBHOOK_SECRET) for plain webhook mode",
    );
  }

  const signatureHeader = headers["x-hub-signature-256"] ?? "";
  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signatureHeader, "utf8");

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new WebhookAuthError("invalid webhook signature", 403);
  }
}

function createReviewContext(
  owner: string,
  repo: string,
  octokit: MinimalGitHubOctokit,
  logger: LoggerLike,
): GitHubReviewContext {
  return {
    repo: () => ({ owner, repo }),
    octokit,
    log: logger,
  };
}

function createRestBackedOctokit(config: RestGitHubClientConfig): MinimalGitHubOctokit {
  const listFiles: GitHubPullsListFilesMethod = async (params) => {
    return {
      data: await listPullFiles(config, params),
    };
  };

  return {
    repos: {
      getContent: async (params) => {
        const encodedPath = encodePath(params.path);
        const query = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
        const data = await requestJson<
          GitHubRepositoryContentFile | GitHubRepositoryContentFile[]
        >(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${encodedPath}${query}`,
        });
        return { data };
      },
      compareCommits: async (params) => {
        const data = await requestJson<{ files?: GitHubPullFile[] }>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/compare/${encodeURIComponent(params.base as string)}...${encodeURIComponent(params.head as string)}`,
        });
        return { data };
      },
    },
    pulls: {
      listFiles,
      get: async (params) => {
        const data = await requestJson<GitHubPullSummary>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}`,
        });
        return { data };
      },
      createReviewComment: async (params) => {
        await requestJson(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}/comments`,
          body: {
            body: params.body,
            commit_id: params.commit_id,
            path: params.path,
            line: params.line,
            side: params.side,
          },
        });
        return {};
      },
      update: async (params) => {
        await requestJson(config, {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}`,
          body: {
            body: params.body,
          },
        });
        return {};
      },
    },
    issues: {
      createComment: async (params) => {
        const data = await requestJson<{ id: number }>(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.issue_number}/comments`,
          body: {
            body: params.body,
          },
        });
        return { data };
      },
      updateComment: async (params) => {
        await requestJson(config, {
          method: "PATCH",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/comments/${params.comment_id}`,
          body: {
            body: params.body,
          },
        });
        return {};
      },
      addLabels: async (params) => {
        await requestJson(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/issues/${params.issue_number}/labels`,
          body: {
            labels: params.labels,
          },
        });
        return {};
      },
    },
    checks: {
      create: async (params) => {
        await requestJson(config, {
          method: "POST",
          path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/check-runs`,
          body: {
            name: params.name,
            head_sha: params.head_sha,
            details_url: params.details_url,
            status: params.status,
            conclusion: params.conclusion,
            completed_at: params.completed_at,
            output: params.output,
          },
        });
        return {};
      },
    },
    paginate: async (_method, params) => {
      return listPullFiles(config, params);
    },
  };
}

async function listPullFiles(
  config: RestGitHubClientConfig,
  params: {
    owner: string;
    repo: string;
    pull_number: number;
    per_page: number;
  },
): Promise<GitHubPullFile[]> {
  const perPage = Math.max(1, Math.min(params.per_page, 100));
  const items: GitHubPullFile[] = [];

  let page = 1;
  while (page <= 20) {
    const pageItems = await requestJson<GitHubPullFile[]>(config, {
      method: "GET",
      path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.pull_number}/files?per_page=${perPage}&page=${page}`,
    });

    items.push(...pageItems);
    if (pageItems.length < perPage) {
      break;
    }

    page += 1;
  }

  return items;
}

async function requestJson<T = unknown>(
  config: RestGitHubClientConfig,
  params: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    body?: unknown;
  },
): Promise<T> {
  const response = await fetchWithRetry(
    `${config.baseUrl}${params.path}`,
    {
      method: params.method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "mr-agent-webhook-client",
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    },
    {
      timeoutMs: readNumberEnv("GITHUB_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("GITHUB_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("GITHUB_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${params.method} ${params.path} failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
