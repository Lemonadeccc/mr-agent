import {
  BadWebhookRequestError,
  clearDuplicateRecord,
  ensureError,
  fetchWithRetry,
  fnv1a32Hex,
  getFreshCacheValue,
  isDuplicateRequest,
  isRateLimited,
  loadAskConversationTurns,
  localizeText,
  normalizeRateLimitPart,
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
  countPatchChanges,
  findSimilarIssues,
  findFileForReview,
  GITLAB_GUIDELINE_DIRECTORIES,
  GITLAB_GUIDELINE_FILE_PATHS,
  parseAddDocCommand,
  isProcessTemplateFile,
  isReviewTargetFile,
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parseImproveCommand,
  parsePatchWithLineNumbers,
  parseReflectCommand,
  prioritizePatchHunks,
  parseReviewCommand,
  parseSimilarIssueCommand,
  resolveReviewLineForIssue,
} from "#review";
import type {
  DiffFileContext,
  PullRequestReviewInput,
  PullRequestReviewResult,
  ReviewMode,
} from "#review";

const MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS_PER_FILE = 4_000;
const DEFAULT_MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COMMAND_RATE_LIMIT_MAX = 10;
const DEFAULT_COMMAND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
const MAX_FEEDBACK_SIGNALS = 80;
const MAX_FEEDBACK_CACHE_ENTRIES = 1_000;
const MANAGED_NOTE_SCAN_PER_PAGE = 100;
const MAX_MANAGED_NOTE_SCAN_PAGES = 20;

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
type GitLabReviewPolicyCacheEntry = ExpiringCacheEntry<GitLabReviewPolicy>;

const guidelineCache = new Map<string, ProcessGuidelineCacheEntry>();
const incrementalHeadCache = new Map<string, IncrementalHeadCacheEntry>();
const feedbackSignalCache = new Map<string, FeedbackSignalCacheEntry>();
const gitlabPolicyCache = new Map<string, GitLabReviewPolicyCacheEntry>();

export function resolveGitLabPatchCharLimits(): {
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
} {
  const maxPatchCharsPerFile = Math.max(
    1,
    readNumberEnv(
      "GITLAB_MAX_PATCH_CHARS_PER_FILE",
      DEFAULT_MAX_PATCH_CHARS_PER_FILE,
    ),
  );
  const maxTotalPatchChars = Math.max(
    maxPatchCharsPerFile,
    readNumberEnv(
      "GITLAB_MAX_TOTAL_PATCH_CHARS",
      DEFAULT_MAX_TOTAL_PATCH_CHARS,
    ),
  );

  return {
    maxPatchCharsPerFile,
    maxTotalPatchChars,
  };
}

interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitLabMrWebhookBody {
  object_kind?: string;
  event_type?: string;
  user?: {
    username?: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
    path_with_namespace?: string;
  };
  object_attributes: {
    action?: string;
    state?: string;
    iid: number;
    url: string;
    title: string;
    description?: string;
    work_in_progress?: boolean;
    draft?: boolean;
    source_branch: string;
    target_branch: string;
    last_commit?: {
      id?: string;
    };
  };
  merge_request?: {
    iid?: number;
    title?: string;
    description?: string;
    work_in_progress?: boolean;
    draft?: boolean;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    state?: string;
  };
}

export interface GitLabNoteWebhookBody {
  object_kind?: string;
  event_type?: string;
  user?: {
    username?: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
    path_with_namespace?: string;
  };
  object_attributes: {
    action?: string;
    note?: string;
    noteable_type?: string;
    noteable_iid?: number | string;
    url?: string;
  };
  merge_request?: {
    iid?: number;
    title?: string;
    description?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    state?: string;
  };
}

export type GitLabWebhookBody = GitLabMrWebhookBody | GitLabNoteWebhookBody;

interface GitLabChange {
  new_path: string;
  old_path: string;
  diff: string;
  deleted_file?: boolean;
  new_file?: boolean;
  renamed_file?: boolean;
}

interface GitLabChangesResponse {
  changes: GitLabChange[];
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

interface GitLabCompareResponse {
  diffs?: GitLabChange[];
}

interface GitLabCommentTarget {
  baseUrl: string;
  projectId: number;
  mrId: number;
}

interface GitLabCollectedContext extends GitLabCommentTarget {
  input: PullRequestReviewInput;
  files: DiffFileContext[];
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  repository: string;
  diffRefs: {
    baseSha: string;
    headSha: string;
    startSha: string;
  };
  mrUrl: string;
}

type ManagedGitLabNoteKey = string;

function normalizeManagedGitLabNoteKey(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return normalized || "default";
}

export function buildGitLabManagedCommandCommentKey(
  command: string,
  seed: string,
): string {
  const commandKey = normalizeManagedGitLabNoteKey(`cmd-${command}`).replace(
    /:/g,
    "-",
  );
  const normalizedSeed = seed.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
  return `${commandKey}:${fnv1a32Hex(normalizedSeed)}`;
}

function managedGitLabNoteMarker(key: ManagedGitLabNoteKey): string {
  return `<!-- mr-agent:${normalizeManagedGitLabNoteKey(key)} -->`;
}

function managedGitLabNoteBody(body: string, key: ManagedGitLabNoteKey): string {
  return `${body.trim()}\n\n${managedGitLabNoteMarker(key)}`;
}

interface GitLabReviewRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  mode?: ReviewMode;
  trigger?: GitLabReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  enableSecretScan?: boolean;
  enableAutoLabel?: boolean;
  throwOnError?: boolean;
}

interface GitLabAskRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  question: string;
  trigger: GitLabReviewTrigger;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  commentTitle?: string;
  displayQuestion?: string;
  managedCommentKey?: string;
  enableConversationContext?: boolean;
  throwOnError?: boolean;
}

interface GitLabDescribeRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: GitLabReviewTrigger;
  apply?: boolean;
  dedupeSuffix?: string;
  throwOnError?: boolean;
}

interface GitLabChangelogRunParams {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
  trigger: GitLabReviewTrigger;
  focus?: string;
  apply?: boolean;
  dedupeSuffix?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  throwOnError?: boolean;
}

interface GitLabReviewPolicy {
  enabled: boolean;
  mode: ReviewMode;
  onOpened: boolean;
  onEdited: boolean;
  onSynchronize: boolean;
  describeEnabled: boolean;
  describeAllowApply: boolean;
  checksCommandEnabled: boolean;
  includeCiChecks: boolean;
  secretScanEnabled: boolean;
  autoLabelEnabled: boolean;
  askCommandEnabled: boolean;
  generateTestsCommandEnabled: boolean;
  changelogCommandEnabled: boolean;
  changelogAllowApply: boolean;
  feedbackCommandEnabled: boolean;
  customRules: string[];
}

const defaultGitLabReviewPolicy: GitLabReviewPolicy = {
  enabled: true,
  mode: "comment",
  onOpened: true,
  onEdited: false,
  onSynchronize: true,
  describeEnabled: true,
  describeAllowApply: false,
  checksCommandEnabled: true,
  includeCiChecks: true,
  secretScanEnabled: true,
  autoLabelEnabled: true,
  askCommandEnabled: true,
  generateTestsCommandEnabled: true,
  changelogCommandEnabled: true,
  changelogAllowApply: false,
  feedbackCommandEnabled: true,
  customRules: [],
};

type GitLabReviewTrigger =
  | "merged"
  | "comment-command"
  | "describe-command"
  | "pr-opened"
  | "pr-edited"
  | "pr-synchronize"
  | "gitlab-webhook";

function isGitLabAutoReviewTrigger(trigger: GitLabReviewTrigger): boolean {
  return (
    trigger === "pr-opened" ||
    trigger === "pr-edited" ||
    trigger === "pr-synchronize"
  );
}

function shouldUseManagedGitLabReviewSummary(trigger: GitLabReviewTrigger): boolean {
  return isGitLabAutoReviewTrigger(trigger) || trigger === "merged";
}

function isGitLabTitleDraftLike(titleRaw: string | undefined): boolean {
  const title = (titleRaw ?? "").trim().toLowerCase();
  if (!title) {
    return false;
  }
  return (
    title.startsWith("draft:") ||
    title.startsWith("wip:") ||
    title.startsWith("[draft]") ||
    title.startsWith("(draft)")
  );
}

function isGitLabMergeRequestDraft(payload: GitLabMrWebhookBody): boolean {
  return Boolean(
    payload.object_attributes.draft ||
      payload.object_attributes.work_in_progress ||
      payload.merge_request?.draft ||
      payload.merge_request?.work_in_progress ||
      isGitLabTitleDraftLike(payload.object_attributes.title) ||
      isGitLabTitleDraftLike(payload.merge_request?.title),
  );
}

export function shouldSkipGitLabReviewForDraft(
  trigger: GitLabReviewTrigger,
  isDraft: boolean,
): boolean {
  return isDraft && isGitLabAutoReviewTrigger(trigger);
}

export async function upsertGitLabManagedComment(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  body: string;
  markerKey: ManagedGitLabNoteKey;
  logger?: LoggerLike;
}): Promise<void> {
  const marker = managedGitLabNoteMarker(params.markerKey);
  const nextBody = managedGitLabNoteBody(params.body, params.markerKey);
  try {
    for (let page = 1; page <= MAX_MANAGED_NOTE_SCAN_PAGES; page += 1) {
      const listed = await fetchWithRetry(
        `${params.target.baseUrl}/api/v4/projects/${encodeURIComponent(params.target.projectId)}/merge_requests/${params.target.mrId}/notes?per_page=${MANAGED_NOTE_SCAN_PER_PAGE}&page=${page}`,
        {
          headers: {
            "PRIVATE-TOKEN": params.gitlabToken,
            "content-type": "application/json",
          },
        },
        {
          timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
          retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
          backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
        },
      );
      if (!listed.ok) {
        break;
      }

      const data = (await listed.json()) as Array<{ id?: number; body?: string }>;
      const existing = data.find(
        (item) =>
          typeof item.id === "number" &&
          typeof item.body === "string" &&
          item.body.includes(marker),
      );
      if (existing?.id) {
        const updateResp = await fetchWithRetry(
          `${params.target.baseUrl}/api/v4/projects/${encodeURIComponent(params.target.projectId)}/merge_requests/${params.target.mrId}/notes/${existing.id}`,
          {
            method: "PUT",
            headers: {
              "PRIVATE-TOKEN": params.gitlabToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({ body: nextBody }),
          },
          {
            timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
            retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
            backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
          },
        );
        if (updateResp.ok) {
          return;
        }
      }

      if (data.length < MANAGED_NOTE_SCAN_PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    params.logger?.error(
      {
        projectId: params.target.projectId,
        mrId: params.target.mrId,
        markerKey: params.markerKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to upsert GitLab managed comment; falling back to create",
    );
  }

  await publishGitLabGeneralComment(params.gitlabToken, params.target, nextBody);
}

async function postGitLabCommandComment(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  body: string;
  managedCommentKey?: string;
  logger?: LoggerLike;
}): Promise<void> {
  if (params.managedCommentKey) {
    await upsertGitLabManagedComment({
      gitlabToken: params.gitlabToken,
      target: params.target,
      body: params.body,
      markerKey: params.managedCommentKey,
      logger: params.logger,
    });
    return;
  }

  await publishGitLabGeneralComment(params.gitlabToken, params.target, params.body);
}

function buildGitLabCommentTargetFromPayload(params: {
  payload: GitLabMrWebhookBody;
  baseUrl?: string;
}): GitLabCommentTarget {
  return {
    baseUrl: resolveGitLabBaseUrl(params.baseUrl, params.payload.project.web_url),
    projectId: params.payload.project.id,
    mrId: params.payload.object_attributes.iid,
  };
}

function isGitLabCommandRateLimited(params: {
  projectId: number;
  mrId: number;
  userName?: string;
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
  const user = normalizeRateLimitPart(params.userName, "unknown-user");
  const command = normalizeRateLimitPart(params.command, "unknown-command");
  const key =
    "gitlab:" +
    `${params.projectId}:mr:${params.mrId}:` +
    `user:${user}:cmd:${command}`;
  return isRateLimited(key, maxPerWindow, windowMs);
}

async function shouldRejectGitLabCommandByRateLimit(params: {
  gitlabToken: string;
  target: GitLabCommentTarget;
  projectId: number;
  mrId: number;
  userName?: string;
  command: string;
  logger?: LoggerLike;
}): Promise<boolean> {
  if (
    !isGitLabCommandRateLimited({
      projectId: params.projectId,
      mrId: params.mrId,
      userName: params.userName,
      command: params.command,
    })
  ) {
    return false;
  }

  await postGitLabCommandComment({
    gitlabToken: params.gitlabToken,
    target: params.target,
    body: gitLabCommandRateLimitMessage(resolveUiLocale()),
    managedCommentKey: buildGitLabManagedCommandCommentKey(
      "rate-limit",
      params.command,
    ),
    logger: params.logger,
  });
  return true;
}

function gitLabCommandRateLimitMessage(locale: "zh" | "en"): string {
  return localizeText(
    {
      zh: "`命令触发过于频繁，请稍后再试（默认每用户每 MR 每小时 10 次）。`",
      en: "`Command triggered too frequently. Please retry later (default: 10 times/hour per user per MR).`",
    },
    locale,
  );
}

export async function runGitLabWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const kind = (params.payload.object_kind ?? "merge_request").toLowerCase();
  if (kind === "merge_request") {
    const payload = params.payload as GitLabMrWebhookBody;
    const actionRaw = payload.object_attributes?.action;
    const action =
      typeof actionRaw === "string" ? actionRaw.toLowerCase() : undefined;
    if (action === "close" || action === "closed") {
      return { ok: true, message: "ignored closed merge request event" };
    }

    const gitlabToken = requireGitLabToken(params.headers);
    const baseUrl = resolveGitLabBaseUrl(process.env.GITLAB_BASE_URL, payload.project.web_url);
    const actionKind = mapGitLabActionToReviewEvent(action);
    const policy = await resolveGitLabReviewPolicy({
      baseUrl,
      projectId: payload.project.id,
      gitlabToken,
      ref: payload.object_attributes.target_branch,
    });

    const headerMode = parseMode(params.headers["x-ai-mode"]);
    const resolvedMode =
      actionKind === "merged" ? "report" : (headerMode ?? policy.mode);
    const shouldRunByPolicy = shouldRunGitLabAutoReview(policy, actionKind);
    if (!shouldRunByPolicy && !headerMode) {
      return { ok: true, message: "merge_request action ignored by review policy" };
    }

    const trigger =
      actionKind === "opened"
        ? "pr-opened"
        : actionKind === "edited"
          ? "pr-edited"
          : actionKind === "synchronize"
            ? "pr-synchronize"
            : actionKind === "merged"
              ? "merged"
              : "gitlab-webhook";
    return runGitLabReview({
      payload,
      headers: params.headers,
      logger: params.logger,
      mode: resolvedMode,
      trigger,
      dedupeSuffix: payload.object_attributes.last_commit?.id,
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
      enableSecretScan: policy.secretScanEnabled,
      enableAutoLabel: policy.autoLabelEnabled,
    });
  }

  if (kind === "note") {
    return handleGitLabNoteWebhook(params);
  }

  return { ok: true, message: `ignored object_kind=${kind}` };
}

export async function runGitLabReview(
  params: GitLabReviewRunParams,
): Promise<{ ok: boolean; message: string }> {
  const {
    payload,
    headers,
    logger,
    mode: modeOverride,
    trigger = "gitlab-webhook",
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    enableSecretScan = true,
    enableAutoLabel = true,
    throwOnError = false,
  } = params;
  if (payload.object_kind && payload.object_kind !== "merge_request") {
    return { ok: true, message: `ignored object_kind=${payload.object_kind}` };
  }

  const actionRaw = payload.object_attributes.action;
  const action = typeof actionRaw === "string" ? actionRaw.toLowerCase() : undefined;
  if (action === "close" || action === "closed") {
    return { ok: true, message: "ignored closed merge request event" };
  }

  const mode = modeOverride ?? parseMode(headers["x-ai-mode"]) ?? "report";
  const locale = resolveUiLocale();
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (isDuplicateRequest(requestKey, resolveGitLabDedupeTtl(trigger, mode))) {
    return { ok: true, message: "duplicate request ignored" };
  }

  if (shouldSkipGitLabReviewForDraft(trigger, isGitLabMergeRequestDraft(payload))) {
    return { ok: true, message: "draft merge request skipped" };
  }

  const gitlabToken = requireGitLabToken(headers);
  const reviewMrKey = `${payload.project.id}#${payload.object_attributes.iid}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? getIncrementalHead(reviewMrKey)
    : undefined;
  const currentHeadSha = payload.object_attributes.last_commit?.id?.trim();
  if (
    trigger === "pr-edited" &&
    incrementalBaseSha &&
    currentHeadSha &&
    incrementalBaseSha === currentHeadSha
  ) {
    logger.info(
      {
        projectId: payload.project.id,
        mrId: payload.object_attributes.iid,
        trigger,
        headSha: currentHeadSha,
      },
      "Skipping GitLab AI review for merge_request.edited without code changes",
    );
    return { ok: true, message: "merge_request.edited without code changes skipped" };
  }

  try {
    const feedbackSignals = loadGitLabFeedbackSignals(payload.project.id);
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
      incrementalBaseSha,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });

    logger.info(
      {
        projectId: collected.projectId,
        mrId: collected.mrId,
        mode,
        trigger,
      },
      "Starting GitLab AI review",
    );

    if (collected.files.length === 0) {
      const noDiffBody = localizeText(
        {
          zh: "`AI Review` 未发现可评审的文本改动，已跳过。",
          en: "`AI Review` found no textual changes to review, skipped.",
        },
        locale,
      );
      if (shouldUseManagedGitLabReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: noDiffBody,
          markerKey: "review-no-diff",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, noDiffBody);
      }
      rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);
      return { ok: true, message: "no textual diff to review" };
    }

    const result = await analyzePullRequest(collected.input);
    if (mode === "comment") {
      await publishGitLabLineComments(gitlabToken, collected, result, logger, locale);
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
            zh: "如需汇总报告，请评论：`/ai-review report`",
            en: "For a consolidated report, comment: `/ai-review report`",
          },
          locale,
        ),
      ].join("\n");
      if (shouldUseManagedGitLabReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: summaryBody,
          markerKey: "review-comment-summary",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, summaryBody);
      }
    } else {
      const markdown = buildReportCommentMarkdown(result, collected.files, {
        platform: "gitlab",
        webUrl: collected.webUrl,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
      }, {
        locale,
      });
      if (shouldUseManagedGitLabReviewSummary(trigger)) {
        await upsertGitLabManagedComment({
          gitlabToken,
          target: collected,
          body: markdown,
          markerKey: "review-report",
          logger,
        });
      } else {
        await publishGitLabGeneralComment(gitlabToken, collected, markdown);
      }
    }

    if (enableSecretScan) {
      const findings = findPotentialSecrets(collected.files);
      if (findings.length > 0) {
        const warning = buildGitLabSecretWarningComment(findings, locale);
        await publishGitLabGeneralComment(gitlabToken, collected, warning);
      }

      if (enableAutoLabel) {
        const labels = inferMergeRequestLabels({
          title: collected.input.title,
          files: collected.files,
          reviewResult: result,
          hasSecretFinding: findings.length > 0,
        });
        await tryAddGitLabMergeRequestLabels({
          gitlabToken,
          collected,
          labels,
          logger,
        });
      }
    } else if (enableAutoLabel) {
      const labels = inferMergeRequestLabels({
        title: collected.input.title,
        files: collected.files,
        reviewResult: result,
        hasSecretFinding: false,
      });
      await tryAddGitLabMergeRequestLabels({
        gitlabToken,
        collected,
        labels,
        logger,
      });
    }

    rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);

    const pushUrl =
      headers["x-push-url"] ??
      headers["x-qwx-robot-url"] ??
      process.env.GITLAB_PUSH_URL ??
      process.env.NOTIFY_WEBHOOK_URL;
    try {
      await publishNotification({
        pushUrl,
        author: collected.author,
        repository: collected.repository,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
        content: localizeText(
          {
            zh: `代码评审完毕 ${collected.mrUrl}`,
            en: `Code review completed ${collected.mrUrl}`,
          },
          locale,
        ),
        logger,
      });
    } catch (notifyError) {
      logger.error(
        { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        "GitLab review succeeded but notification publish failed",
      );
    }

    return { ok: true, message: "ok" };
  } catch (error) {
    clearDuplicateRecord(requestKey);
    const originalError = ensureError(error);
    const reason = originalError.message;
    const publicReason = getPublicErrorMessage(originalError);

    logger.error({ error: reason }, "GitLab AI review failed");
    const pushUrl =
      headers["x-push-url"] ??
      headers["x-qwx-robot-url"] ??
      process.env.GITLAB_PUSH_URL ??
      process.env.NOTIFY_WEBHOOK_URL;
    try {
      await publishNotification({
        pushUrl,
        author: payload.user?.username ?? "unknown",
        repository:
          payload.project.path_with_namespace ?? payload.project.name ?? "unknown",
        sourceBranch: payload.object_attributes.source_branch ?? "-",
        targetBranch: payload.object_attributes.target_branch ?? "-",
        content: localizeText(
          {
            zh: `代码评审失败: ${publicReason}`,
            en: `Code review failed: ${publicReason}`,
          },
          locale,
        ),
        logger,
      });
    } catch (notifyError) {
      logger.error(
        { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        "Failed to publish GitLab failure notification",
      );
    }

    if (throwOnError) {
      throw originalError;
    }
    return { ok: false, message: reason };
  }
}

export function recordGitLabFeedbackSignal(params: {
  projectId: number;
  signal: string;
}): void {
  const key = `${params.projectId}`;
  const signal = params.signal.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!signal) {
    return;
  }
  const now = Date.now();
  const ttlMs = readNumberEnv(
    "GITLAB_FEEDBACK_SIGNAL_TTL_MS",
    DEFAULT_FEEDBACK_SIGNAL_TTL_MS,
  );
  pruneExpiredCache(feedbackSignalCache, now);
  const current = getFreshCacheValue(feedbackSignalCache, key, now) ?? [];
  feedbackSignalCache.set(key, {
    value: [signal, ...current.filter((item) => item !== signal)].slice(
      0,
      MAX_FEEDBACK_SIGNALS,
    ),
    expiresAt: now + ttlMs,
  });
  trimCache(feedbackSignalCache, MAX_FEEDBACK_CACHE_ENTRIES);
}

async function handleGitLabNoteWebhook(params: {
  payload: GitLabWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const payload = params.payload as GitLabNoteWebhookBody;
  const noteableType = String(
    payload.object_attributes.noteable_type ?? "",
  ).toLowerCase();
  if (noteableType !== "mergerequest") {
    return { ok: true, message: "ignored note event (not merge request note)" };
  }

  const noteAction = String(payload.object_attributes.action ?? "create").toLowerCase();
  if (noteAction !== "create") {
    return { ok: true, message: `ignored note action=${noteAction}` };
  }

  const body =
    typeof payload.object_attributes.note === "string"
      ? payload.object_attributes.note.trim()
      : "";
  const locale = resolveUiLocale();
  if (!body) {
    return { ok: true, message: "empty note body" };
  }
  if (isGitLabBotUserName(payload.user?.username)) {
    return { ok: true, message: "ignored note from bot user" };
  }

  const mergePayload = buildMergeRequestPayloadFromNote(payload);
  const gitlabToken = requireGitLabToken(params.headers);
  const target = buildGitLabCommentTargetFromPayload({
    payload: mergePayload,
    baseUrl: process.env.GITLAB_BASE_URL,
  });
  const commentUserName = payload.user?.username;
  const baseUrl = resolveGitLabBaseUrl(process.env.GITLAB_BASE_URL, payload.project.web_url);
  const policy = await resolveGitLabReviewPolicy({
    baseUrl,
    projectId: payload.project.id,
    gitlabToken,
    ref: mergePayload.object_attributes.target_branch,
  });

  const feedbackCommand = parseFeedbackCommand(body);
  if (feedbackCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "feedback",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "feedback command rate limited" };
    }
    if (!policy.feedbackCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/feedback` 在当前仓库已被禁用（.mr-agent.yml -> review.feedbackCommandEnabled=false）。",
            en: "`/feedback` is disabled for this repository (.mr-agent.yml -> review.feedbackCommandEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "feedback command ignored by policy" };
    }

    const positive =
      feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
    const signalCore = positive
      ? "developer prefers high-confidence, actionable suggestions"
      : "developer prefers fewer low-value/noisy suggestions";
    const noteText = feedbackCommand.note ? `; note: ${feedbackCommand.note}` : "";
    recordGitLabFeedbackSignal({
      projectId: payload.project.id,
      signal: `MR !${mergePayload.object_attributes.iid} ${feedbackCommand.action}: ${signalCore}${noteText}`,
    });

    const context = await collectGitLabMergeRequestContext({
      payload: mergePayload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
    });
    await publishGitLabGeneralComment(
      gitlabToken,
      context,
      localizeText(
        {
          zh: `已记录反馈信号：\`${feedbackCommand.action}\`。后续评审会参考该偏好。`,
          en: `Recorded feedback signal: \`${feedbackCommand.action}\`. Future reviews will use this preference.`,
        },
        locale,
      ),
    );
    return { ok: true, message: "feedback command recorded" };
  }

  const describe = parseDescribeCommand(body);
  if (describe.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "describe",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "describe command rate limited" };
    }
    if (!policy.describeEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/describe` 在当前仓库已被禁用（.mr-agent.yml -> review.describeEnabled=false）。",
            en: "`/describe` is disabled for this repository (.mr-agent.yml -> review.describeEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "describe command ignored by policy" };
    }
    if (describe.apply && !policy.describeAllowApply) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/describe --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.describeAllowApply=false）。",
            en: "`/describe --apply` is disabled for this repository (.mr-agent.yml -> review.describeAllowApply=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "describe apply ignored by policy" };
    }

    await runGitLabDescribe({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      trigger: "describe-command",
      apply: describe.apply && policy.describeAllowApply,
    });
    return { ok: true, message: "describe command triggered" };
  }

  const ask = parseAskCommand(body);
  if (ask.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "ask",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "ask command rate limited" };
    }
    if (!policy.askCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/ask` 在当前仓库已被禁用（.mr-agent.yml -> review.askCommandEnabled=false）。",
            en: "`/ask` is disabled for this repository (.mr-agent.yml -> review.askCommandEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "ask command ignored by policy" };
    }

    await runGitLabAsk({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      question: ask.question,
      trigger: "comment-command",
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
      enableConversationContext: true,
      managedCommentKey: buildGitLabManagedCommandCommentKey("ask", ask.question),
    });
    return { ok: true, message: "ask command triggered" };
  }

  const checksCommand = parseChecksCommand(body);
  if (checksCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "checks",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "checks command rate limited" };
    }
    if (!policy.checksCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/checks` 在当前仓库已被禁用（.mr-agent.yml -> review.checksCommandEnabled=false）。",
            en: "`/checks` is disabled for this repository (.mr-agent.yml -> review.checksCommandEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "checks command ignored by policy" };
    }

    const checksQuestion = checksCommand.question
      ? `请结合当前 MR 的 CI 检查结果给出修复建议。额外问题：${checksCommand.question}`
      : "请结合当前 MR 的 CI 检查结果，分析失败原因并给出可执行修复步骤（优先级从高到低）。";
    await runGitLabAsk({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      question: checksQuestion,
      trigger: "comment-command",
      customRules: policy.customRules,
      includeCiChecks: true,
      commentTitle: "AI Checks",
      managedCommentKey: buildGitLabManagedCommandCommentKey(
        "checks",
        checksQuestion,
      ),
    });
    return { ok: true, message: "checks command triggered" };
  }

  const generateTests = parseGenerateTestsCommand(body);
  if (generateTests.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "generate-tests",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "generate_tests command rate limited" };
    }
    if (!policy.generateTestsCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/generate_tests` 在当前仓库已被禁用（.mr-agent.yml -> review.generateTestsCommandEnabled=false）。",
            en: "`/generate_tests` is disabled for this repository (.mr-agent.yml -> review.generateTestsCommandEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "generate_tests command ignored by policy" };
    }

    const generateTestsQuestion = generateTests.focus
      ? `请基于当前 MR 改动生成可执行测试方案和测试代码草案，重点覆盖：${generateTests.focus}。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。`
      : "请基于当前 MR 改动生成可执行测试方案和测试代码草案。输出要求：按文件路径分组，包含测试名称、前置条件、关键断言、边界/回归用例。";
    await runGitLabAsk({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      question: generateTestsQuestion,
      trigger: "comment-command",
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
      commentTitle: "AI Test Generator",
      displayQuestion: generateTests.focus
        ? `/generate_tests ${generateTests.focus}`
        : "/generate_tests",
      managedCommentKey: buildGitLabManagedCommandCommentKey(
        "generate-tests",
        generateTestsQuestion,
      ),
    });
    return { ok: true, message: "generate_tests command triggered" };
  }

  const changelogCommand = parseChangelogCommand(body);
  if (changelogCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "changelog",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "changelog command rate limited" };
    }
    if (!policy.changelogCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/changelog` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogCommandEnabled=false）。",
            en: "`/changelog` is disabled for this repository (.mr-agent.yml -> review.changelogCommandEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "changelog command ignored by policy" };
    }
    if (changelogCommand.apply && !policy.changelogAllowApply) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/changelog --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogAllowApply=false）。",
            en: "`/changelog --apply` is disabled for this repository (.mr-agent.yml -> review.changelogAllowApply=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "changelog apply ignored by policy" };
    }

    await runGitLabChangelog({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      trigger: "comment-command",
      focus: changelogCommand.focus,
      apply: changelogCommand.apply && policy.changelogAllowApply,
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
    });
    return { ok: true, message: "changelog command triggered" };
  }

  const improveCommand = parseImproveCommand(body);
  if (improveCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "improve",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "improve command rate limited" };
    }

    await runGitLabReview({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      mode: "comment",
      trigger: "comment-command",
      customRules: [...policy.customRules, buildGitLabImproveRule(improveCommand.focus)],
      includeCiChecks: policy.includeCiChecks,
      enableSecretScan: policy.secretScanEnabled,
      enableAutoLabel: false,
    });
    return { ok: true, message: "improve command triggered" };
  }

  const addDocCommand = parseAddDocCommand(body);
  if (addDocCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "add-doc",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "add_doc command rate limited" };
    }

    await runGitLabReview({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      mode: "comment",
      trigger: "comment-command",
      customRules: [...policy.customRules, buildGitLabAddDocRule(addDocCommand.focus)],
      includeCiChecks: policy.includeCiChecks,
      enableSecretScan: false,
      enableAutoLabel: false,
    });
    return { ok: true, message: "add_doc command triggered" };
  }

  const reflectCommand = parseReflectCommand(body);
  if (reflectCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "reflect",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "reflect command rate limited" };
    }
    if (!policy.askCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        target,
        localizeText(
          {
            zh: "`/reflect` 依赖 `/ask` 能力，但当前仓库已禁用 ask（.mr-agent.yml -> review.askCommandEnabled=false）。",
            en: "`/reflect` depends on `/ask`, but ask is disabled for this repository (.mr-agent.yml -> review.askCommandEnabled=false).",
          },
          locale,
        ),
      );
      return { ok: true, message: "reflect command ignored by policy" };
    }

    const reflectQuestion = buildGitLabReflectQuestion(reflectCommand.request);
    await runGitLabAsk({
      payload: mergePayload,
      headers: params.headers,
      logger: params.logger,
      question: reflectQuestion,
      trigger: "comment-command",
      customRules: policy.customRules,
      includeCiChecks: policy.includeCiChecks,
      commentTitle: "AI Reflect",
      displayQuestion: reflectCommand.request
        ? `/reflect ${reflectCommand.request}`
        : "/reflect",
      managedCommentKey: buildGitLabManagedCommandCommentKey("reflect", reflectQuestion),
    });
    return { ok: true, message: "reflect command triggered" };
  }

  const similarIssueCommand = parseSimilarIssueCommand(body);
  if (similarIssueCommand.matched) {
    if (
      await shouldRejectGitLabCommandByRateLimit({
        gitlabToken,
        target,
        projectId: payload.project.id,
        mrId: mergePayload.object_attributes.iid,
        userName: commentUserName,
        command: "similar-issue",
        logger: params.logger,
      })
    ) {
      return { ok: true, message: "similar_issue command rate limited" };
    }

    await runGitLabSimilarIssueCommand({
      payload: mergePayload,
      gitlabToken,
      query: similarIssueCommand.query,
      locale,
    });
    return { ok: true, message: "similar_issue command triggered" };
  }

  const command = parseReviewCommand(body);
  if (!command.matched) {
    return { ok: true, message: "ignored note content" };
  }
  if (
    await shouldRejectGitLabCommandByRateLimit({
      gitlabToken,
      target,
      projectId: payload.project.id,
      mrId: mergePayload.object_attributes.iid,
      userName: commentUserName,
      command: "ai-review",
      logger: params.logger,
    })
  ) {
    return { ok: true, message: "note review rate limited" };
  }

  await runGitLabReview({
    payload: mergePayload,
    headers: params.headers,
    logger: params.logger,
    mode: command.mode,
    trigger: "comment-command",
    customRules: policy.customRules,
    includeCiChecks: policy.includeCiChecks,
    enableSecretScan: policy.secretScanEnabled,
    enableAutoLabel: policy.autoLabelEnabled,
  });
  return { ok: true, message: "note review triggered" };
}

async function runGitLabAsk(params: GitLabAskRunParams): Promise<void> {
  const {
    payload,
    headers,
    logger,
    question,
    trigger,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    commentTitle = "AI Ask",
    displayQuestion,
    managedCommentKey,
    enableConversationContext = false,
    throwOnError = false,
  } = params;
  const locale = resolveUiLocale();
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:ask:${trigger}:${question.trim().replace(/\s+/g, " ").slice(0, 120)}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  const gitlabToken = requireGitLabToken(headers);
  const target = buildGitLabCommentTargetFromPayload({
    payload,
    baseUrl: process.env.GITLAB_BASE_URL,
  });
  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await postGitLabCommandComment({
      gitlabToken,
      target,
      body: localizeText(
        {
          zh: `\`${commentTitle}\` 最近 5 分钟内已执行过同类请求，本次已跳过。`,
          en: `\`${commentTitle}\` already handled a similar request in the last 5 minutes, skipped this request.`,
        },
        locale,
      ),
      managedCommentKey,
      logger,
    });
    return;
  }

  try {
    const feedbackSignals = loadGitLabFeedbackSignals(payload.project.id);
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });
    const sessionKey = `gitlab:${payload.project.id}#${payload.object_attributes.iid}`;
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
    await postGitLabCommandComment({
      gitlabToken,
      target: collected,
      body: [
        `## ${commentTitle}`,
        "",
        `**Q:** ${(displayQuestion ?? question).trim()}`,
        "",
        `**A:** ${answer}`,
      ].join("\n"),
      managedCommentKey,
      logger,
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    logger.error(
      {
        projectId: payload.project.id,
        mrId: payload.object_attributes.iid,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      },
      "GitLab ask failed",
    );
    try {
      await postGitLabCommandComment({
        gitlabToken,
        target,
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
              zh: `错误：\`${error instanceof Error ? error.message : String(error)}\``,
              en: `Error: \`${error instanceof Error ? error.message : String(error)}\``,
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
        logger,
      });
    } catch (commentError) {
      logger.error(
        {
          projectId: payload.project.id,
          mrId: payload.object_attributes.iid,
          trigger,
          error: commentError instanceof Error ? commentError.message : String(commentError),
        },
        "Failed to publish GitLab ask failure comment",
      );
    }
    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

async function runGitLabDescribe(params: GitLabDescribeRunParams): Promise<void> {
  const {
    payload,
    headers,
    logger,
    trigger,
    apply = false,
    dedupeSuffix,
    throwOnError = false,
  } = params;
  const managedCommentKey = "cmd-describe";
  const locale = resolveUiLocale();
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:describe:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  const gitlabToken = requireGitLabToken(headers);
  const target = buildGitLabCommentTargetFromPayload({
    payload,
    baseUrl: process.env.GITLAB_BASE_URL,
  });
  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await postGitLabCommandComment({
      gitlabToken,
      target,
      body: localizeText(
        {
          zh: "`AI MR 描述` 最近 5 分钟内已执行过同类请求，本次已跳过。",
          en: "`AI MR Description` already handled a similar request in the last 5 minutes, skipped this request.",
        },
        locale,
      ),
      managedCommentKey,
      logger,
    });
    return;
  }

  try {
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
    });
    const description = await answerPullRequestQuestion(
      collected.input,
      buildGitLabDescribeQuestion(locale),
    );

    if (apply) {
      await updateGitLabMergeRequestDescription({
        gitlabToken,
        collected,
        description,
      });
      await postGitLabCommandComment({
        gitlabToken,
        target: collected,
        body: [
          localizeText(
            {
              zh: "## AI MR 描述已更新",
              en: "## AI MR Description Updated",
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: "已根据当前 diff 自动生成并写入 MR 描述。",
              en: "The MR description was generated from the current diff and applied.",
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
        logger,
      });
      return;
    }

    await postGitLabCommandComment({
      gitlabToken,
      target: collected,
      body: [
        localizeText(
          {
            zh: "## AI 生成 MR 描述草稿",
            en: "## AI MR Description Draft",
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
            zh: "如需自动写入 MR 描述，请使用：`/describe --apply`",
            en: "To apply this draft to the MR description, use: `/describe --apply`",
          },
          locale,
        ),
      ].join("\n"),
      managedCommentKey,
      logger,
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    logger.error(
      {
        projectId: payload.project.id,
        mrId: payload.object_attributes.iid,
        trigger,
        apply,
        error: error instanceof Error ? error.message : String(error),
      },
      "GitLab describe failed",
    );
    try {
      await postGitLabCommandComment({
        gitlabToken,
        target,
        body: [
          localizeText(
            {
              zh: "## AI MR 描述执行失败",
              en: "## AI MR Description Failed",
            },
            locale,
          ),
          "",
          localizeText(
            {
              zh: `错误：\`${error instanceof Error ? error.message : String(error)}\``,
              en: `Error: \`${error instanceof Error ? error.message : String(error)}\``,
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
        logger,
      });
    } catch (commentError) {
      logger.error(
        {
          projectId: payload.project.id,
          mrId: payload.object_attributes.iid,
          trigger,
          apply,
          error: commentError instanceof Error ? commentError.message : String(commentError),
        },
        "Failed to publish GitLab describe failure comment",
      );
    }
    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

async function runGitLabChangelog(params: GitLabChangelogRunParams): Promise<void> {
  const {
    payload,
    headers,
    logger,
    trigger,
    focus,
    apply = false,
    dedupeSuffix,
    customRules = [],
    includeCiChecks = true,
    throwOnError = false,
  } = params;
  const managedCommentKey = "cmd-changelog";
  const locale = resolveUiLocale();
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:changelog:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");

  const gitlabToken = requireGitLabToken(headers);
  const target = buildGitLabCommentTargetFromPayload({
    payload,
    baseUrl: process.env.GITLAB_BASE_URL,
  });
  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    await postGitLabCommandComment({
      gitlabToken,
      target,
      body: localizeText(
        {
          zh: "`AI Changelog` 最近 5 分钟内已执行过同类请求，本次已跳过。",
          en: "`AI Changelog` already handled a similar request in the last 5 minutes, skipped this request.",
        },
        locale,
      ),
      managedCommentKey,
      logger,
    });
    return;
  }

  try {
    const feedbackSignals = loadGitLabFeedbackSignals(payload.project.id);
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
      customRules,
      includeCiChecks,
      feedbackSignals,
    });
    const draft = (
      await answerPullRequestQuestion(
        collected.input,
        buildGitLabChangelogQuestion(focus, locale),
      )
    ).trim();

    if (!apply) {
      await postGitLabCommandComment({
        gitlabToken,
        target: collected,
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
        logger,
      });
      return;
    }

    const applyResult = await applyGitLabChangelogUpdate({
      gitlabToken,
      collected,
      pullNumber: collected.mrId,
      draft,
    });
    await postGitLabCommandComment({
      gitlabToken,
      target: collected,
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
      logger,
    });
  } catch (error) {
    clearDuplicateRecord(requestKey);
    logger.error(
      {
        projectId: payload.project.id,
        mrId: payload.object_attributes.iid,
        trigger,
        apply,
        error: error instanceof Error ? error.message : String(error),
      },
      "GitLab changelog failed",
    );
    try {
      await postGitLabCommandComment({
        gitlabToken,
        target,
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
              zh: `错误：\`${error instanceof Error ? error.message : String(error)}\``,
              en: `Error: \`${error instanceof Error ? error.message : String(error)}\``,
            },
            locale,
          ),
        ].join("\n"),
        managedCommentKey,
        logger,
      });
    } catch (commentError) {
      logger.error(
        {
          projectId: payload.project.id,
          mrId: payload.object_attributes.iid,
          trigger,
          apply,
          error: commentError instanceof Error ? commentError.message : String(commentError),
        },
        "Failed to publish GitLab changelog failure comment",
      );
    }
    if (throwOnError) {
      throw ensureError(error);
    }
  }
}

async function collectGitLabMergeRequestContext(params: {
  payload: GitLabMrWebhookBody;
  gitlabToken: string;
  baseUrl?: string;
  incrementalBaseSha?: string;
  customRules?: string[];
  includeCiChecks?: boolean;
  feedbackSignals?: string[];
}): Promise<GitLabCollectedContext> {
  const {
    payload,
    gitlabToken,
    incrementalBaseSha,
    customRules,
    includeCiChecks = true,
    feedbackSignals,
  } = params;
  const projectId = payload.project.id;
  const mrId = payload.object_attributes.iid;
  const baseUrl = resolveGitLabBaseUrl(params.baseUrl, payload.project.web_url);

  const response = await fetchWithRetry(
    `${baseUrl}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrId}/changes`,
    {
      headers: {
        "PRIVATE-TOKEN": gitlabToken,
        "content-type": "application/json",
      },
    },
    {
      timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `获取 GitLab MR changes 失败 (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const changesResponse = (await response.json()) as GitLabChangesResponse;
  let sourceChanges = changesResponse.changes;
  if (
    incrementalBaseSha &&
    incrementalBaseSha !== changesResponse.diff_refs.head_sha
  ) {
    const compared = await loadGitLabIncrementalChanges({
      baseUrl,
      projectId,
      gitlabToken,
      incrementalBaseSha,
      headSha: changesResponse.diff_refs.head_sha,
    });
    if (compared.length > 0) {
      sourceChanges = compared;
    }
  }

  const files: DiffFileContext[] = [];
  const limits = resolveGitLabPatchCharLimits();
  let totalPatchChars = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const change of sourceChanges) {
    if (files.length >= MAX_FILES || totalPatchChars >= limits.maxTotalPatchChars) {
      break;
    }

    if (!isReviewTargetFile(change.new_path, "gitlab")) {
      continue;
    }

    const rawPatch = change.diff ?? "(binary / patch omitted)";
    const trimmedPatch = prioritizePatchHunks(
      rawPatch,
      limits.maxPatchCharsPerFile,
    );

    if (totalPatchChars + trimmedPatch.length > limits.maxTotalPatchChars) {
      break;
    }

    totalPatchChars += trimmedPatch.length;
    const parsed = parsePatchWithLineNumbers(trimmedPatch);
    const stats = countPatchChanges(trimmedPatch);
    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;

    files.push({
      newPath: change.new_path,
      oldPath: change.old_path || change.new_path,
      status: resolveGitLabChangeStatus(change),
      additions: stats.additions,
      deletions: stats.deletions,
      patch: trimmedPatch,
      extendedDiff: parsed.extendedDiff,
      oldLinesWithNumber: parsed.oldLinesWithNumber,
      newLinesWithNumber: parsed.newLinesWithNumber,
    });
  }

  const processGuidelines = await loadGitLabRepositoryProcessGuidelines({
    baseUrl,
    projectId,
    gitlabToken,
    ref: payload.object_attributes.target_branch,
  });
  const ciChecks = includeCiChecks
    ? await loadGitLabHeadChecks({
        baseUrl,
        projectId,
        gitlabToken,
        headSha: changesResponse.diff_refs.head_sha,
      })
    : [];

  const input: PullRequestReviewInput = {
    platform: "gitlab",
    repository: payload.project.path_with_namespace ?? payload.project.name,
    number: mrId,
    title: payload.object_attributes.title,
    body: payload.object_attributes.description ?? "",
    author: payload.user?.username ?? "unknown",
    baseBranch: payload.object_attributes.target_branch,
    headBranch: payload.object_attributes.source_branch,
    additions: totalAdditions,
    deletions: totalDeletions,
    changedFilesCount:
      incrementalBaseSha && incrementalBaseSha !== changesResponse.diff_refs.head_sha
        ? files.length
        : changesResponse.changes.length,
    changedFiles: files.map((file) => ({
      newPath: file.newPath,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      extendedDiff: file.extendedDiff,
    })),
    customRules: customRules ?? [],
    ciChecks,
    feedbackSignals: feedbackSignals ?? [],
    processGuidelines,
  };

  return {
    input,
    files,
    baseUrl,
    projectId,
    mrId,
    webUrl: payload.project.web_url,
    sourceBranch: payload.object_attributes.source_branch,
    targetBranch: payload.object_attributes.target_branch,
    author: payload.user?.username ?? "unknown",
    repository: payload.project.path_with_namespace ?? payload.project.name,
    diffRefs: {
      baseSha: changesResponse.diff_refs.base_sha,
      headSha: changesResponse.diff_refs.head_sha,
      startSha: changesResponse.diff_refs.start_sha,
    },
    mrUrl: payload.object_attributes.url,
  };
}

async function publishGitLabLineComments(
  gitlabToken: string,
  collected: GitLabCollectedContext,
  result: PullRequestReviewResult,
  logger: LoggerLike,
  locale: "zh" | "en",
): Promise<void> {
  let failed = 0;
  for (const review of result.reviews) {
    const file = findFileForReview(collected.files, review);
    if (!file) {
      continue;
    }

    const line = resolveReviewLineForIssue(file, review);
    if (!line) {
      continue;
    }

    const body = buildIssueCommentMarkdown(review, {
      platform: "gitlab",
      locale,
    });
    const position = {
      position_type: "text",
      base_sha: collected.diffRefs.baseSha,
      head_sha: collected.diffRefs.headSha,
      start_sha: collected.diffRefs.startSha,
      new_path: file.newPath,
      old_path: file.oldPath,
      new_line: review.type === "new" ? line : undefined,
      old_line: review.type === "old" ? line : undefined,
    };

    let response: Response;
    try {
      response = await fetchWithRetry(
        `${collected.baseUrl}/api/v4/projects/${encodeURIComponent(collected.projectId)}/merge_requests/${collected.mrId}/discussions`,
        {
          method: "POST",
          headers: {
            "PRIVATE-TOKEN": gitlabToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            body,
            position,
          }),
        },
        {
          timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
          retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
          backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
        },
      );
    } catch (error) {
      failed += 1;
      logger.error(
        {
          path: file.newPath,
          line,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to publish GitLab line comment",
      );
      continue;
    }

    if (!response.ok) {
      failed += 1;
      logger.error(
        {
          status: response.status,
          path: file.newPath,
          line,
        },
        "Failed to publish GitLab line comment",
      );
      continue;
    }
  }

  if (failed > 0) {
    logger.error({ failed }, "GitLab line comments published with failures");
  }
}

async function publishGitLabGeneralComment(
  gitlabToken: string,
  target: GitLabCommentTarget,
  body: string,
): Promise<void> {
  const response = await fetchWithRetry(
    `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/merge_requests/${target.mrId}/notes`,
    {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": gitlabToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
    {
      timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `发布 GitLab 报告评论失败 (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}

function resolveGitLabBaseUrl(
  baseUrlFromEnv: string | undefined,
  projectWebUrl: string,
): string {
  const allowInsecureHttp = readBoolEnv("ALLOW_INSECURE_GITLAB_HTTP");
  const fromEnv = baseUrlFromEnv?.trim();
  if (fromEnv) {
    return ensureSecureGitLabBaseUrl(fromEnv.replace(/\/$/, ""), allowInsecureHttp);
  }

  try {
    const parsed = new URL(projectWebUrl);
    return ensureSecureGitLabBaseUrl(parsed.origin, allowInsecureHttp);
  } catch {
    throw new Error("Missing GITLAB_BASE_URL and cannot infer from project.web_url");
  }
}

function ensureSecureGitLabBaseUrl(
  baseUrl: string,
  allowInsecureHttp: boolean,
): string {
  if (!allowInsecureHttp && /^http:\/\//i.test(baseUrl)) {
    throw new BadWebhookRequestError(
      "Insecure HTTP GitLab base URL is not allowed by default; use HTTPS or set ALLOW_INSECURE_GITLAB_HTTP=true for local testing",
    );
  }
  return baseUrl;
}

function readBoolEnv(key: string): boolean {
  const normalized = (process.env[key] ?? "").trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseMode(modeRaw: string | undefined): ReviewMode | undefined {
  if (!modeRaw?.trim()) {
    return undefined;
  }

  const mode = modeRaw?.trim().toLowerCase();
  return mode === "comment" ? "comment" : "report";
}

async function loadGitLabRepositoryProcessGuidelines(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
}): Promise<ProcessGuideline[]> {
  const { baseUrl, projectId, gitlabToken, ref } = params;
  const cacheKey = `${baseUrl}:${projectId}@${ref}`;
  const now = Date.now();
  pruneExpiredCache(guidelineCache, now);
  const cached = getFreshCacheValue(guidelineCache, cacheKey, now);
  if (cached) {
    return cached;
  }

  const guidelines: ProcessGuideline[] = [];
  const visited = new Set<string>();

  for (const path of GITLAB_GUIDELINE_FILE_PATHS) {
    await tryAddGitLabGuideline({
      baseUrl,
      projectId,
      gitlabToken,
      ref,
      path,
      guidelines,
      visited,
    });
  }

  for (const dir of GITLAB_GUIDELINE_DIRECTORIES) {
    const entries = await tryListGitLabDirectory({
      baseUrl,
      projectId,
      gitlabToken,
      ref,
      path: dir,
    });

    for (const entry of entries.slice(0, MAX_GUIDELINES_PER_DIRECTORY)) {
      if (!isProcessTemplateFile(entry.path, "gitlab")) {
        continue;
      }

      await tryAddGitLabGuideline({
        baseUrl,
        projectId,
        gitlabToken,
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
      readNumberEnv("GITLAB_GUIDELINE_CACHE_TTL_MS", DEFAULT_GUIDELINE_CACHE_TTL_MS),
    value: result,
  });
  trimCache(guidelineCache, MAX_GUIDELINE_CACHE_ENTRIES);

  return result;
}

async function tryAddGitLabGuideline(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
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

  let response: Response;
  try {
    response = await fetchWithRetry(
      `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/files/${encodeURIComponent(normalizedPath)}/raw?ref=${encodeURIComponent(params.ref)}`,
      {
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
        },
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
  } catch {
    return;
  }

  if (!response.ok) {
    return;
  }

  const content = (await response.text()).trim();
  if (!content) {
    return;
  }

  params.guidelines.push({
    path: normalizedPath,
    content: content.slice(0, 4_000),
  });
}

async function tryListGitLabDirectory(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<Array<{ path: string; type: string }>> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/tree?path=${encodeURIComponent(params.path)}&ref=${encodeURIComponent(params.ref)}&per_page=20`,
      {
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
        },
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as Array<{
    path?: string;
    type?: string;
  }>;

  return data
    .map((item) => ({
      path: item.path ?? "",
      type: item.type ?? "",
    }))
    .filter((item) => Boolean(item.path));
}

function resolveGitLabChangeStatus(change: GitLabChange): string {
  if (change.deleted_file) {
    return "removed";
  }

  if (change.new_file) {
    return "added";
  }

  if (change.renamed_file) {
    return "renamed";
  }

  return "modified";
}

function resolveGitLabDedupeTtl(trigger: GitLabReviewTrigger, mode: ReviewMode): number {
  if (trigger === "merged" && mode === "report") {
    return readNumberEnv(
      "GITLAB_MERGED_DEDUPE_TTL_MS",
      DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS,
    );
  }

  return DEFAULT_DEDUPE_TTL_MS;
}

function requireGitLabToken(headers: Record<string, string | undefined>): string {
  const token = headers["x-gitlab-api-token"] ?? process.env.GITLAB_TOKEN;
  if (!token) {
    throw new BadWebhookRequestError(
      "gitlab api token 不能为空（x-gitlab-api-token 或 GITLAB_TOKEN）",
    );
  }
  return token;
}

function mapGitLabActionToReviewEvent(
  actionRaw: string | undefined,
): "opened" | "edited" | "synchronize" | "merged" | "ignored" {
  const action = (actionRaw ?? "").toLowerCase();
  if (action === "open" || action === "reopen") {
    return "opened";
  }
  if (action === "update") {
    return "synchronize";
  }
  if (action === "merge") {
    return "merged";
  }
  if (action === "close" || action === "closed") {
    return "ignored";
  }
  return "edited";
}

function shouldRunGitLabAutoReview(
  policy: GitLabReviewPolicy,
  action: "opened" | "edited" | "synchronize" | "merged" | "ignored",
): boolean {
  if (!policy.enabled || action === "ignored") {
    return false;
  }
  if (action === "opened") {
    return policy.onOpened;
  }
  if (action === "edited") {
    return policy.onEdited;
  }
  if (action === "synchronize") {
    return policy.onSynchronize;
  }
  return true;
}

function shouldUseIncrementalReview(trigger: GitLabReviewTrigger): boolean {
  return trigger === "pr-synchronize" || trigger === "pr-edited";
}

function getIncrementalHead(reviewMrKey: string): string | undefined {
  const now = Date.now();
  pruneExpiredCache(incrementalHeadCache, now);
  return getFreshCacheValue(incrementalHeadCache, reviewMrKey, now);
}

function rememberIncrementalHead(reviewMrKey: string, headSha: string): void {
  const now = Date.now();
  incrementalHeadCache.set(reviewMrKey, {
    expiresAt:
      now +
      readNumberEnv(
        "GITLAB_INCREMENTAL_STATE_TTL_MS",
        DEFAULT_INCREMENTAL_STATE_TTL_MS,
      ),
    value: headSha,
  });
  trimCache(incrementalHeadCache, MAX_INCREMENTAL_STATE_ENTRIES);
}

function loadGitLabFeedbackSignals(projectId: number): string[] {
  const key = `${projectId}`;
  const now = Date.now();
  pruneExpiredCache(feedbackSignalCache, now);
  return getFreshCacheValue(feedbackSignalCache, key, now) ?? [];
}

async function resolveGitLabReviewPolicy(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
}): Promise<GitLabReviewPolicy> {
  const cacheKey = `${params.baseUrl}:${params.projectId}@${params.ref}`;
  const now = Date.now();
  pruneExpiredCache(gitlabPolicyCache, now);
  const cached = getFreshCacheValue(gitlabPolicyCache, cacheKey, now);
  if (cached) {
    return cached;
  }

  const raw =
    (await tryLoadGitLabTextFile({
      baseUrl: params.baseUrl,
      projectId: params.projectId,
      gitlabToken: params.gitlabToken,
      ref: params.ref,
      path: ".mr-agent.yml",
    })) ??
    (await tryLoadGitLabTextFile({
      baseUrl: params.baseUrl,
      projectId: params.projectId,
      gitlabToken: params.gitlabToken,
      ref: params.ref,
      path: ".mr-agent.yaml",
    }));

  const resolved = raw ? parseGitLabReviewPolicyConfig(raw) : defaultGitLabReviewPolicy;
  gitlabPolicyCache.set(cacheKey, {
    value: resolved,
    expiresAt:
      now +
      readNumberEnv(
        "GITLAB_POLICY_CONFIG_CACHE_TTL_MS",
        DEFAULT_POLICY_CONFIG_CACHE_TTL_MS,
      ),
  });
  trimCache(gitlabPolicyCache, 500);

  return resolved;
}

export function parseGitLabReviewPolicyConfig(raw: string): GitLabReviewPolicy {
  const policy: GitLabReviewPolicy = {
    ...defaultGitLabReviewPolicy,
    customRules: [...defaultGitLabReviewPolicy.customRules],
  };
  const lines = raw.split(/\r?\n/);
  let inReview = false;
  let reviewIndent = 0;
  let readingRules = false;
  let rulesIndent = 0;

  for (const originalLine of lines) {
    const line = stripInlineYamlComment(originalLine);
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;

    if (!inReview) {
      if (/^review\s*:\s*$/i.test(trimmed)) {
        inReview = true;
        reviewIndent = indent;
      }
      continue;
    }

    if (indent <= reviewIndent && !trimmed.startsWith("-")) {
      inReview = false;
      readingRules = false;
      continue;
    }

    if (readingRules) {
      if (indent > rulesIndent && trimmed.startsWith("- ")) {
        policy.customRules.push(stripYamlQuotes(trimmed.slice(2).trim()));
        continue;
      }
      readingRules = false;
    }

    const pair = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!pair) {
      continue;
    }

    const key = pair[1]?.trim() ?? "";
    const valueRaw = pair[2]?.trim() ?? "";
    const keyLower = key.toLowerCase();

    if (keyLower === "customrules" || keyLower === "custom_rules") {
      if (!valueRaw) {
        readingRules = true;
        rulesIndent = indent;
        continue;
      }
      if (valueRaw.startsWith("[")) {
        policy.customRules = valueRaw
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .map((item) => stripYamlQuotes(item.trim()))
          .filter(Boolean)
          .slice(0, 30);
      }
      continue;
    }

    const bool = parseYamlBoolean(valueRaw);
    if (keyLower === "enabled" && bool !== undefined) {
      policy.enabled = bool;
      continue;
    }
    if (keyLower === "mode") {
      const normalizedMode = stripYamlQuotes(valueRaw).trim().toLowerCase();
      if (normalizedMode === "comment" || normalizedMode === "report") {
        policy.mode = normalizedMode;
      }
      continue;
    }
    if ((keyLower === "onopened" || keyLower === "on_opened") && bool !== undefined) {
      policy.onOpened = bool;
      continue;
    }
    if ((keyLower === "onedited" || keyLower === "on_edited") && bool !== undefined) {
      policy.onEdited = bool;
      continue;
    }
    if (
      (keyLower === "onsynchronize" || keyLower === "on_synchronize") &&
      bool !== undefined
    ) {
      policy.onSynchronize = bool;
      continue;
    }
    if (
      (keyLower === "describeenabled" || keyLower === "describe_enabled") &&
      bool !== undefined
    ) {
      policy.describeEnabled = bool;
      continue;
    }
    if (
      (keyLower === "describeallowapply" || keyLower === "describe_allow_apply") &&
      bool !== undefined
    ) {
      policy.describeAllowApply = bool;
      continue;
    }
    if (
      (keyLower === "checkscommandenabled" || keyLower === "checks_command_enabled") &&
      bool !== undefined
    ) {
      policy.checksCommandEnabled = bool;
      continue;
    }
    if (
      (keyLower === "includecichecks" || keyLower === "include_ci_checks") &&
      bool !== undefined
    ) {
      policy.includeCiChecks = bool;
      continue;
    }
    if (
      (keyLower === "secretscanenabled" || keyLower === "secret_scan_enabled") &&
      bool !== undefined
    ) {
      policy.secretScanEnabled = bool;
      continue;
    }
    if (
      (keyLower === "autolabelenabled" || keyLower === "auto_label_enabled") &&
      bool !== undefined
    ) {
      policy.autoLabelEnabled = bool;
      continue;
    }
    if ((keyLower === "askcommandenabled" || keyLower === "ask_command_enabled") && bool !== undefined) {
      policy.askCommandEnabled = bool;
      continue;
    }
    if (
      (keyLower === "generatetestscommandenabled" ||
        keyLower === "generate_tests_command_enabled") &&
      bool !== undefined
    ) {
      policy.generateTestsCommandEnabled = bool;
      continue;
    }
    if (
      (keyLower === "changelogcommandenabled" ||
        keyLower === "changelog_command_enabled") &&
      bool !== undefined
    ) {
      policy.changelogCommandEnabled = bool;
      continue;
    }
    if (
      (keyLower === "changelogallowapply" || keyLower === "changelog_allow_apply") &&
      bool !== undefined
    ) {
      policy.changelogAllowApply = bool;
      continue;
    }
    if (
      (keyLower === "feedbackcommandenabled" || keyLower === "feedback_command_enabled") &&
      bool !== undefined
    ) {
      policy.feedbackCommandEnabled = bool;
      continue;
    }
  }

  policy.customRules = policy.customRules
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30);
  return policy;
}

function parseYamlBoolean(raw: string): boolean | undefined {
  const normalized = stripYamlQuotes(raw).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function isGitLabBotUserName(userName: string | undefined): boolean {
  const normalized = (userName ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.endsWith("[bot]") ||
    normalized.endsWith("_bot") ||
    normalized === "gitlab-bot" ||
    normalized === "gitlab_ci_bot"
  );
}

function stripInlineYamlComment(line: string): string {
  const hashIndex = line.indexOf("#");
  if (hashIndex === -1) {
    return line;
  }

  const before = line.slice(0, hashIndex);
  const quotes = before.match(/['"]/g)?.length ?? 0;
  if (quotes % 2 === 1) {
    return line;
  }
  return before;
}

function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function tryLoadGitLabTextFile(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  ref: string;
  path: string;
}): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/files/${encodeURIComponent(params.path)}/raw?ref=${encodeURIComponent(params.ref)}`,
      {
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
        },
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  const text = (await response.text()).trim();
  return text || undefined;
}

export function buildMergeRequestPayloadFromNote(
  payload: GitLabNoteWebhookBody,
): GitLabMrWebhookBody {
  const iid =
    parsePositiveInteger(payload.merge_request?.iid) ??
    parsePositiveInteger(payload.object_attributes.noteable_iid);
  const sourceBranch =
    typeof payload.merge_request?.source_branch === "string"
      ? payload.merge_request.source_branch
      : "";
  const targetBranch =
    typeof payload.merge_request?.target_branch === "string"
      ? payload.merge_request.target_branch
      : "";
  const title =
    typeof payload.merge_request?.title === "string"
      ? payload.merge_request.title
      : "";
  const urlRaw = payload.merge_request?.url ?? payload.object_attributes.url;
  const url = typeof urlRaw === "string" ? urlRaw : "";
  if (!iid || !sourceBranch || !targetBranch || !title || !url) {
    throw new BadWebhookRequestError(
      "invalid gitlab note payload for merge request command",
    );
  }

  return {
    object_kind: "merge_request",
    event_type: payload.event_type,
    user: payload.user,
    project: payload.project,
    object_attributes: {
      action: "update",
      state: payload.merge_request?.state,
      iid,
      url,
      title,
      description: payload.merge_request?.description,
      source_branch: sourceBranch,
      target_branch: targetBranch,
    },
    merge_request: payload.merge_request,
  };
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

async function loadGitLabIncrementalChanges(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
  incrementalBaseSha: string;
  headSha: string;
}): Promise<GitLabChange[]> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/compare?from=${encodeURIComponent(params.incrementalBaseSha)}&to=${encodeURIComponent(params.headSha)}`,
      {
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
          "content-type": "application/json",
        },
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as GitLabCompareResponse;
  return Array.isArray(data.diffs) ? data.diffs : [];
}

async function loadGitLabHeadChecks(params: {
  baseUrl: string;
  projectId: number;
  gitlabToken: string;
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
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${params.baseUrl}/api/v4/projects/${encodeURIComponent(params.projectId)}/repository/commits/${encodeURIComponent(params.headSha)}/statuses?per_page=100`,
      {
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
          "content-type": "application/json",
        },
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as Array<{
    name?: string;
    status?: string;
    target_url?: string | null;
    description?: string | null;
  }>;
  if (!Array.isArray(data)) {
    return [];
  }

  return data.slice(0, 50).map((item) => {
    const status = item.status?.trim() || "unknown";
    return {
      name: item.name?.trim() || "unknown-check",
      status,
      conclusion: mapGitLabStatusToConclusion(status),
      detailsUrl: item.target_url ?? undefined,
      summary: item.description ?? undefined,
    };
  });
}

export function mapGitLabStatusToConclusion(statusRaw: string | undefined): string {
  const status = statusRaw?.trim().toLowerCase() ?? "";
  if (status === "success") {
    return "success";
  }
  if (status === "failed" || status === "failure") {
    return "failure";
  }
  if (status === "canceled" || status === "cancelled") {
    return "cancelled";
  }
  if (status === "skipped") {
    return "skipped";
  }
  if (status === "manual") {
    return "action_required";
  }
  if (
    status === "running" ||
    status === "pending" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  ) {
    return "pending";
  }
  return "unknown";
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
    }
  }

  return findings.slice(0, 20);
}

function extractAddedLines(
  patch: string,
  path: string,
): Array<{ path: string; line: number; text: string }> {
  const lines = patch.split("\n");
  const items: Array<{ path: string; line: number; text: string }> = [];
  let currentNew = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/^\@\@ -\d+,?\d* \+(\d+),?\d* \@\@/);
      currentNew = match?.[1] ? Number(match[1]) : currentNew;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      items.push({
        path,
        line: currentNew,
        text: line.slice(1),
      });
      currentNew += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      currentNew += 1;
      continue;
    }
  }

  return items;
}

function detectSecretOnLine(line: string): { kind: string; sample: string } | undefined {
  const patterns: Array<{ kind: string; re: RegExp }> = [
    {
      kind: "AWS Access Key",
      re: /\bAKIA[0-9A-Z]{16}\b/,
    },
    {
      kind: "GitHub Token",
      re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    },
    {
      kind: "Generic Secret Assignment",
      re: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\\n]{8,}["']/i,
    },
    {
      kind: "JWT",
      re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/,
    },
  ];

  for (const pattern of patterns) {
    const matched = line.match(pattern.re);
    if (matched) {
      return {
        kind: pattern.kind,
        sample: matched[0].slice(0, 24),
      };
    }
  }
  return undefined;
}

function isLikelyPlaceholder(line: string): boolean {
  return /\b(example|sample|placeholder|dummy|changeme|your_?)\b/i.test(line);
}

function buildGitLabSecretWarningComment(
  findings: SecretFinding[],
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  const rows = findings
    .slice(0, 10)
    .map(
      (item) =>
        localizeText(
          {
            zh: `- \`${item.path}:${item.line}\` (${item.kind}) 片段: \`${item.sample}\``,
            en: `- \`${item.path}:${item.line}\` (${item.kind}) sample: \`${item.sample}\``,
          },
          locale,
        ),
    )
    .join("\n");
  return [
    localizeText(
      {
        zh: "## 安全提醒：疑似密钥泄露",
        en: "## Security Alert: Potential Secret Leak",
      },
      locale,
    ),
    "",
    localizeText(
      {
        zh: "以下变更行可能包含敏感信息，请尽快轮换并移除：",
        en: "The following changed lines may contain sensitive information. Please rotate and remove them as soon as possible:",
      },
      locale,
    ),
    rows || localizeText({ zh: "- (无)", en: "- (none)" }, locale),
    "",
    localizeText(
      {
        zh: "建议：启用 GitLab Secret Detection 作为长期防线。",
        en: "Recommendation: enable GitLab Secret Detection as a long-term safeguard.",
      },
      locale,
    ),
  ].join("\n");
}

export function inferMergeRequestLabels(params: {
  title: string;
  files: DiffFileContext[];
  reviewResult: PullRequestReviewResult;
  hasSecretFinding: boolean;
}): string[] {
  const labels = new Set<string>();
  const title = params.title.toLowerCase();
  if (/\b(fix|bug|hotfix)\b/.test(title)) {
    labels.add("bugfix");
  }
  if (/\b(feat|feature)\b/.test(title)) {
    labels.add("feature");
  }
  if (/\brefactor\b/.test(title)) {
    labels.add("refactor");
  }
  if (/\b(doc|readme)\b/.test(title)) {
    labels.add("docs");
  }
  if (params.hasSecretFinding) {
    labels.add("security");
  }

  for (const file of params.files) {
    const path = file.newPath.toLowerCase();
    if (path.includes("/test") || path.endsWith(".spec.ts") || path.endsWith(".test.ts")) {
      labels.add("tests");
    }
    if (path.includes("workflow") || path.includes("ci")) {
      labels.add("ci");
    }
    if (path.endsWith(".md")) {
      labels.add("docs");
    }
  }

  if (params.reviewResult.riskLevel === "high") {
    labels.add("high-risk");
  }
  return Array.from(labels).slice(0, 10);
}

export async function tryAddGitLabMergeRequestLabels(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  labels: string[];
  logger: LoggerLike;
}): Promise<void> {
  if (params.labels.length === 0) {
    return;
  }

  try {
    const response = await fetchWithRetry(
      `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/merge_requests/${params.collected.mrId}`,
      {
        method: "PUT",
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          add_labels: params.labels.join(","),
        }),
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitLab labels API failed (${response.status}): ${errorText.slice(0, 300)}`,
      );
    }
  } catch (error) {
    params.logger.error(
      {
        projectId: params.collected.projectId,
        mrId: params.collected.mrId,
        labels: params.labels,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to add GitLab merge request labels",
    );
  }
}

async function updateGitLabMergeRequestDescription(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  description: string;
}): Promise<void> {
  const response = await fetchWithRetry(
    `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/merge_requests/${params.collected.mrId}`,
    {
      method: "PUT",
      headers: {
        "PRIVATE-TOKEN": params.gitlabToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        description: params.description,
      }),
    },
    {
      timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `更新 GitLab MR 描述失败 (${response.status}): ${text.slice(0, 300)}`,
    );
  }
}

export function buildGitLabChangelogQuestion(
  focus: string | undefined,
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  const normalizedFocus = focus?.trim() ?? "";
  if (locale === "en") {
    if (normalizedFocus) {
      return `Generate a Markdown changelog entry (Keep a Changelog style) for the current MR changes, with extra focus on: ${normalizedFocus}. Output only the changelog content body without extra explanation.`;
    }
    return "Generate a Markdown changelog entry (Keep a Changelog style) for the current MR changes. Output only the changelog content body without extra explanation.";
  }

  if (normalizedFocus) {
    return `请根据当前 MR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格），重点覆盖：${normalizedFocus}。仅输出 changelog 内容本体，不要额外说明。`;
  }

  return "请根据当前 MR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格）。仅输出 changelog 内容本体，不要额外说明。";
}

export function buildGitLabDescribeQuestion(
  locale: "zh" | "en" = resolveUiLocale(),
): string {
  if (locale === "en") {
    return [
      "Based on current MR changes, generate a Markdown draft that can be pasted directly into the MR description.",
      "Structure requirements: include the following headings in this exact order:",
      "## Summary",
      "## Change Overview",
      "## File Walkthrough",
      "## Test Plan",
      "Content requirements:",
      "1) Summarize the objective, impact scope, and major risk points;",
      "2) In Change Overview, include source/target branches and change size;",
      "3) In File Walkthrough, cover key files and change intent;",
      "4) In Test Plan, provide an executable verification checklist.",
      "Output requirement: return Markdown body only. No JSON, no code fences, no extra explanation.",
    ].join("\n");
  }

  return [
    "请基于当前 MR 的变更内容，生成一份可直接粘贴到 MR 描述区的 Markdown 草稿。",
    "结构要求：必须包含以下标题（按顺序）：",
    "## Summary",
    "## Change Overview",
    "## File Walkthrough",
    "## Test Plan",
    "内容要求：",
    "1) 总结本次变更目标、影响范围与风险点；",
    "2) Change Overview 里说明 source/target 分支和变更规模；",
    "3) File Walkthrough 覆盖关键文件与改动意图；",
    "4) Test Plan 给出可执行的验证清单。",
    "输出要求：只输出 Markdown 本体，不要 JSON，不要代码块，不要额外解释。",
  ].join("\n");
}

function buildGitLabImproveRule(focus: string): string {
  const normalizedFocus = focus.trim();
  if (normalizedFocus) {
    return `Focus mode: improvement suggestions only. Prioritize high-impact fixes related to: ${normalizedFocus}. Prefer concrete code suggestions when possible.`;
  }
  return "Focus mode: improvement suggestions only. Prioritize high-impact fixes and include concrete code suggestions when possible.";
}

function buildGitLabAddDocRule(focus: string): string {
  const normalizedFocus = focus.trim();
  if (normalizedFocus) {
    return `Focus mode: docstrings/comments only. Improve developer-facing documentation for: ${normalizedFocus}. Output only doc-related findings with concrete snippets.`;
  }
  return "Focus mode: docstrings/comments only. Output only documentation-related findings with concrete doc snippet suggestions.";
}

function buildGitLabReflectQuestion(request: string): string {
  const normalizedRequest = request.trim();
  if (normalizedRequest) {
    return `请基于当前 MR 改动与以下目标，给出 3-5 个澄清问题，帮助作者明确需求与验收标准。目标：${normalizedRequest}。要求：每个问题一句话，按优先级排序，并附带“为什么要确认”。`;
  }
  return "请基于当前 MR 改动给出 3-5 个澄清问题，帮助作者明确需求与验收标准。要求：每个问题一句话，按优先级排序，并附带“为什么要确认”。";
}

async function runGitLabSimilarIssueCommand(params: {
  payload: GitLabMrWebhookBody;
  gitlabToken: string;
  query: string;
  locale: "zh" | "en";
}): Promise<void> {
  const target = buildGitLabCommentTargetFromPayload({
    payload: params.payload,
    baseUrl: process.env.GITLAB_BASE_URL,
  });
  const query = resolveGitLabSimilarIssueQuery(params.payload, params.query);
  if (!query) {
    await publishGitLabGeneralComment(
      params.gitlabToken,
      target,
      localizeText(
        {
          zh: "无法提取用于相似 Issue 检索的查询文本，请在命令后追加关键词，例如：`/similar_issue timeout race condition`。",
          en: "Unable to derive a search query for similar issues. Add keywords, for example: `/similar_issue timeout race condition`.",
        },
        params.locale,
      ),
    );
    return;
  }

  const response = await fetchWithRetry(
    `${target.baseUrl}/api/v4/projects/${encodeURIComponent(target.projectId)}/issues?state=all&order_by=updated_at&sort=desc&per_page=100`,
    {
      headers: {
        "PRIVATE-TOKEN": params.gitlabToken,
      },
    },
    {
      timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `加载 GitLab Issues 失败 (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const rawIssues = (await response.json()) as Array<{
    iid?: number;
    title?: string;
    description?: string;
    state?: string;
    web_url?: string;
  }>;
  const candidates = rawIssues
    .map((issue) => ({
      id: issue.iid ?? 0,
      title: issue.title ?? "",
      body: issue.description ?? "",
      url: issue.web_url ?? "",
      state: issue.state,
    }))
    .filter((issue) => issue.id > 0)
    .filter((issue) => issue.id !== params.payload.object_attributes.iid)
    .filter((issue) => Boolean(issue.url && issue.title));

  const matches = findSimilarIssues({
    query,
    candidates,
    limit: 5,
  });

  await publishGitLabGeneralComment(
    params.gitlabToken,
    target,
    buildGitLabSimilarIssueComment(query, matches, params.locale),
  );
}

function resolveGitLabSimilarIssueQuery(
  payload: GitLabMrWebhookBody,
  query: string,
): string {
  const fromCommand = query.trim();
  if (fromCommand) {
    return fromCommand;
  }

  return [payload.object_attributes.title ?? "", payload.object_attributes.description ?? ""]
    .join(" ")
    .trim();
}

function buildGitLabSimilarIssueComment(
  query: string,
  matches: Array<{
    id: number | string;
    title: string;
    url: string;
    state?: string | null;
    score: number;
    matchedTerms: string[];
  }>,
  locale: "zh" | "en",
): string {
  if (matches.length === 0) {
    return localizeText(
      {
        zh:
          "## AI Similar Issue Finder\n\n未发现高相关 Issue。\n\n可尝试提供更具体关键词，例如：`/similar_issue auth token refresh race`。",
        en:
          "## AI Similar Issue Finder\n\nNo highly related issues found.\n\nTry more specific keywords, for example: `/similar_issue auth token refresh race`.",
      },
      locale,
    );
  }

  return [
    "## AI Similar Issue Finder",
    "",
    `${localizeText({ zh: "查询", en: "Query" }, locale)}: \`${query}\``,
    "",
    ...matches.map((item, index) => {
      const terms = item.matchedTerms.length > 0 ? item.matchedTerms.join(", ") : "-";
      const state = (item.state ?? "unknown").toString();
      return `${index + 1}. [#${item.id}](${item.url}) ${item.title} (state=${state}, score=${item.score}, terms=${terms})`;
    }),
  ].join("\n");
}

function getPublicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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

async function applyGitLabChangelogUpdate(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
  const locale = resolveUiLocale();
  const path = process.env.GITLAB_CHANGELOG_PATH?.trim() || "CHANGELOG.md";
  let existing = "";
  let action: "create" | "update" = "create";

  try {
    const response = await fetchWithRetry(
      `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(params.collected.sourceBranch)}`,
      {
        headers: {
          "PRIVATE-TOKEN": params.gitlabToken,
        },
      },
      {
        timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
        retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
        backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
      },
    );
    if (response.ok) {
      existing = await response.text();
      action = "update";
    }
  } catch {
    // create new file fallback
  }

  const merged = mergeGitLabChangelogContent(
    existing,
    params.draft,
    `MR !${params.pullNumber}`,
  );
  const commitResponse = await fetchWithRetry(
    `${params.collected.baseUrl}/api/v4/projects/${encodeURIComponent(params.collected.projectId)}/repository/commits`,
    {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": params.gitlabToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        branch: params.collected.sourceBranch,
        commit_message: `chore(changelog): update from MR !${params.pullNumber}`,
        actions: [
          {
            action,
            file_path: path,
            content: merged,
          },
        ],
      }),
    },
    {
      timeoutMs: readNumberEnv("GITLAB_HTTP_TIMEOUT_MS", 30_000),
      retries: readNumberEnv("GITLAB_HTTP_RETRIES", 2),
      backoffMs: readNumberEnv("GITLAB_HTTP_RETRY_BACKOFF_MS", 400),
    },
  );
  if (!commitResponse.ok) {
    const text = await commitResponse.text();
    throw new Error(
      `更新 GitLab CHANGELOG 失败 (${commitResponse.status}): ${text.slice(0, 300)}`,
    );
  }

  return {
    message: localizeText(
      {
        zh: `已写入 \`${path}\`（branch: \`${params.collected.sourceBranch}\`）。`,
        en: `Written to \`${path}\` (branch: \`${params.collected.sourceBranch}\`).`,
      },
      locale,
    ),
  };
}

export function mergeGitLabChangelogContent(
  currentContent: string,
  draft: string,
  title: string,
): string {
  const normalizedDraft = draft.trim();
  const safeTitle = title.trim();
  const body = currentContent.trim();
  if (body && hasGitLabChangelogTitle(body, safeTitle)) {
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

function hasGitLabChangelogTitle(content: string, title: string): boolean {
  const safeTitle = title.trim();
  if (!safeTitle) {
    return false;
  }

  const escapedTitle = safeTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^###\\s+${escapedTitle}\\s*$`, "im").test(content);
}
