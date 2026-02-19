import {
  clearDuplicateRecord,
  ensureError,
  isDuplicateRequest,
  pruneExpiredCache,
  readNumberEnv,
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
const MAX_PATCH_CHARS_PER_FILE = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
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
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
  changed_files: number;
  html_url: string;
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
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
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
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  author: string;
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
        body: "`AI Review` 最近 5 分钟内已经执行过，本次请求已跳过。",
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
  const feedbackSignals = loadGitHubFeedbackSignals(owner, repo);

  let progressCommentId: number | undefined;
  if (trigger === "comment-command") {
    const progress = await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: "`AI Review` 正在分析这个 PR，请稍候...",
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
    });

    if (collected.files.length === 0) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: "`AI Review` 未发现可评审的文本改动，已跳过。",
      });
      if (progressCommentId) {
        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: progressCommentId,
          body: "`AI Review` 未发现可评审改动，已跳过。",
        });
      }
      rememberIncrementalHead(reviewPrKey, collected.headSha);
      return;
    }

    const reviewResult = await analyzePullRequest(collected.input);

    if (mode === "comment") {
      const posted = await publishGitHubLineComments(
        context,
        collected,
        reviewResult,
      );
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          "## AI 评审结果（Comment 模式）",
          "",
          `已发布行级评论: **${posted.posted}**，跳过: **${posted.skipped}**`,
          "",
          "如需汇总报告，请评论：`/ai-review report`",
        ].join("\n"),
      });
    } else {
      const body = buildReportCommentMarkdown(reviewResult, collected.files, {
        platform: "github",
        owner: collected.owner,
        repo: collected.repo,
        baseSha: collected.baseSha,
        headSha: collected.headSha,
      });
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
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
        body: "`AI Review` 分析完成，结果已发布。",
      });
    }

    try {
      await publishNotification({
        pushUrl: process.env.GITHUB_PUSH_URL ?? process.env.NOTIFY_WEBHOOK_URL,
        author: collected.author,
        repository: `${owner}/${repo}`,
        sourceBranch: collected.headBranch,
        targetBranch: collected.baseBranch,
        content: `代码评审完毕 https://github.com/${owner}/${repo}/pull/${pullNumber}`,
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
          "## AI Review 执行失败",
          "",
          `错误：\`${publicReason}\``,
          "",
          "请检查 AI_PROVIDER/模型 API Key/GitHub App 权限配置。",
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
          body: "`AI Review` 执行失败，请查看下方错误说明。",
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
        content: `代码评审失败: ${reason}`,
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

export function recordGitHubFeedbackSignal(params: {
  owner: string;
  repo: string;
  signal: string;
}): void {
  const feedbackKey = `${params.owner}/${params.repo}`;
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

function loadGitHubFeedbackSignals(owner: string, repo: string): string[] {
  const feedbackKey = `${owner}/${repo}`;
  const now = Date.now();
  pruneExpiredCache(feedbackSignalCache, now);
  return feedbackSignalCache.get(feedbackKey)?.value ?? [];
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
  } = params;

  const prResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const pr = prResponse.data;
  let files: GitHubPullFile[];
  if (incrementalBaseSha && incrementalBaseSha !== pr.head.sha) {
    files = await loadIncrementalPullFiles({
      octokit,
      owner,
      repo,
      pullNumber,
      incrementalBaseSha,
      headSha: pr.head.sha,
    });
  } else {
    files = await octokit.paginate(octokit.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
  }

  const changedFiles: DiffFileContext[] = [];
  let totalPatchChars = 0;

  for (const file of files) {
    if (changedFiles.length >= MAX_FILES || totalPatchChars >= MAX_TOTAL_PATCH_CHARS) {
      break;
    }

    if (!isReviewTargetFile(file.filename, "github")) {
      continue;
    }

    const rawPatch = file.patch ?? "(binary / patch omitted)";
    const trimmedPatch =
      rawPatch.length > MAX_PATCH_CHARS_PER_FILE
        ? `${rawPatch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n... [patch truncated]`
        : rawPatch;

    if (totalPatchChars + trimmedPatch.length > MAX_TOTAL_PATCH_CHARS) {
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
        body: buildIssueCommentMarkdown(review, { platform: "github" }),
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
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:describe:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    if (trigger === "comment-command" || trigger === "describe-command") {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: "`AI Describe` 最近 5 分钟内已经执行过，本次请求已跳过。",
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
    const reviewResult = await analyzePullRequest(collected.input);
    const description = buildPullRequestDescriptionDraft(collected, reviewResult);

    if (apply) {
      await context.octokit.pulls.update({
        owner,
        repo,
        pull_number: pullNumber,
        body: description,
      });
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          "## AI PR 描述已更新",
          "",
          "已根据当前 diff 自动生成并写入 PR 描述。",
        ].join("\n"),
      });
      return;
    }

    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: [
        "## AI 生成 PR 描述草稿",
        "",
        "```markdown",
        description,
        "```",
        "",
        "如需自动写入 PR 描述，请使用：`/describe --apply`",
      ].join("\n"),
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    const reason = getErrorMessage(error);
    context.log.error(
      { owner, repo, pullNumber, trigger, apply, error: reason },
      "GitHub describe failed",
    );

    try {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          "## AI Describe 执行失败",
          "",
          `错误：\`${getPublicErrorMessage(error)}\``,
        ].join("\n"),
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
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    commentTitle = "AI Ask",
    displayQuestion,
    throwOnError = false,
  } = params;
  const { owner, repo } = context.repo();
  const normalizedQuestion = question.trim().replace(/\s+/g, " ").slice(0, 120);
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:ask:${trigger}:${normalizedQuestion}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: `\`${commentTitle}\` 最近 5 分钟内已回答过相同问题，本次请求已跳过。`,
    });
    return;
  }

  try {
    const feedbackSignals = loadGitHubFeedbackSignals(owner, repo);
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });
    const answer = await answerPullRequestQuestion(collected.input, question);
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: [
        `## ${commentTitle}`,
        "",
        `**Q:** ${(displayQuestion ?? question).trim()}`,
        "",
        `**A:** ${answer}`,
      ].join("\n"),
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
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          `## ${commentTitle} 执行失败`,
          "",
          `错误：\`${getPublicErrorMessage(error)}\``,
        ].join("\n"),
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
  const requestKey = [
    `github:${owner}/${repo}#${pullNumber}:changelog:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: "`AI Changelog` 最近 5 分钟内已执行过同类请求，本次已跳过。",
    });
    return;
  }

  try {
    const feedbackSignals = loadGitHubFeedbackSignals(owner, repo);
    const collected = await collectGitHubPullRequestContext({
      octokit: context.octokit,
      owner,
      repo,
      pullNumber,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });
    const question = buildChangelogQuestion(focus);
    const draft = (await answerPullRequestQuestion(collected.input, question)).trim();

    if (!apply) {
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          "## AI Changelog Draft",
          "",
          draft,
          "",
          "如需自动写入仓库 CHANGELOG，请使用：`/changelog --apply`。",
        ].join("\n"),
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
    await context.octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: [
        "## AI Changelog 已更新",
        "",
        applyResult.message,
        "",
        "```markdown",
        draft,
        "```",
      ].join("\n"),
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
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          "## AI Changelog 执行失败",
          "",
          `错误：\`${getPublicErrorMessage(error)}\``,
        ].join("\n"),
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
}): Promise<GitHubPullFile[]> {
  if (!params.octokit.repos.compareCommits) {
    return params.octokit.paginate(params.octokit.pulls.listFiles, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100,
    });
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
      return files;
    }
  } catch {
    // Fallback to full file list when compare API is unavailable or SHAs are invalid.
  }

  return params.octokit.paginate(params.octokit.pulls.listFiles, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });
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

function isLikelyPlaceholder(text: string): boolean {
  const normalized = text.toLowerCase();
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

  const items = params.findings
    .slice(0, 10)
    .map(
      (item) =>
        `- [ ] \`${item.path}:${item.line}\` 检测到疑似 **${item.kind}**（样本：\`${item.sample}\`）`,
    );

  await params.context.octokit.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: [
      "## 安全预警：疑似密钥泄露",
      "",
      "请立即确认以下内容是否为真实凭据；若是，请立刻轮换并从历史中移除：",
      ...items,
      "",
      "建议：启用 GitHub secret scanning 与 push protection 作为长期防线。",
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

function buildChangelogQuestion(focus: string | undefined): string {
  if (focus && focus.trim()) {
    return `请根据当前 PR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格），重点覆盖：${focus.trim()}。仅输出 changelog 内容本体，不要额外说明。`;
  }

  return "请根据当前 PR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格）。仅输出 changelog 内容本体，不要额外说明。";
}

async function applyGitHubChangelogUpdate(params: {
  context: GitHubReviewContext;
  owner: string;
  repo: string;
  branch: string;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const path = process.env.GITHUB_CHANGELOG_PATH?.trim() || "CHANGELOG.md";
  const title = `PR #${params.pullNumber}`;
  const octokit = params.context.octokit;
  if (!octokit.repos.createOrUpdateFileContents) {
    return {
      message: "当前运行模式不支持自动写回仓库文件，已生成 changelog 草稿供手动应用。",
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
    message: `已写入 \`${path}\`（branch: \`${params.branch}\`）。`,
  };
}

function mergeChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  const normalizedDraft = draft.trim();
  const safeTitle = title.trim();
  const entry = [`### ${safeTitle}`, "", normalizedDraft].join("\n");
  const body = currentContent.trim();

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

function buildPullRequestDescriptionDraft(
  collected: GitHubCollectedContext,
  result: PullRequestReviewResult,
): string {
  const topFiles = collected.files
    .slice(0, 12)
    .map(
      (file) =>
        `- \`${file.newPath}\` (${file.status}, +${file.additions}/-${file.deletions})`,
    );

  return [
    "## Summary",
    result.summary,
    "",
    "## Change Overview",
    `- Base -> Head: \`${collected.baseBranch}\` -> \`${collected.headBranch}\``,
    `- Files changed: ${collected.input.changedFilesCount}`,
    `- Additions/Deletions: +${collected.input.additions}/-${collected.input.deletions}`,
    `- Risk level: ${result.riskLevel}`,
    "",
    "## File Walkthrough",
    ...(topFiles.length > 0 ? topFiles : ["- (No textual diff available)"]),
    "",
    "## Review Highlights",
    ...(result.reviews.length > 0
      ? result.reviews
          .slice(0, 8)
          .map((issue) => `- [${issue.severity}] ${issue.issueHeader}`)
      : ["- 未发现明确问题。"]),
    "",
    "## Test Plan",
    "- [ ] 单元测试/集成测试已更新",
    "- [ ] 本地或 CI 验证通过",
    "",
    "## Related Issue",
    "- Closes #",
  ].join("\n");
}
