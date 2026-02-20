import {
  clearDuplicateRecord,
  ensureError,
  isDuplicateRequest,
  loadAskConversationTurns,
  localizeText,
  pruneExpiredCache,
  readNumberEnv,
  rememberAskConversationTurn,
  resolveUiLocale,
  trimCache,
  type ExpiringCacheEntry,
} from "#core";
import { publishNotification } from "#integrations/notify";
import {
  analyzePullRequest,
  answerPullRequestQuestion,
  buildIssueCommentMarkdown,
  buildReportCommentMarkdown,
  findFileForReview,
  GITHUB_GUIDELINE_DIRECTORIES,
  GITHUB_GUIDELINE_FILE_PATHS,
  isProcessTemplateFile,
  isReviewTargetFile,
  parsePatchWithLineNumbers,
  resolveReviewLineForIssue,
} from "#review";
import type {
  DiffFileContext,
  PullRequestReviewInput,
  PullRequestReviewResult,
  ReviewMode,
  ReviewTrigger,
} from "#review";

const MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS_PER_FILE = 4_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FEEDBACK_SIGNALS = 80;
const MAX_FEEDBACK_CACHE_ENTRIES = 1_000;
const MANAGED_COMMENT_SCAN_PER_PAGE = 100;
const MAX_MANAGED_COMMENT_SCAN_PAGES = 20;
const GITHUB_PULL_FILES_TRUNCATED_WARNING = {
  zh: "⚠️ 文件列表拉取达到上限（最多 20 页 * 100 = 2000 个文件），当前评审结果可能未覆盖全部变更。",
  en: "⚠️ File listing reached the hard limit (20 pages * 100 = 2000 files); this review may not cover all changed files.",
} as const;

type ProcessGuideline = { path: string; content: string };
type SecretFinding = {
  path: string;
  line: number;
  kind: string;
  sample: string;
};

type ProcessGuidelineCacheEntry = ExpiringCacheEntry<ProcessGuideline[]>;
type IncrementalHeadCacheEntry = ExpiringCacheEntry<string>;
type FeedbackSignalCacheEntry = ExpiringCacheEntry<string[]>;

const guidelineCache = new Map<string, ProcessGuidelineCacheEntry>();
const incrementalHeadCache = new Map<string, IncrementalHeadCacheEntry>();
const feedbackSignalCache = new Map<string, FeedbackSignalCacheEntry>();

export interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitHubPullSummary {
  title: string;
  body: string | null;
  user: { login: string } | null;
  draft?: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  html_url: string;
}

export interface GitHubIssueCommentSummary {
  id: number;
  body?: string | null;
}

export interface GitHubPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubCompareCommitsResponse {
  files?: GitHubPullFile[];
}

export interface GitHubCheckRunSummary {
  name?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  };
}

export interface GitHubCheckRunCreateParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  details_url?: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required";
  completed_at?: string;
  output?: {
    title: string;
    summary: string;
    text?: string;
  };
}

export interface GitHubRepositoryContentFile {
  type?: "file" | "dir" | string;
  path?: string;
  encoding?: string;
  content?: string;
  sha?: string;
}

export type GitHubPullsListFilesMethod = (params: {
  owner: string;
  repo: string;
  pull_number: number;
  per_page: number;
  page?: number;
}) => Promise<{ data: GitHubPullFile[] }>;

export interface MinimalGitHubOctokit {
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<{
      data: GitHubRepositoryContentFile | GitHubRepositoryContentFile[];
    }>;
    compareCommits?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      base: string;
      head: string;
    }): Promise<{
      data: GitHubCompareCommitsResponse;
    }>;
    createOrUpdateFileContents?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      path: string;
      message: string;
      content: string;
      sha?: string;
      branch?: string;
    }): Promise<unknown>;
  };
  pulls: {
    get(params: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: GitHubPullSummary }>;
    listFiles: GitHubPullsListFilesMethod;
    createReviewComment(params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
      commit_id: string;
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
    }): Promise<unknown>;
    update(params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
    }): Promise<unknown>;
  };
  issues: {
    listComments?(params: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: GitHubIssueCommentSummary[] }>;
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number } }>;
    updateComment(params: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<unknown>;
    addLabels?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<unknown>;
  };
  checks?: {
    create(params: GitHubCheckRunCreateParams): Promise<unknown>;
    listForRef?(params: {
      [key: string]: unknown;
      owner: string;
      repo: string;
      ref: string;
      per_page?: number;
    }): Promise<{
      data: { check_runs?: GitHubCheckRunSummary[] };
    }>;
  };
  paginate(
    method: GitHubPullsListFilesMethod,
    params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
    },
  ): Promise<GitHubPullFile[]>;
  __getLastListFilesTruncated?(): boolean;
}

export interface GitHubReviewContext {
  repo(): { owner: string; repo: string };
  octokit: MinimalGitHubOctokit;
  log: LoggerLike;
}

interface GitHubReviewRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  mode: ReviewMode;
  trigger: ReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  enableSecretScan?: boolean;
  enableAutoLabel?: boolean;
  throwOnError?: boolean;
}

interface GitHubDescribeRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  apply?: boolean;
  trigger: ReviewTrigger;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

interface GitHubAskRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  question: string;
  trigger: ReviewTrigger;
  managedCommentKey?: string;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  enableConversationContext?: boolean;
  throwOnError?: boolean;
}

interface GitHubChangelogRunParams {
  context: GitHubReviewContext;
  pullNumber: number;
  trigger: ReviewTrigger;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}

interface GitHubCollectedContext {
  input: PullRequestReviewInput;
  files: DiffFileContext[];
  filesTruncated: boolean;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  author: string;
}

export function resolveGitHubPatchCharLimits(): {
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
} {
  const maxPatchCharsPerFile = Math.max(
    1,
    readNumberEnv(
      "GITHUB_MAX_PATCH_CHARS_PER_FILE",
      DEFAULT_MAX_PATCH_CHARS_PER_FILE,
    ),
  );
  const maxTotalPatchChars = Math.max(
    maxPatchCharsPerFile,
    readNumberEnv(
      "GITHUB_MAX_TOTAL_PATCH_CHARS",
      DEFAULT_MAX_TOTAL_PATCH_CHARS,
    ),
  );

  return {
    maxPatchCharsPerFile,
    maxTotalPatchChars,
  };
}

type ManagedGitHubCommentKey = string;

function normalizeManagedGitHubCommentKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return normalized || "default";
}

function hashManagedKeySeed(raw: string): string {
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildManagedCommandCommentKey(
  command: string,
  seed: string,
): string {
  const commandKey = normalizeManagedGitHubCommentKey(`cmd-${command}`).replace(
    /:/g,
    "-",
  );
  const normalizedSeed = seed.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
  return `${commandKey}:${hashManagedKeySeed(normalizedSeed)}`;
}

function managedGitHubCommentMarker(key: ManagedGitHubCommentKey): string {
  return `<!-- mr-agent:${normalizeManagedGitHubCommentKey(key)} -->`;
}

function managedGitHubCommentBody(
  body: string,
  key: ManagedGitHubCommentKey,
): string {
  return `${body.trim()}\n\n${managedGitHubCommentMarker(key)}`;
}

function isGitHubAutoReviewTrigger(trigger: ReviewTrigger): boolean {
  return (
    trigger === "pr-opened" ||
    trigger === "pr-edited" ||
    trigger === "pr-synchronize"
  );
}

function shouldUseManagedReviewSummary(trigger: ReviewTrigger): boolean {
  return isGitHubAutoReviewTrigger(trigger) || trigger === "merged";
}

export function shouldSkipGitHubReviewForDraft(
  trigger: ReviewTrigger,
  isDraft: boolean,
): boolean {
  return isDraft && isGitHubAutoReviewTrigger(trigger);
}

export async function upsertGitHubManagedIssueComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  markerKey: ManagedGitHubCommentKey;
}): Promise<void> {
  const marker = managedGitHubCommentMarker(params.markerKey);
  const nextBody = managedGitHubCommentBody(params.body, params.markerKey);
  const listComments = params.context.octokit.issues.listComments;
  if (listComments) {
    try {
      for (let page = 1; page <= MAX_MANAGED_COMMENT_SCAN_PAGES; page += 1) {
        const listed = await listComments({
          owner: params.owner,
          repo: params.repo,
          issue_number: params.issueNumber,
          per_page: MANAGED_COMMENT_SCAN_PER_PAGE,
          page,
        });
        const existing = listed.data.find((item) => item.body?.includes(marker));
        if (existing) {
          await params.context.octokit.issues.updateComment({
            owner: params.owner,
            repo: params.repo,
            comment_id: existing.id,
            body: nextBody,
          });
          return;
        }
        if (listed.data.length < MANAGED_COMMENT_SCAN_PER_PAGE) {
          break;
        }
      }
    } catch (error) {
      params.context.log.error(
        {
          owner: params.owner,
          repo: params.repo,
          issueNumber: params.issueNumber,
          markerKey: params.markerKey,
          error: getErrorMessage(error),
        },
        "Failed to list/update managed GitHub issue comment; falling back to create",
      );
    }
  }

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: nextBody,
  });
}

export async function postGitHubCommandComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  managedCommentKey?: string;
}): Promise<void> {
  if (params.managedCommentKey) {
    await upsertGitHubManagedIssueComment({
      context: params.context,
      owner: params.owner,
      repo: params.repo,
      issueNumber: params.issueNumber,
      body: params.body,
      markerKey: params.managedCommentKey,
    });
    return;
  }

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.issueNumber,
    body: params.body,
  });
}

export async function publishGitHubNoDiffStatus(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  progressCommentId?: number;
  markerKey: ManagedGitHubCommentKey;
  body?: string;
}): Promise<void> {
  const locale = resolveUiLocale();
  const body =
    params.body?.trim() ||
    localizeText(
      {
        zh: "`AI Review` 未发现可评审的文本改动，已跳过。",
        en: "`AI Review` found no textual changes to review, skipped.",
      },
      locale,
    );
  if (params.progressCommentId) {
    await params.context.octokit.issues.updateComment({
      owner: params.owner,
      repo: params.repo,
      comment_id: params.progressCommentId,
      body: managedGitHubCommentBody(body, params.markerKey),
    });
    return;
  }

  await upsertGitHubManagedIssueComment({
    context: params.context,
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.pullNumber,
    body,
    markerKey: params.markerKey,
  });
}

export async function runGitHubReview(
  params: GitHubReviewRunParams,
): Promise<void> {
  const {
    context,
    pullNumber,
    mode,
    trigger,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    enableAutoLabel = true,
    throwOnError = false,
  } = params;
  const { owner, repo } = context.repo();
  const locale = resolveUiLocale();
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  const dedupeTtlMs = resolveDedupeTtlMs(trigger, mode);

  if (isDuplicateRequest(requestKey, dedupeTtlMs)) {
    if (trigger === "comment-command") {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: localizeText(
          {
            zh: "`AI Review` 最近 5 分钟内已经执行过，本次请求已跳过。",
            en: "`AI Review` already ran in the last 5 minutes, skipped this request.",
          },
          locale,
        ),
      });
    }
    return;
  }

  context.log.info(
    { owner, repo, pullNumber, mode, trigger },
    "Starting GitHub AI review",
  );

  const reviewPrKey = `${owner}/${repo}#${pullNumber}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? getIncrementalHead(reviewPrKey)
    : undefined;
  const feedbackSignals = loadGitHubFeedbackSignals(owner, repo, pullNumber);
  let preloadedPullSummary: GitHubPullSummary | undefined;

  if (isGitHubAutoReviewTrigger(trigger)) {
    const prMeta = await context.octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    preloadedPullSummary = prMeta.data;
    if (shouldSkipGitHubReviewForDraft(trigger, Boolean(prMeta.data.draft))) {
      context.log.info(
        { owner, repo, pullNumber, trigger },
        "Skipping GitHub AI review for draft pull request",
      );
      return;
    }
    if (
      trigger === "pr-edited" &&
      incrementalBaseSha &&
      incrementalBaseSha === prMeta.data.head.sha
    ) {
      context.log.info(
        { owner, repo, pullNumber, trigger, headSha: prMeta.data.head.sha },
        "Skipping GitHub AI review for pull_request.edited without code changes",
      );
      return;
    }
  }

  let progressCommentId: number | undefined;
  if (trigger === "comment-command") {
    const progress = await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: localizeText(
        {
          zh: "`AI Review` 正在分析这个 PR，请稍候...",
          en: "`AI Review` is analyzing this PR, please wait...",
        },
        locale,
      ),
    });
    progressCommentId = progress.data.id;
  }

  try {
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      incrementalBaseSha,
      customRules,
      includeCiChecks,
      feedbackSignals,
      pullSummary: preloadedPullSummary,
    });

    if (collected.files.length === 0) {
      const noDiffBody = collected.filesTruncated
        ? appendGitHubFilesTruncatedWarning(
            localizeText(
              {
                zh: "`AI Review` 未发现可评审的文本改动。",
                en: "`AI Review` found no textual changes to review.",
              },
              locale,
            ),
            locale,
          )
        : undefined;
      await publishGitHubNoDiffStatus({
        context,
        owner,
        repo,
        pullNumber,
        progressCommentId,
        markerKey: "review-no-diff",
        body: noDiffBody,
      });
      rememberIncrementalHead(reviewPrKey, collected.headSha);
      return;
    }

    const reviewResult = await analyzePullRequest(collected.input);

    if (mode === "comment") {
      const posted = await publishGitHubLineComments(
        context,
        collected,
        reviewResult,
        locale,
      );
      const summaryBody = [
        localizeText(
          {
            zh: "## AI 评审结果（Comment 模式）",
            en: "## AI Review Result (Comment Mode)",
          },
          locale,
        ),
        "",
        localizeText(
          {
            zh: `已发布行级评论: **${posted.posted}**，跳过: **${posted.skipped}**`,
            en: `Line comments posted: **${posted.posted}**, skipped: **${posted.skipped}**`,
          },
          locale,
        ),
        "",
        localizeText(
          {
            zh: "如需汇总报告，请评论：`/ai-review report`",
            en: "For a consolidated report, comment: `/ai-review report`",
          },
          locale,
        ),
      ].join("\n");
      const summaryBodyWithWarning = maybeAppendGitHubFilesTruncatedWarning(
        summaryBody,
        collected.filesTruncated,
        locale,
      );
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitHubManagedIssueComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: summaryBodyWithWarning,
          markerKey: "review-comment-summary",
        });
      } else {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: summaryBodyWithWarning,
        });
      }
    } else {
      const body = buildReportCommentMarkdown(reviewResult, collected.files, {
        platform: "github",
        owner: collected.owner,
        repo: collected.repo,
        baseSha: collected.baseSha,
        headSha: collected.headSha,
      }, {
        locale,
      });
      const bodyWithWarning = maybeAppendGitHubFilesTruncatedWarning(
        body,
        collected.filesTruncated,
        locale,
      );
      if (shouldUseManagedReviewSummary(trigger)) {
        await upsertGitHubManagedIssueComment({
          context,
          owner,
          repo,
          issueNumber: pullNumber,
          body: bodyWithWarning,
          markerKey: "review-report",
        });
      } else {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: bodyWithWarning,
        });
      }
    }

    if (enableSecretScan) {
      const findings = findPotentialSecrets(collected.files);
      if (findings.length > 0) {
        await publishSecretWarningComment({
          context,
          owner,
          repo,
          pullNumber,
          headSha: collected.headSha,
          findings,
        });
      }

      if (enableAutoLabel) {
        const labels = inferPullRequestLabels({
          title: collected.input.title,
          files: collected.files,
          reviewResult,
          hasSecretFinding: findings.length > 0,
        });
        await tryAddPullRequestLabels({
          context,
          owner,
          repo,
          pullNumber,
          labels,
        });
      }
    } else if (enableAutoLabel) {
      const labels = inferPullRequestLabels({
        title: collected.input.title,
        files: collected.files,
        reviewResult,
        hasSecretFinding: false,
      });
      await tryAddPullRequestLabels({
        context,
        owner,
        repo,
        pullNumber,
        labels,
      });
    }

    rememberIncrementalHead(reviewPrKey, collected.headSha);

    if (progressCommentId) {
      await context.octokit.issues.updateComment({
        owner,
        repo,
        comment_id: progressCommentId,
        body: localizeText(
          {
            zh: "`AI Review` 分析完成，结果已发布。",
            en: "`AI Review` analysis completed. Results have been published.",
          },
          locale,
        ),
      });
    }

    try {
      await publishNotification({
        pushUrl: process.env.GITHUB_PUSH_URL ?? process.env.NOTIFY_WEBHOOK_URL,
        author: collected.author,
        repository: `${owner}/${repo}`,
        sourceBranch: collected.headBranch,
        targetBranch: collected.baseBranch,
        content: localizeText(
          {
            zh: `代码评审完毕 https://github.com/${owner}/${repo}/pull/${pullNumber}`,
            en: `Code review completed https://github.com/${owner}/${repo}/pull/${pullNumber}`,
          },
          locale,
        ),
      });
    } catch (notifyError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(notifyError),
        },
        "Failed to publish GitHub success notification",
      );
    }
  } catch (error) {
    clearDuplicateRecord(requestKey);

    const reason = getErrorMessage(error);
    const publicReason = getPublicErrorMessage(error);
    context.log.error(
      { owner, repo, pullNumber, mode, trigger, error: reason },
      "GitHub AI review failed",
    );

    try {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          localizeText(
            {
              zh: "## AI Review 执行失败",
              en: "## AI Review Failed",
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: `错误：\`${publicReason}\``,
              en: `Error: \`${publicReason}\``,
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: "请检查 AI_PROVIDER/模型 API Key/GitHub App 权限配置。",
              en: "Please check AI_PROVIDER/model API key/GitHub App permission settings.",
            },
            locale,
          ),
        ].join("\n"),
      });
    } catch (commentError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(commentError),
        },
        "Failed to publish GitHub failure comment",
      );
    }

    if (progressCommentId) {
      try {
        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: progressCommentId,
          body: localizeText(
            {
              zh: "`AI Review` 执行失败，请查看下方错误说明。",
              en: "`AI Review` failed. See the error details below.",
            },
            locale,
          ),
        });
      } catch (updateError) {
        context.log.error(
          {
            owner,
            repo,
            pullNumber,
            mode,
            trigger,
            progressCommentId,
            error: getErrorMessage(updateError),
          },
          "Failed to update GitHub progress comment after failure",
        );
      }
    }

    try {
      await publishNotification({
        pushUrl: process.env.GITHUB_PUSH_URL ?? process.env.NOTIFY_WEBHOOK_URL,
        author: "system",
        repository: `${owner}/${repo}`,
        sourceBranch: "-",
        targetBranch: "-",
        content: localizeText(
          {
            zh: `代码评审失败: ${publicReason}`,
            en: `Code review failed: ${publicReason}`,
          },
          locale,
        ),
      });
    } catch (notifyError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          mode,
          trigger,
          error: getErrorMessage(notifyError),
        },
        "Failed to publish GitHub failure notification",
      );
    }

    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

export function maybeAppendGitHubFilesTruncatedWarning(
  body: string,
  filesTruncated: boolean,
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  if (!filesTruncated) {
    return body;
  }

  return appendGitHubFilesTruncatedWarning(body, locale);
}

export function appendGitHubFilesTruncatedWarning(
  body: string,
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  return [
    body.trim(),
    "",
    localizeText(
      {
        zh: GITHUB_PULL_FILES_TRUNCATED_WARNING.zh,
        en: GITHUB_PULL_FILES_TRUNCATED_WARNING.en,
      },
      locale,
    ),
  ].join("\n");
}

export function recordGitHubFeedbackSignal(params: {
  owner: string;
  repo: string;
  pullNumber?: number;
  signal: string;
}): void {
  const feedbackKey = buildGitHubFeedbackSignalKey(
    params.owner,
    params.repo,
    params.pullNumber,
  );
  const normalizedSignal = params.signal.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!normalizedSignal) {
    return;
  }

  const now = Date.now();
  const ttlMs = readNumberEnv(
    "GITHUB_FEEDBACK_SIGNAL_TTL_MS",
    DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
  );
  pruneExpiredCache(feedbackSignalCache, now);
  const currentSignals = feedbackSignalCache.get(feedbackKey)?.value ?? [];
  const nextSignals = [
    normalizedSignal,
    ...currentSignals.filter((item) => item !== normalizedSignal),
  ].slice(0, MAX_FEEDBACK_SIGNALS);

  feedbackSignalCache.set(feedbackKey, {
    value: nextSignals,
    expiresAt: now + ttlMs,
  });
  trimCache(feedbackSignalCache, MAX_FEEDBACK_CACHE_ENTRIES);
}

function resolveDedupeTtlMs(
  trigger: ReviewTrigger,
  mode: ReviewMode,
): number {
  if (trigger === "merged" && mode === "report") {
    return readNumberEnv(
      "GITHUB_MERGED_DEDUPE_TTL_MS",
      DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS,
    );
  }

  return DEFAULT_DEDUPE_TTL_MS;
}

function loadGitHubFeedbackSignals(
  owner: string,
  repo: string,
  pullNumber?: number,
): string[] {
  const feedbackKey = buildGitHubFeedbackSignalKey(owner, repo, pullNumber);
  const repositoryLevelKey = buildGitHubFeedbackSignalKey(owner, repo);
  const now = Date.now();
  pruneExpiredCache(feedbackSignalCache, now);
  const scoped = feedbackSignalCache.get(feedbackKey)?.value ?? [];
  const repositoryLevel = feedbackSignalCache.get(repositoryLevelKey)?.value ?? [];
  if (
    !Number.isInteger(pullNumber) ||
    (pullNumber as number) <= 0 ||
    feedbackKey === repositoryLevelKey
  ) {
    return repositoryLevel;
  }
  if (scoped.length === 0) {
    return repositoryLevel;
  }

  const merged = [
    ...scoped,
    ...repositoryLevel.filter((signal) => !scoped.includes(signal)),
  ];
  return merged.slice(0, MAX_FEEDBACK_SIGNALS);
}

function buildGitHubFeedbackSignalKey(
  owner: string,
  repo: string,
  pullNumber?: number,
): string {
  const base = `${owner}/${repo}`;
  if (!Number.isInteger(pullNumber) || (pullNumber as number) <= 0) {
    return base;
  }

  return `${base}#${pullNumber}`;
}

export function __readGitHubFeedbackSignalsForTests(
  owner: string,
  repo: string,
  pullNumber?: number,
): string[] {
  return loadGitHubFeedbackSignals(owner, repo, pullNumber);
}

export function __clearGitHubFeedbackSignalCacheForTests(): void {
  feedbackSignalCache.clear();
}

async function collectGitHubPullRequestContext(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  pullNumber: number;
  incrementalBaseSha?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  feedbackSignals?: string[];
  pullSummary?: GitHubPullSummary;
}): Promise<GitHubCollectedContext> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    incrementalBaseSha,
    customRules,
    includeCiChecks = true,
    feedbackSignals,
    pullSummary,
  } = params;

  const pr =
    pullSummary ??
    (
      await octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      })
    ).data;
  let files: GitHubPullFile[];
  let filesTruncated = false;
  if (incrementalBaseSha && incrementalBaseSha !== pr.head.sha) {
    const incrementalResult = await loadIncrementalPullFiles({
      octokit,
      owner,
      repo,
      pullNumber,
      incrementalBaseSha,
      headSha: pr.head.sha,
    });
    files = incrementalResult.files;
    filesTruncated = incrementalResult.truncated;
  } else {
    files = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    filesTruncated = octokit.__getLastListFilesTruncated?.() ?? false;
  }

  const changedFiles: DiffFileContext[] = [];
  const limits = resolveGitHubPatchCharLimits();
  let totalPatchChars = 0;

  for (const file of files) {
    if (
      changedFiles.length >= MAX_FILES ||
      totalPatchChars >= limits.maxTotalPatchChars
    ) {
      break;
    }

    if (!isReviewTargetFile(file.filename, "github")) {
      continue;
    }

    const rawPatch = file.patch ?? "(binary / patch omitted)";
    const trimmedPatch =
      rawPatch.length > limits.maxPatchCharsPerFile
        ? `${rawPatch.slice(0, limits.maxPatchCharsPerFile)}\n... [patch truncated]`
        : rawPatch;

    if (totalPatchChars + trimmedPatch.length > limits.maxTotalPatchChars) {
      break;
    }

    totalPatchChars += trimmedPatch.length;
    const parsedPatch = parsePatchWithLineNumbers(trimmedPatch);

    changedFiles.push({
      newPath: file.filename,
      oldPath: file.previous_filename ?? file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: trimmedPatch,
      extendedDiff: parsedPatch.extendedDiff,
      oldLinesWithNumber: parsedPatch.oldLinesWithNumber,
      newLinesWithNumber: parsedPatch.newLinesWithNumber,
    });
  }

  const promptAdditions =
    incrementalBaseSha && incrementalBaseSha !== pr.head.sha
      ? changedFiles.reduce((sum, item) => sum + Math.max(0, item.additions), 0)
      : pr.additions;
  const promptDeletions =
    incrementalBaseSha && incrementalBaseSha !== pr.head.sha
      ? changedFiles.reduce((sum, item) => sum + Math.max(0, item.deletions), 0)
      : pr.deletions;
  const changedFilesCount =
    incrementalBaseSha && incrementalBaseSha !== pr.head.sha
      ? changedFiles.length
      : pr.changed_files;

  const processGuidelines = await loadRepositoryProcessGuidelines({
    octokit,
    owner,
    repo,
    ref: pr.base.ref,
  });
  const ciChecks = includeCiChecks
    ? await loadHeadCheckRuns({
        octokit,
        owner,
        repo,
        headSha: pr.head.sha,
      })
    : [];

  const input: PullRequestReviewInput = {
    platform: "github",
    repository: `${owner}/${repo}`,
    number: pullNumber,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    additions: promptAdditions,
    deletions: promptDeletions,
    changedFilesCount,
    changedFiles: changedFiles.map((file) => ({
      newPath: file.newPath,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      extendedDiff: file.extendedDiff,
    })),
    customRules: customRules ?? [],
    feedbackSignals: feedbackSignals ?? [],
    ciChecks,
    processGuidelines,
  };

  return {
    input,
    files: changedFiles,
    filesTruncated,
    owner,
    repo,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    author: pr.user?.login ?? "unknown",
  };
}

async function publishGitHubLineComments(
  context: GitHubReviewContext,
  collected: GitHubCollectedContext,
  reviewResult: PullRequestReviewResult,
  locale: "zh" | "en",
): Promise<{ posted: number; skipped: number }> {
  const { owner, repo } = collected;
  let posted = 0;
  let skipped = 0;

  for (const review of reviewResult.reviews) {
    const file = findFileForReview(collected.files, review);
    if (!file) {
      skipped += 1;
      continue;
    }

    const line = resolveReviewLineForIssue(file, review);
    if (!line) {
      skipped += 1;
      continue;
    }

    try {
      await context.octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: collected.input.number,
        body: buildIssueCommentMarkdown(review, { platform: "github", locale }),
        commit_id: collected.headSha,
        path: file.newPath,
        line,
        side: review.type === "new" ? "RIGHT" : "LEFT",
      });
      posted += 1;
    } catch {
      skipped += 1;
    }
  }

  return { posted, skipped };
}

export async function runGitHubDescribe(
  params: GitHubDescribeRunParams,
): Promise<void> {
  const {
    context,
    pullNumber,
    apply = false,
    trigger,
    dedupeSuffix,
    throwOnError = false,
  } = params;
  const { owner, repo } = context.repo();
  const locale = resolveUiLocale();
  const managedCommentKey = "cmd-describe";
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:describe:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    if (trigger === "comment-command" || trigger === "describe-command") {
      await postGitHubCommandComment({
        context,
        owner,
        repo,
        issueNumber: pullNumber,
        body: localizeText(
          {
            zh: "`AI Describe` 最近 5 分钟内已经执行过，本次请求已跳过。",
            en: "`AI Describe` already ran in the last 5 minutes, skipped this request.",
          },
          locale,
        ),
        managedCommentKey,
      });
    }
    return;
  }

  try {
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
    });
    const description = await answerPullRequestQuestion(
      collected.input,
      buildGitHubDescribeQuestion(locale),
    );

    if (apply) {
      await context.octokit.pulls.update({
        owner,
        repo,
        pull_number: pullNumber,
        body: description,
      });
      await postGitHubCommandComment({
        context,
        owner,
        repo,
        issueNumber: pullNumber,
        body: [
          localizeText(
            {
              zh: "## AI PR 描述已更新",
              en: "## AI PR Description Updated",
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: "已根据当前 diff 自动生成并写入 PR 描述。",
              en: "The PR description was generated from the current diff and applied.",
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
      });
      return;
    }

    await postGitHubCommandComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      body: [
        localizeText(
          {
            zh: "## AI 生成 PR 描述草稿",
            en: "## AI PR Description Draft",
          },
          locale,
        ),
        "",
        "```markdown",
        description,
        "```",
        "",
        localizeText(
          {
            zh: "如需自动写入 PR 描述，请使用：`/describe --apply`",
            en: "To apply this draft to the PR description, use: `/describe --apply`",
          },
          locale,
        ),
      ].join("\n"),
      managedCommentKey,
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    const reason = getErrorMessage(error);
    context.log.error(
      { owner, repo, pullNumber, trigger, apply, error: reason },
      "GitHub describe failed",
    );

    try {
      await postGitHubCommandComment({
        context,
        owner,
        repo,
        issueNumber: pullNumber,
        body: [
          localizeText(
            {
              zh: "## AI Describe 执行失败",
              en: "## AI Describe Failed",
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: `错误：\`${getPublicErrorMessage(error)}\``,
              en: `Error: \`${getPublicErrorMessage(error)}\``,
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
      });
    } catch (commentError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          trigger,
          apply,
          error: getErrorMessage(commentError),
        },
        "Failed to publish GitHub describe failure comment",
      );
    }

    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

export async function runGitHubAsk(
  params: GitHubAskRunParams,
): Promise<void> {
  const {
    context,
    pullNumber,
    question,
    trigger,
    managedCommentKey,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    commentTitle = "AI Ask",
    displayQuestion,
    enableConversationContext = false,
    throwOnError = false,
  } = params;
  const { owner, repo } = context.repo();
  const locale = resolveUiLocale();
  const normalizedQuestion = question.trim().replace(/\s+/g, " ").slice(0, 120);
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:ask:${trigger}:${normalizedQuestion}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await postGitHubCommandComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      body: localizeText(
        {
          zh: `\`${commentTitle}\` 最近 5 分钟内已回答过相同问题，本次请求已跳过。`,
          en: `\`${commentTitle}\` already answered the same question in the last 5 minutes, skipped this request.`,
        },
        locale,
      ),
      managedCommentKey,
    });
    return;
  }

  try {
    const feedbackSignals = loadGitHubFeedbackSignals(owner, repo, pullNumber);
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });
    const sessionKey = `github:${owner}/${repo}#${pullNumber}`;
    const conversation = enableConversationContext
      ? loadAskConversationTurns(sessionKey)
      : [];
    const answer = await answerPullRequestQuestion(collected.input, question, {
      conversation,
    });
    if (enableConversationContext) {
      rememberAskConversationTurn({
        sessionKey,
        question: (displayQuestion ?? question).trim(),
        answer,
      });
    }
    await postGitHubCommandComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      body: [
        `## ${commentTitle}`,
        "",
        `**Q:** ${(displayQuestion ?? question).trim()}`,
        "",
        `**A:** ${answer}`,
      ].join("\n"),
      managedCommentKey,
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    context.log.error(
      {
        owner,
        repo,
        pullNumber,
        trigger,
        error: getErrorMessage(error),
      },
      "GitHub ask failed",
    );

    try {
      await postGitHubCommandComment({
        context,
        owner,
        repo,
        issueNumber: pullNumber,
        body: [
          localizeText(
            {
              zh: `## ${commentTitle} 执行失败`,
              en: `## ${commentTitle} Failed`,
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: `错误：\`${getPublicErrorMessage(error)}\``,
              en: `Error: \`${getPublicErrorMessage(error)}\``,
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
      });
    } catch (commentError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          trigger,
          error: getErrorMessage(commentError),
        },
        "Failed to publish GitHub ask failure comment",
      );
    }

    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

export async function runGitHubChangelog(
  params: GitHubChangelogRunParams,
): Promise<void> {
  const {
    context,
    pullNumber,
    trigger,
    focus,
    apply = false,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    throwOnError = false,
  } = params;
  const { owner, repo } = context.repo();
  const locale = resolveUiLocale();
  const managedCommentKey = "cmd-changelog";
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:changelog:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await postGitHubCommandComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      body: localizeText(
        {
          zh: "`AI Changelog` 最近 5 分钟内已执行过同类请求，本次已跳过。",
          en: "`AI Changelog` already handled a similar request in the last 5 minutes, skipped this request.",
        },
        locale,
      ),
      managedCommentKey,
    });
    return;
  }

  try {
    const feedbackSignals = loadGitHubFeedbackSignals(owner, repo, pullNumber);
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });
    const question = buildGitHubChangelogQuestion(focus, locale);
    const draft = (await answerPullRequestQuestion(collected.input, question)).trim();

    if (!apply) {
      await postGitHubCommandComment({
        context,
        owner,
        repo,
        issueNumber: pullNumber,
        body: [
          "## AI Changelog Draft",
          "",
          draft,
          "",
          localizeText(
            {
              zh: "如需自动写入仓库 CHANGELOG，请使用：`/changelog --apply`。",
              en: "To apply this draft to repository CHANGELOG, use: `/changelog --apply`.",
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
      });
      return;
    }

    const applyResult = await applyGitHubChangelogUpdate({
      context,
      owner,
      repo,
      branch: collected.headBranch,
      pullNumber,
      draft,
    });
    await postGitHubCommandComment({
      context,
      owner,
      repo,
      issueNumber: pullNumber,
      body: [
        localizeText(
          {
            zh: "## AI Changelog 已更新",
            en: "## AI Changelog Updated",
          },
          locale,
        ),
        "",
        applyResult.message,
        "",
        "```markdown",
        draft,
        "```",
      ].join("\n"),
      managedCommentKey,
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    context.log.error(
      {
        owner,
        repo,
        pullNumber,
        trigger,
        apply,
        error: getErrorMessage(error),
      },
      "GitHub changelog failed",
    );

    try {
      await postGitHubCommandComment({
        context,
        owner,
        repo,
        issueNumber: pullNumber,
        body: [
          localizeText(
            {
              zh: "## AI Changelog 执行失败",
              en: "## AI Changelog Failed",
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: `错误：\`${getPublicErrorMessage(error)}\``,
              en: `Error: \`${getPublicErrorMessage(error)}\``,
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
      });
    } catch (commentError) {
      context.log.error(
        {
          owner,
          repo,
          pullNumber,
          trigger,
          apply,
          error: getErrorMessage(commentError),
        },
        "Failed to publish GitHub changelog failure comment",
      );
    }

    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

async function loadIncrementalPullFiles(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  pullNumber: number;
  incrementalBaseSha: string;
  headSha: string;
}): Promise<{ files: GitHubPullFile[]; truncated: boolean }> {
  if (!params.octokit.repos.compareCommits) {
    const files = await params.octokit.paginate(params.octokit.pulls.listFiles, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100,
    });
    return {
      files,
      truncated: params.octokit.__getLastListFilesTruncated?.() ?? false,
    };
  }

  try {
    const compared = await params.octokit.repos.compareCommits({
      owner: params.owner,
      repo: params.repo,
      base: params.incrementalBaseSha,
      head: params.headSha,
    });
    const files = compared.data.files ?? [];
    if (files.length > 0) {
      return {
        files,
        truncated: false,
      };
    }
  } catch {
    // Fallback to full file list when compare API is unavailable or SHAs are invalid.
  }

  const files = await params.octokit.paginate(params.octokit.pulls.listFiles, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });
  return {
    files,
    truncated: params.octokit.__getLastListFilesTruncated?.() ?? false,
  };
}

async function loadHeadCheckRuns(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<
  Array<{
    name: string;
    status: string;
    conclusion: string;
    detailsUrl?: string;
    summary?: string;
  }>
> {
  if (!params.octokit.checks?.listForRef) {
    return [];
  }

  try {
    const response = await params.octokit.checks.listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.headSha,
      per_page: 100,
    });
    const checkRuns = response.data.check_runs ?? [];
    return checkRuns.slice(0, 50).map((item) => ({
      name: item.name ?? "unknown-check",
      status: item.status ?? "unknown",
      conclusion: (item.conclusion ?? "pending").toString(),
      detailsUrl: item.details_url ?? item.html_url ?? undefined,
      summary:
        item.output?.summary?.trim() ||
        item.output?.title?.trim() ||
        undefined,
    }));
  } catch {
    return [];
  }
}

function shouldUseIncrementalReview(trigger: ReviewTrigger): boolean {
  return trigger === "pr-synchronize" || trigger === "pr-edited";
}

function getIncrementalHead(reviewPrKey: string): string | undefined {
  const now = Date.now();
  pruneExpiredCache(incrementalHeadCache, now);
  const cached = incrementalHeadCache.get(reviewPrKey);
  if (!cached || cached.expiresAt <= now) {
    return undefined;
  }

  return cached.value;
}

function rememberIncrementalHead(reviewPrKey: string, headSha: string): void {
  const now = Date.now();
  incrementalHeadCache.set(reviewPrKey, {
    expiresAt:
      now +
      readNumberEnv(
        "GITHUB_INCREMENTAL_STATE_TTL_MS",
        DEFAULT_INCREMENTAL_STATE_TTL_MS,
      ),
    value: headSha,
  });
  trimCache(incrementalHeadCache, MAX_INCREMENTAL_STATE_ENTRIES);
}

function findPotentialSecrets(files: DiffFileContext[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const candidate of extractAddedLines(file.patch, file.newPath)) {
      const secret = detectSecretOnLine(candidate.text);
      if (!secret) {
        continue;
      }
      if (isLikelyPlaceholder(candidate.text)) {
        continue;
      }

      const key = `${candidate.path}:${candidate.line}:${secret.kind}:${secret.sample}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({
        path: candidate.path,
        line: candidate.line,
        kind: secret.kind,
        sample: secret.sample,
      });
      if (findings.length >= 10) {
        return findings;
      }
    }
  }

  return findings;
}

function extractAddedLines(
  patch: string,
  path: string,
): Array<{ path: string; line: number; text: string }> {
  const lines = patch.split("\n");
  const results: Array<{ path: string; line: number; text: string }> = [];
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      newLine = match ? Number(match[1]) : newLine;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      results.push({
        path,
        line: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }

    if (!line.startsWith("\\")) {
      newLine += 1;
    }
  }

  return results;
}

function detectSecretOnLine(text: string): { kind: string; sample: string } | undefined {
  const rules: Array<{ kind: string; pattern: RegExp }> = [
    { kind: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    {
      kind: "GitHub Token",
      pattern: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b/,
    },
    {
      kind: "Private Key",
      pattern: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/,
    },
    {
      kind: "Generic Credential",
      pattern:
        /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\\n]{8,}["']/i,
    },
    {
      kind: "JWT-like Token",
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    },
  ];

  for (const rule of rules) {
    const matched = text.match(rule.pattern);
    if (!matched) {
      continue;
    }

    return {
      kind: rule.kind,
      sample: redactSecretSample(matched[0]),
    };
  }

  return undefined;
}

function redactSecretSample(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 10) {
    return `${compact.slice(0, 2)}***`;
  }

  return `${compact.slice(0, 4)}***${compact.slice(-4)}`;
}

export function isLikelyPlaceholder(text: string): boolean {
  const normalized = text.toLowerCase();
  const placeholderPatterns = [
    /\bchange[_-]?me\b/,
    /\byour[_-]?(api[_-]?key|token|secret|password)[_-]?here\b/,
    /\bfill[_-]?in[_-]?your(?:[_-]?(api[_-]?key|token|secret|password))?\b/,
    /<\s*your[-_a-z0-9]+\s*>/,
    /\bxxx+\b/,
    /\btodo\b/,
  ];
  if (placeholderPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return (
    normalized.includes("example") ||
    normalized.includes("sample") ||
    normalized.includes("dummy") ||
    normalized.includes("placeholder") ||
    normalized.includes("replace-with")
  );
}

async function publishSecretWarningComment(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  findings: SecretFinding[];
}): Promise<void> {
  const dedupeKey = [
    "github-secret-scan",
    `${params.owner}/${params.repo}`,
    `${params.pullNumber}`,
    params.headSha,
  ].join(":");
  if (isDuplicateRequest(dedupeKey, DEFAULT_DEDUPE_TTL_MS)) {
    return;
  }
  const locale = resolveUiLocale();

  const items = params.findings
    .slice(0, 10)
    .map(
      (item) =>
        localizeText(
          {
            zh: `- [ ] \`${item.path}:${item.line}\` 检测到疑似 **${item.kind}**（样本：\`${item.sample}\`）`,
            en: `- [ ] \`${item.path}:${item.line}\` detected possible **${item.kind}** (sample: \`${item.sample}\`)`,
          },
          locale,
        ),
    );

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: [
      localizeText(
        {
          zh: "## 安全预警：疑似密钥泄露",
          en: "## Security Alert: Potential Secret Leak",
        },
        locale,
      ),
      "",
      localizeText(
        {
          zh: "请立即确认以下内容是否为真实凭据；若是，请立刻轮换并从历史中移除：",
          en: "Please verify whether these are real credentials; if yes, rotate and remove them from history immediately:",
        },
        locale,
      ),
      ...items,
      "",
      localizeText(
        {
          zh: "建议：启用 GitHub secret scanning 与 push protection 作为长期防线。",
          en: "Recommendation: enable GitHub secret scanning and push protection as a long-term safeguard.",
        },
        locale,
      ),
    ].join("\n"),
  });
}

function inferPullRequestLabels(params: {
  title: string;
  files: DiffFileContext[];
  reviewResult: PullRequestReviewResult;
  hasSecretFinding: boolean;
}): string[] {
  const labels = new Set<string>();
  const title = params.title.toLowerCase();
  const paths = params.files.map((file) => file.newPath.toLowerCase());

  if (params.hasSecretFinding) {
    labels.add("security");
  }

  if (/\b(fix|bug|hotfix)\b/.test(title)) {
    labels.add("bugfix");
  }

  if (/\b(feat|feature)\b/.test(title)) {
    labels.add("feature");
  }

  if (/\brefactor\b/.test(title)) {
    labels.add("refactor");
  }

  if (paths.length > 0 && paths.every((path) => isDocumentationFile(path))) {
    labels.add("docs");
  }

  if (params.reviewResult.riskLevel === "high") {
    labels.add("needs-attention");
  }

  if (labels.size === 0) {
    labels.add("ai-reviewed");
  }

  return [...labels].slice(0, 8);
}

function isDocumentationFile(path: string): boolean {
  return (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.includes("/docs/") ||
    path.startsWith("docs/")
  );
}

async function tryAddPullRequestLabels(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  pullNumber: number;
  labels: string[];
}): Promise<void> {
  if (!params.context.octokit.issues.addLabels || params.labels.length === 0) {
    return;
  }

  try {
    await params.context.octokit.issues.addLabels({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      labels: params.labels,
    });
  } catch (error) {
    params.context.log.error(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        labels: params.labels,
        error: getErrorMessage(error),
      },
      "Failed to add auto labels",
    );
  }
}

async function loadRepositoryProcessGuidelines(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  ref: string;
}): Promise<ProcessGuideline[]> {
  const { octokit, owner, repo, ref } = params;
  const cacheKey = `${owner}/${repo}@${ref}`;
  const now = Date.now();
  pruneExpiredCache(guidelineCache, now);
  const cached = guidelineCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const guidelines: ProcessGuideline[] = [];
  const visited = new Set<string>();

  for (const path of GITHUB_GUIDELINE_FILE_PATHS) {
    await tryAddGuideline({
      octokit,
      owner,
      repo,
      ref,
      path,
      guidelines,
      visited,
    });
  }

  for (const dir of GITHUB_GUIDELINE_DIRECTORIES) {
    const entries = await tryListDirectory({
      octokit,
      owner,
      repo,
      ref,
      path: dir,
    });

    for (const entry of entries.slice(0, MAX_GUIDELINES_PER_DIRECTORY)) {
      if (!isProcessTemplateFile(entry.path, "github")) {
        continue;
      }

      await tryAddGuideline({
        octokit,
        owner,
        repo,
        ref,
        path: entry.path,
        guidelines,
        visited,
      });
    }
  }

  const result = guidelines.slice(0, MAX_GUIDELINES);
  guidelineCache.set(cacheKey, {
    expiresAt:
      now +
      readNumberEnv("GITHUB_GUIDELINE_CACHE_TTL_MS", DEFAULT_GUIDELINE_CACHE_TTL_MS),
    value: result,
  });
  trimCache(guidelineCache, MAX_GUIDELINE_CACHE_ENTRIES);

  return result;
}

async function tryAddGuideline(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  guidelines: ProcessGuideline[];
  visited: Set<string>;
}): Promise<void> {
  const normalizedPath = params.path.trim();
  if (!normalizedPath || params.visited.has(normalizedPath.toLowerCase())) {
    return;
  }

  params.visited.add(normalizedPath.toLowerCase());

  try {
    const response = await params.octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path: normalizedPath,
      ref: params.ref,
    });
    const file = asContentFile(response.data);
    if (!file || file.type !== "file" || !file.content) {
      return;
    }

    const text = decodeGitHubFileContent(file.content, file.encoding);
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    params.guidelines.push({
      path: file.path ?? normalizedPath,
      content: trimmed.slice(0, 4_000),
    });
  } catch {
    // File does not exist or cannot be read. Continue with other candidates.
  }
}

async function tryListDirectory(params: {
  octokit: MinimalGitHubOctokit;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}): Promise<Array<{ path: string; type: string }>> {
  try {
    const response = await params.octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path: params.path,
      ref: params.ref,
    });
    if (!Array.isArray(response.data)) {
      return [];
    }

    return response.data
      .map((item) => ({
        path: item.path ?? "",
        type: item.type ?? "",
      }))
      .filter((item) => Boolean(item.path));
  } catch {
    return [];
  }
}

function asContentFile(
  data: GitHubRepositoryContentFile | GitHubRepositoryContentFile[],
): GitHubRepositoryContentFile | undefined {
  if (Array.isArray(data)) {
    return undefined;
  }

  return data;
}

function decodeGitHubFileContent(content: string, encoding: string | undefined): string {
  if ((encoding ?? "").toLowerCase() === "base64") {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  return content;
}

export function buildGitHubChangelogQuestion(
  focus: string | undefined,
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  const normalizedFocus = focus?.trim() ?? "";
  if (locale === "en") {
    if (normalizedFocus) {
      return `Generate a Markdown changelog entry (Keep a Changelog style) for the current PR changes, with extra focus on: ${normalizedFocus}. Output only the changelog content body without extra explanation.`;
    }
    return "Generate a Markdown changelog entry (Keep a Changelog style) for the current PR changes. Output only the changelog content body without extra explanation.";
  }

  if (normalizedFocus) {
    return `请根据当前 PR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格），重点覆盖：${normalizedFocus}。仅输出 changelog 内容本体，不要额外说明。`;
  }

  return "请根据当前 PR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格）。仅输出 changelog 内容本体，不要额外说明。";
}

export function buildGitHubDescribeQuestion(
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  if (locale === "en") {
    return [
      "Based on current PR changes, generate a Markdown draft that can be pasted directly into the PR description.",
      "Structure requirements: include the following headings in this exact order:",
      "## Summary",
      "## Change Overview",
      "## File Walkthrough",
      "## Test Plan",
      "## Related Issue",
      "Content requirements:",
      "1) Summarize the goal and major impact of this change;",
      "2) In Change Overview, include change size and branch information;",
      "3) In File Walkthrough, cover key files and important changes;",
      "4) In Test Plan, provide an executable verification checklist;",
      "5) In Related Issue, keep the placeholder `- Closes #`.",
      "Output requirement: return Markdown body only. No JSON, no code fences, no extra explanation.",
    ].join("\n");
  }

  return [
    "请基于当前 PR 的变更内容，生成一份可直接粘贴到 PR 描述区的 Markdown 草稿。",
    "结构要求：必须包含以下标题（按顺序）：",
    "## Summary",
    "## Change Overview",
    "## File Walkthrough",
    "## Test Plan",
    "## Related Issue",
    "内容要求：",
    "1) 总结本次变更的目标和主要影响；",
    "2) Change Overview 里给出变更规模和分支信息；",
    "3) File Walkthrough 覆盖关键文件和改动点；",
    "4) Test Plan 给出可执行的验证清单；",
    "5) Related Issue 保留 `- Closes #` 占位。",
    "输出要求：只输出 Markdown 本体，不要 JSON，不要代码块，不要额外解释。",
  ].join("\n");
}

async function applyGitHubChangelogUpdate(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  branch: string;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const locale = resolveUiLocale();
  const path = process.env.GITHUB_CHANGELOG_PATH?.trim() || "CHANGELOG.md";
  const title = `PR #${params.pullNumber}`;
  const octokit = params.context.octokit;
  if (!octokit.repos.createOrUpdateFileContents) {
    return {
      message: localizeText(
        {
          zh: "当前运行模式不支持自动写回仓库文件，已生成 changelog 草稿供手动应用。",
          en: "Current runtime mode does not support writing back repository files automatically. A changelog draft has been generated for manual apply.",
        },
        locale,
      ),
    };
  }

  let existing = "";
  let existingSha: string | undefined;
  try {
    const response = await octokit.repos.getContent({
      owner: params.owner,
      repo: params.repo,
      path,
      ref: params.branch,
    });
    const data = response.data;
    if (!Array.isArray(data) && data.content) {
      existing = decodeGitHubFileContent(data.content, data.encoding);
      existingSha = data.sha;
    }
  } catch {
    // create path on first write
  }

  const merged = mergeChangelogContent(existing, params.draft, title);
  await octokit.repos.createOrUpdateFileContents({
    owner: params.owner,
    repo: params.repo,
    path,
    message: `chore(changelog): update from ${title}`,
    content: Buffer.from(merged, "utf8").toString("base64"),
    sha: existingSha,
    branch: params.branch,
  });

  return {
    message: localizeText(
      {
        zh: `已写入 \`${path}\`（branch: \`${params.branch}\`）。`,
        en: `Written to \`${path}\` (branch: \`${params.branch}\`).`,
      },
      locale,
    ),
  };
}

export function mergeChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  const normalizedDraft = draft.trim();
  const safeTitle = title.trim();
  const body = currentContent.trim();
  if (body && hasChangelogTitle(body, safeTitle)) {
    return `${body.trimEnd()}\n`;
  }

  const entry = [`### ${safeTitle}`, "", normalizedDraft].join("\n");

  if (!body) {
    return ["# Changelog", "", "## Unreleased", "", entry, ""].join("\n");
  }

  const unreleasedRe = /^##\s+Unreleased\s*$/im;
  const match = unreleasedRe.exec(body);
  if (!match || match.index === undefined) {
    return [body, "", "## Unreleased", "", entry, ""].join("\n");
  }

  const insertAt = match.index + match[0].length;
  return `${body.slice(0, insertAt)}\n\n${entry}\n${body.slice(insertAt)}`.trimEnd() + "\n";
}

function hasChangelogTitle(content: string, title: string): boolean {
  const safeTitle = title.trim();
  if (!safeTitle) {
    return false;
  }

  const escapedTitle = escapeRegExp(safeTitle);
  return new RegExp(`^###\\s+${escapedTitle}\\s*$`, "im").test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getPublicErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);

  const allowList = [
    /^Missing\s+[A-Z0-9_]+/,
    /^Unsupported AI_PROVIDER/,
    /^Model returned empty/,
    /^Model response is not valid JSON/,
  ];

  if (allowList.some((pattern) => pattern.test(message))) {
    return message;
  }

  return "内部执行错误（详情请查看服务日志）";
}
