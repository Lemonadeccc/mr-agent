import {
  BadWebhookRequestError,
  WebhookAuthError,
  encodePath,
  fetchWithRetry,
  isRateLimited,
  localizeText,
  readNumberEnv,
  resolveUiLocale,
  type UiLocale,
} from "#core";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  buildManagedCommandCommentKey,
  type GitHubPullFilesListParams,
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
const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_LIST_FILES_TRUNCATED_RECORDS = 500;

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
    user: z
      .object({
        type: z.string().optional(),
        login: z.string().optional(),
      })
      .optional(),
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
  verifyGitHubWebhookBodySize(params.rawBody);
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
        ? `PR #${pullNumber ?? "?"} review thread resolved: developer indicates suggestion fixed/high-value`
        : `PR #${pullNumber ?? "?"} review thread unresolved: developer indicates suggestion still not satisfied`;
    recordGitHubFeedbackSignal({
      owner,
      repo,
      pullNumber,
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
    return handleGitHubIssueCommentCommand({
      context,
      owner,
      repo,
      issueNumber: payload.issue.number,
      body: payload.comment?.body?.trim() ?? "",
      commentUser: payload.comment?.user,
      rateLimitPlatform: "github-webhook",
      throwOnError: true,
    });
  }

  return { ok: true, message: `ignored event ${eventName}` };
}

function verifyGitHubWebhookBodySize(rawBody: string): void {
  const maxBodyBytes = Math.max(
    1,
    readNumberEnv(
      "GITHUB_WEBHOOK_MAX_BODY_BYTES",
      DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES,
    ),
  );
  const bodyBytes = Buffer.byteLength(rawBody, "utf8");
  if (bodyBytes <= maxBodyBytes) {
    return;
  }

  throw new BadWebhookRequestError(
    `webhook payload too large: ${bodyBytes} bytes exceeds GITHUB_WEBHOOK_MAX_BODY_BYTES=${maxBodyBytes}`,
  );
}

export async function handleGitHubIssueCommentCommand(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  commentUser?:
    | {
        type?: string;
        login?: string;
      }
    | null;
  rateLimitPlatform: "github-app" | "github-webhook";
  throwOnError?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  if (isGitHubBotCommentUser(params.commentUser)) {
    return { ok: true, message: "ignored issue_comment from bot" };
  }

  const body = params.body.trim();
  const locale = resolveUiLocale();
  const commentUserLogin = params.commentUser?.login;
  const throwOnError = Boolean(params.throwOnError);
  let reviewBehaviorPromise:
    | Promise<Awaited<ReturnType<typeof resolveGitHubReviewBehaviorPolicy>>>
    | undefined;

  const getReviewBehavior = async () => {
    if (!reviewBehaviorPromise) {
      reviewBehaviorPromise = resolveGitHubReviewBehaviorPolicy({
        context: params.context,
      });
    }
    return reviewBehaviorPromise;
  };

  const hitRateLimit = async (command: string): Promise<boolean> => {
    if (
      !(await shouldRejectGitHubCommandByRateLimit({
        context: params.context,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.issueNumber,
        userLogin: commentUserLogin,
        command,
        platform: params.rateLimitPlatform,
      }))
    ) {
      return false;
    }
    return true;
  };

  const feedbackCommand = parseFeedbackCommand(body);
  if (feedbackCommand.matched) {
    if (await hitRateLimit("feedback")) {
      return { ok: true, message: "feedback command rate limited" };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.feedbackCommandEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/feedback` 在当前仓库已被禁用（.mr-agent.yml -> review.feedbackCommandEnabled=false）。",
            en: "`/feedback` is disabled for this repository (.mr-agent.yml -> review.feedbackCommandEnabled=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "feedback command ignored by policy" };
    }

    const positive =
      feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
    const signalCore = positive
      ? "developer prefers high-confidence, actionable suggestions"
      : "developer prefers fewer low-value/noisy suggestions";
    const noteText = feedbackCommand.note ? `; note: ${feedbackCommand.note}` : "";
    recordGitHubFeedbackSignal({
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.issueNumber,
      signal: `PR #${params.issueNumber} ${feedbackCommand.action}: ${signalCore}${noteText}`,
    });
    await params.context.octokit.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      body: localizeText(
        {
          zh: `已记录反馈信号：\`${feedbackCommand.action}\`。后续评审会参考该偏好。`,
          en: `Recorded feedback signal: \`${feedbackCommand.action}\`. Future reviews will use this preference.`,
        },
        locale,
      ),
    });
    return { ok: true, message: "feedback command recorded" };
  }

  const describe = parseDescribeCommand(body);
  if (describe.matched) {
    if (await hitRateLimit("describe")) {
      return { ok: true, message: "describe command rate limited" };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.describeEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/describe` 在当前仓库已被禁用（.mr-agent.yml -> review.describeEnabled=false）。",
            en: "`/describe` is disabled for this repository (.mr-agent.yml -> review.describeEnabled=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "describe command ignored by policy" };
    }
    if (describe.apply && !reviewBehavior.describeAllowApply) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/describe --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.describeAllowApply=false）。",
            en: "`/describe --apply` is disabled for this repository (.mr-agent.yml -> review.describeAllowApply=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "describe apply ignored by policy" };
    }

    await runGitHubDescribe({
      context: params.context,
      pullNumber: params.issueNumber,
      apply: describe.apply && reviewBehavior.describeAllowApply,
      trigger: "describe-command",
      throwOnError,
    });
    return { ok: true, message: "describe command triggered" };
  }

  const ask = parseAskCommand(body);
  if (ask.matched) {
    if (await hitRateLimit("ask")) {
      return { ok: true, message: "ask command rate limited" };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.askCommandEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/ask` 在当前仓库已被禁用（.mr-agent.yml -> review.askCommandEnabled=false）。",
            en: "`/ask` is disabled for this repository (.mr-agent.yml -> review.askCommandEnabled=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "ask command ignored by policy" };
    }
    await runGitHubAsk({
      context: params.context,
      pullNumber: params.issueNumber,
      question: ask.question,
      managedCommentKey: buildManagedCommandCommentKey("ask", ask.question),
      trigger: "comment-command",
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
      enableConversationContext: true,
      throwOnError,
    });
    return { ok: true, message: "ask command triggered" };
  }

  const checksCommand = parseChecksCommand(body);
  if (checksCommand.matched) {
    if (await hitRateLimit("checks")) {
      return { ok: true, message: "checks command rate limited" };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.checksCommandEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/checks` 在当前仓库已被禁用（.mr-agent.yml -> review.checksCommandEnabled=false）。",
            en: "`/checks` is disabled for this repository (.mr-agent.yml -> review.checksCommandEnabled=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "checks command ignored by policy" };
    }

    const checksQuestion = checksCommand.question
      ? `请结合当前 PR 的 CI 检查结果给出修复建议。额外问题：${checksCommand.question}`
      : "请结合当前 PR 的 CI 检查结果，分析失败原因并给出可执行修复步骤（优先级从高到低）。";
    await runGitHubAsk({
      context: params.context,
      pullNumber: params.issueNumber,
      question: checksQuestion,
      managedCommentKey: buildManagedCommandCommentKey("checks", checksQuestion),
      trigger: "comment-command",
      customRules: reviewBehavior.customRules,
      includeCiChecks: true,
      throwOnError,
    });
    return { ok: true, message: "checks command triggered" };
  }

  const generateTests = parseGenerateTestsCommand(body);
  if (generateTests.matched) {
    if (await hitRateLimit("generate-tests")) {
      return { ok: true, message: "generate_tests command rate limited" };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.generateTestsCommandEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/generate_tests` 在当前仓库已被禁用（.mr-agent.yml -> review.generateTestsCommandEnabled=false）。",
            en: "`/generate_tests` is disabled for this repository (.mr-agent.yml -> review.generateTestsCommandEnabled=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "generate_tests command ignored by policy" };
    }
    const generateTestsQuestion = generateTests.focus
      ? `请基于当前 PR 改动生成可执行测试方案和测试代码草案，重点覆盖：${generateTests.focus}。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。`
      : "请基于当前 PR 改动生成可执行测试方案和测试代码草案。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。";
    await runGitHubAsk({
      context: params.context,
      pullNumber: params.issueNumber,
      question: generateTestsQuestion,
      managedCommentKey: buildManagedCommandCommentKey(
        "generate-tests",
        generateTestsQuestion,
      ),
      trigger: "comment-command",
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
      commentTitle: "AI Test Generator",
      displayQuestion: generateTests.focus
        ? `/generate_tests ${generateTests.focus}`
        : "/generate_tests",
      throwOnError,
    });
    return { ok: true, message: "generate_tests command triggered" };
  }

  const changelogCommand = parseChangelogCommand(body);
  if (changelogCommand.matched) {
    if (await hitRateLimit("changelog")) {
      return { ok: true, message: "changelog command rate limited" };
    }
    const reviewBehavior = await getReviewBehavior();
    if (!reviewBehavior.changelogCommandEnabled) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/changelog` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogCommandEnabled=false）。",
            en: "`/changelog` is disabled for this repository (.mr-agent.yml -> review.changelogCommandEnabled=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "changelog command ignored by policy" };
    }
    if (changelogCommand.apply && !reviewBehavior.changelogAllowApply) {
      await params.context.octokit.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: localizeText(
          {
            zh: "`/changelog --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogAllowApply=false）。",
            en: "`/changelog --apply` is disabled for this repository (.mr-agent.yml -> review.changelogAllowApply=false).",
          },
          locale,
        ),
      });
      return { ok: true, message: "changelog apply ignored by policy" };
    }
    await runGitHubChangelog({
      context: params.context,
      pullNumber: params.issueNumber,
      trigger: "comment-command",
      focus: changelogCommand.focus,
      apply: changelogCommand.apply && reviewBehavior.changelogAllowApply,
      customRules: reviewBehavior.customRules,
      includeCiChecks: reviewBehavior.includeCiChecks,
      throwOnError,
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
  if (await hitRateLimit("ai-review")) {
    return { ok: true, message: "issue_comment review rate limited" };
  }

  const reviewBehavior = await getReviewBehavior();

  await runGitHubReview({
    context: params.context,
    pullNumber: params.issueNumber,
    mode: command.mode,
    trigger: "comment-command",
    customRules: reviewBehavior.customRules,
    includeCiChecks: reviewBehavior.includeCiChecks,
    enableSecretScan: reviewBehavior.secretScanEnabled,
    enableAutoLabel: reviewBehavior.autoLabelEnabled,
    throwOnError,
  });

  return { ok: true, message: "issue_comment review triggered" };
}

export function isGitHubBotCommentUser(
  user:
    | {
        type?: string;
        login?: string;
      }
    | null
    | undefined,
): boolean {
  const type = (user?.type ?? "").toLowerCase();
  if (type === "bot") {
    return true;
  }

  return (user?.login ?? "").trim().toLowerCase().endsWith("[bot]");
}

export function isGitHubCommandRateLimited(params: {
  platform: "github-app" | "github-webhook";
  owner: string;
  repo: string;
  pullNumber: number;
  userLogin?: string;
  command: string;
}): boolean {
  const maxPerWindow = Math.max(
    1,
    readNumberEnv("COMMAND_RATE_LIMIT_MAX", DEFAULT_COMMAND_RATE_LIMIT_MAX),
  );
  const windowMs = Math.max(
    1_000,
    readNumberEnv(
      "COMMAND_RATE_LIMIT_WINDOW_MS",
      DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS,
    ),
  );
  const user = normalizeRateLimitPart(params.userLogin, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key =
    `${params.platform}:` +
    `${normalizeRateLimitPart(params.owner, "unknown-owner")}/` +
    `${normalizeRateLimitPart(params.repo, "unknown-repo")}:` +
    `pr:${params.pullNumber}:user:${user}:cmd:${command}`;
  return isRateLimited(key, maxPerWindow, windowMs);
}

async function shouldRejectGitHubCommandByRateLimit(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  userLogin?: string;
  command: string;
  platform: "github-app" | "github-webhook";
}): Promise<boolean> {
  if (
    !isGitHubCommandRateLimited({
      platform: params.platform,
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      userLogin: params.userLogin,
      command: params.command,
    })
  ) {
    return false;
  }

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: githubCommandRateLimitMessage(resolveUiLocale()),
  });
  return true;
}

function githubCommandRateLimitMessage(locale: UiLocale): string {
  return localizeText(
    {
      zh: "`命令触发过于频繁，请稍后再试（默认每用户每 PR 每小时 10 次）。`",
      en: "`Command triggered too frequently. Please retry later (default: 10 times/hour per user per PR).`",
    },
    locale,
  );
}

function normalizeRateLimitPart(raw: string | undefined, fallback: string): string {
  const normalized = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return normalized || fallback;
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
    if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
      throw new WebhookAuthError(
        "GITHUB_WEBHOOK_SKIP_SIGNATURE is forbidden in production",
        403,
      );
    }
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

  if (!isWebhookSignatureValid(expected, signatureHeader)) {
    throw new WebhookAuthError("invalid webhook signature", 403);
  }
}

export function isWebhookSignatureValid(expected: string, received: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
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

export function createRestBackedOctokit(
  config: RestGitHubClientConfig,
): MinimalGitHubOctokit {
  let lastListPullFilesTruncated = false;
  const listPullFilesTruncated = new Map<string, boolean>();
  const updateListFilesTruncated = (
    params: GitHubPullFilesListParams,
    truncated: boolean,
  ) => {
    const key = buildListPullFilesTruncatedKey(params);
    listPullFilesTruncated.set(key, truncated);
    while (listPullFilesTruncated.size > MAX_LIST_FILES_TRUNCATED_RECORDS) {
      const oldest = listPullFilesTruncated.keys().next();
      if (oldest.done) {
        break;
      }
      listPullFilesTruncated.delete(oldest.value);
    }
    lastListPullFilesTruncated = truncated;
  };

  const listFiles: GitHubPullsListFilesMethod = async (params) => {
    const result = await listPullFiles(config, params);
    updateListFilesTruncated(params, result.truncated);
    return {
      data: result.files,
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
      listComments: async (params) => {
        const data = await requestJson<Array<{ id: number; body?: string | null }>>(
          config,
          {
            method: "GET",
            path: `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues/${params.issue_number}/comments?per_page=${Math.max(1, Math.min(Number(params.per_page ?? 100), 100))}&page=${Math.max(1, Number(params.page ?? 1))}`,
          },
        );
        return {
          data: Array.isArray(data)
            ? data.map((item) => ({
                id: Number(item.id),
                body: typeof item.body === "string" ? item.body : undefined,
              }))
            : [],
        };
      },
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
      const result = await listPullFiles(config, params);
      updateListFilesTruncated(params, result.truncated);
      return result.files;
    },
    __getListFilesTruncated: (params) =>
      listPullFilesTruncated.get(buildListPullFilesTruncatedKey(params)) ?? false,
    __getLastListFilesTruncated: () => lastListPullFilesTruncated,
  };
}

function buildListPullFilesTruncatedKey(params: GitHubPullFilesListParams): string {
  const perPage = Math.max(1, Math.min(Number(params.per_page ?? 100), 100));
  return [
    params.owner.trim().toLowerCase(),
    params.repo.trim().toLowerCase(),
    String(params.pull_number),
    String(perPage),
  ].join("|");
}

async function listPullFiles(
  config: RestGitHubClientConfig,
  params: {
    owner: string;
    repo: string;
    pull_number: number;
    per_page: number;
  },
): Promise<{ files: GitHubPullFile[]; truncated: boolean }> {
  const perPage = Math.max(1, Math.min(params.per_page, 100));
  const items: GitHubPullFile[] = [];
  let truncated = false;

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
    if (page === 20) {
      truncated = true;
      break;
    }

    page += 1;
  }

  return {
    files: items,
    truncated,
  };
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
