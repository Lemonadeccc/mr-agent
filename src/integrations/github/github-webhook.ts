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
  recordGitHubFeedbackSignal,
  runGitHubAsk,
  runGitHubChangelog,
  runGitHubDescribe,
  runGitHubReview,
  type GitHubCheckRunSummary,
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
import {
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parseReviewCommand,
} from "#review";

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

const pullRequestReviewThreadPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositoryInfoPayloadSchema,
  pull_request: z
    .object({
      number: z.number().int().positive(),
    })
    .optional(),
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
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
        baseRef:
          payload.pull_request.base?.ref ?? payload.repository.default_branch,
      });
      await runGitHubReview({
        context,
        pullNumber: payload.pull_request.number,
        mode: "report",
        trigger: "merged",
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
        enableSecretScan: reviewBehavior.secretScanEnabled,
        enableAutoLabel: reviewBehavior.autoLabelEnabled,
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
          customRules: autoReview.customRules,
          includeCiChecks: autoReview.includeCiChecks,
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

  if (eventName === "pull_request_review_thread") {
    const payload = parsePayload(
      pullRequestReviewThreadPayloadSchema,
      params.payload,
      "pull_request_review_thread",
    );
    const owner = payload.repository.owner.login ?? payload.repository.owner.name;
    const repo = payload.repository.name;
    if (!owner || !repo) {
      throw new BadWebhookRequestError("invalid pull_request_review_thread payload");
    }

    const action = payload.action?.toLowerCase();
    if (action !== "resolved" && action !== "unresolved") {
      return { ok: true, message: "ignored pull_request_review_thread action" };
    }

    const pullNumber = payload.pull_request?.number;
    const signal =
      action === "resolved"
        ? `PR #${pullNumber ?? "?"} review thread resolved: 开发者倾向已修复/高价值建议`
        : `PR #${pullNumber ?? "?"} review thread unresolved: 开发者认为建议仍未满足`;
    recordGitHubFeedbackSignal({
      owner,
      repo,
      signal,
    });

    return { ok: true, message: "pull_request_review_thread feedback recorded" };
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
    const feedbackCommand = parseFeedbackCommand(body);
    if (feedbackCommand.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.feedbackCommandEnabled) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/feedback` 在当前仓库已被禁用（.mr-agent.yml -> review.feedbackCommandEnabled=false）。",
        });
        return { ok: true, message: "feedback command ignored by policy" };
      }

      const positive =
        feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
      const signalCore = positive
        ? "开发者更偏好高置信、可落地建议"
        : "开发者希望减少低价值或噪音建议";
      const noteText = feedbackCommand.note ? `；备注：${feedbackCommand.note}` : "";
      recordGitHubFeedbackSignal({
        owner,
        repo,
        signal: `PR #${payload.issue.number} ${feedbackCommand.action}: ${signalCore}${noteText}`,
      });
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: payload.issue.number,
        body: `已记录反馈信号：\`${feedbackCommand.action}\`。后续评审会参考该偏好。`,
      });
      return { ok: true, message: "feedback command recorded" };
    }

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
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.askCommandEnabled) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/ask` 在当前仓库已被禁用（.mr-agent.yml -> review.askCommandEnabled=false）。",
        });
        return { ok: true, message: "ask command ignored by policy" };
      }
      await runGitHubAsk({
        context,
        pullNumber: payload.issue.number,
        question: ask.question,
        trigger: "comment-command",
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
        throwOnError: true,
      });
      return { ok: true, message: "ask command triggered" };
    }

    const checksCommand = parseChecksCommand(body);
    if (checksCommand.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.checksCommandEnabled) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/checks` 在当前仓库已被禁用（.mr-agent.yml -> review.checksCommandEnabled=false）。",
        });
        return { ok: true, message: "checks command ignored by policy" };
      }

      const checksQuestion = checksCommand.question
        ? `请结合当前 PR 的 CI 检查结果给出修复建议。额外问题：${checksCommand.question}`
        : "请结合当前 PR 的 CI 检查结果，分析失败原因并给出可执行修复步骤（优先级从高到低）。";
      await runGitHubAsk({
        context,
        pullNumber: payload.issue.number,
        question: checksQuestion,
        trigger: "comment-command",
        customRules: reviewBehavior.customRules,
        includeCiChecks: true,
        throwOnError: true,
      });
      return { ok: true, message: "checks command triggered" };
    }

    const generateTests = parseGenerateTestsCommand(body);
    if (generateTests.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.generateTestsCommandEnabled) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/generate_tests` 在当前仓库已被禁用（.mr-agent.yml -> review.generateTestsCommandEnabled=false）。",
        });
        return { ok: true, message: "generate_tests command ignored by policy" };
      }
      const generateTestsQuestion = generateTests.focus
        ? `请基于当前 PR 改动生成可执行测试方案和测试代码草案，重点覆盖：${generateTests.focus}。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。`
        : "请基于当前 PR 改动生成可执行测试方案和测试代码草案。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。";
      await runGitHubAsk({
        context,
        pullNumber: payload.issue.number,
        question: generateTestsQuestion,
        trigger: "comment-command",
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
        commentTitle: "AI Test Generator",
        displayQuestion: generateTests.focus
          ? `/generate_tests ${generateTests.focus}`
          : "/generate_tests",
        throwOnError: true,
      });
      return { ok: true, message: "generate_tests command triggered" };
    }

    const changelogCommand = parseChangelogCommand(body);
    if (changelogCommand.matched) {
      const reviewBehavior = await resolveGitHubReviewBehaviorPolicy({
        context,
      });
      if (!reviewBehavior.changelogCommandEnabled) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/changelog` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogCommandEnabled=false）。",
        });
        return { ok: true, message: "changelog command ignored by policy" };
      }
      if (changelogCommand.apply && !reviewBehavior.changelogAllowApply) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: payload.issue.number,
          body: "`/changelog --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogAllowApply=false）。",
        });
        return { ok: true, message: "changelog apply ignored by policy" };
      }
      await runGitHubChangelog({
        context,
        pullNumber: payload.issue.number,
        trigger: "comment-command",
        focus: changelogCommand.focus,
        apply: changelogCommand.apply && reviewBehavior.changelogAllowApply,
        customRules: reviewBehavior.customRules,
        includeCiChecks: reviewBehavior.includeCiChecks,
        throwOnError: true,
      });
      return { ok: true, message: "changelog command triggered" };
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
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
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
      createOrUpdateFileContents: async (params) => {
        await requestJson(config, {
          method: "PUT",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/contents/${encodePath(params.path as string)}`,
          body: {
            message: params.message,
            content: params.content,
            sha: params.sha,
            branch: params.branch,
          },
        });
        return {};
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
      listForRef: async (params) => {
        const data = await requestJson<{ check_runs?: GitHubCheckRunSummary[] }>(config, {
          method: "GET",
          path: `/repos/${encodeURIComponent(params.owner as string)}/${encodeURIComponent(params.repo as string)}/commits/${encodeURIComponent(params.ref as string)}/check-runs?per_page=${Math.max(1, Math.min(Number(params.per_page ?? 100), 100))}`,
        });
        return {
          data: {
            check_runs: Array.isArray(data.check_runs)
              ? data.check_runs
              : [],
          },
        };
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
    method: "GET" | "POST" | "PATCH" | "PUT";
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
