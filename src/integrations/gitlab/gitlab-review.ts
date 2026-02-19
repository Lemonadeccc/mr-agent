import {
  BadWebhookRequestError,
  clearDuplicateRecord,
  ensureError,
  fetchWithRetry,
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
  countPatchChanges,
  findFileForReview,
  GITLAB_GUIDELINE_DIRECTORIES,
  GITLAB_GUIDELINE_FILE_PATHS,
  isProcessTemplateFile,
  isReviewTargetFile,
  parseAskCommand,
  parseChangelogCommand,
  parseChecksCommand,
  parseDescribeCommand,
  parseFeedbackCommand,
  parseGenerateTestsCommand,
  parsePatchWithLineNumbers,
  parseReviewCommand,
  resolveReviewLineForIssue,
} from "#review";
import type {
  DiffFileContext,
  PullRequestReviewInput,
  PullRequestReviewResult,
  ReviewMode,
} from "#review";

const MAX_FILES = 40;
const MAX_PATCH_CHARS_PER_FILE = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MERGED_REPORT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_INCREMENTAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_FEEDBACK_SIGNAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_POLICY_CONFIG_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;
const MAX_INCREMENTAL_STATE_ENTRIES = 2_000;
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
type GitLabReviewPolicyCacheEntry = ExpiringCacheEntry<GitLabReviewPolicy>;

const guidelineCache = new Map<string, ProcessGuidelineCacheEntry>();
const incrementalHeadCache = new Map<string, IncrementalHeadCacheEntry>();
const feedbackSignalCache = new Map<string, FeedbackSignalCacheEntry>();
const gitlabPolicyCache = new Map<string, GitLabReviewPolicyCacheEntry>();

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

interface GitLabCollectedContext {
  input: PullRequestReviewInput;
  files: DiffFileContext[];
  baseUrl: string;
  projectId: number;
  mrId: number;
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
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:${mode}:${trigger}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (isDuplicateRequest(requestKey, resolveGitLabDedupeTtl(trigger, mode))) {
    return { ok: true, message: "duplicate request ignored" };
  }

  const gitlabToken = requireGitLabToken(headers);
  const reviewMrKey = `${payload.project.id}#${payload.object_attributes.iid}`;
  const incrementalBaseSha = shouldUseIncrementalReview(trigger)
    ? getIncrementalHead(reviewMrKey)
    : undefined;

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
      await publishGitLabGeneralComment(
        gitlabToken,
        collected,
        "`AI Review` 未发现可评审的文本改动，已跳过。",
      );
      rememberIncrementalHead(reviewMrKey, collected.diffRefs.headSha);
      return { ok: true, message: "no textual diff to review" };
    }

    const result = await analyzePullRequest(collected.input);
    if (mode === "comment") {
      await publishGitLabLineComments(gitlabToken, collected, result, logger);
      await publishGitLabGeneralComment(
        gitlabToken,
        collected,
        "## AI 评审结果（Comment 模式）\n\n如需汇总报告，请评论：`/ai-review report`",
      );
    } else {
      const markdown = buildReportCommentMarkdown(result, collected.files, {
        platform: "gitlab",
        webUrl: collected.webUrl,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
      });
      await publishGitLabGeneralComment(gitlabToken, collected, markdown);
    }

    if (enableSecretScan) {
      const findings = findPotentialSecrets(collected.files);
      if (findings.length > 0) {
        const warning = buildGitLabSecretWarningComment(findings);
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
        content: `代码评审完毕 ${collected.mrUrl}`,
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
        content: `代码评审失败: ${reason}`,
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
  const current = feedbackSignalCache.get(key)?.value ?? [];
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
  if (!body) {
    return { ok: true, message: "empty note body" };
  }

  const mergePayload = buildMergeRequestPayloadFromNote(payload);
  const gitlabToken = requireGitLabToken(params.headers);
  const baseUrl = resolveGitLabBaseUrl(process.env.GITLAB_BASE_URL, payload.project.web_url);
  const policy = await resolveGitLabReviewPolicy({
    baseUrl,
    projectId: payload.project.id,
    gitlabToken,
    ref: mergePayload.object_attributes.target_branch,
  });

  const feedbackCommand = parseFeedbackCommand(body);
  if (feedbackCommand.matched) {
    if (!policy.feedbackCommandEnabled) {
      await publishGitLabGeneralComment(
        gitlabToken,
        await collectGitLabMergeRequestContext({
          payload: mergePayload,
          gitlabToken,
          baseUrl: process.env.GITLAB_BASE_URL,
        }),
        "`/feedback` 在当前仓库已被禁用（.mr-agent.yml -> review.feedbackCommandEnabled=false）。",
      );
      return { ok: true, message: "feedback command ignored by policy" };
    }

    const positive =
      feedbackCommand.action === "resolved" || feedbackCommand.action === "up";
    const signalCore = positive
      ? "开发者更偏好高置信、可落地建议"
      : "开发者希望减少低价值或噪音建议";
    const noteText = feedbackCommand.note ? `；备注：${feedbackCommand.note}` : "";
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
      `已记录反馈信号：\`${feedbackCommand.action}\`。后续评审会参考该偏好。`,
    );
    return { ok: true, message: "feedback command recorded" };
  }

  const describe = parseDescribeCommand(body);
  if (describe.matched) {
    if (!policy.describeEnabled) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/describe` 在当前仓库已被禁用（.mr-agent.yml -> review.describeEnabled=false）。",
      );
      return { ok: true, message: "describe command ignored by policy" };
    }
    if (describe.apply && !policy.describeAllowApply) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/describe --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.describeAllowApply=false）。",
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
    if (!policy.askCommandEnabled) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/ask` 在当前仓库已被禁用（.mr-agent.yml -> review.askCommandEnabled=false）。",
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
    });
    return { ok: true, message: "ask command triggered" };
  }

  const checksCommand = parseChecksCommand(body);
  if (checksCommand.matched) {
    if (!policy.checksCommandEnabled) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/checks` 在当前仓库已被禁用（.mr-agent.yml -> review.checksCommandEnabled=false）。",
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
    });
    return { ok: true, message: "checks command triggered" };
  }

  const generateTests = parseGenerateTestsCommand(body);
  if (generateTests.matched) {
    if (!policy.generateTestsCommandEnabled) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/generate_tests` 在当前仓库已被禁用（.mr-agent.yml -> review.generateTestsCommandEnabled=false）。",
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
    });
    return { ok: true, message: "generate_tests command triggered" };
  }

  const changelogCommand = parseChangelogCommand(body);
  if (changelogCommand.matched) {
    if (!policy.changelogCommandEnabled) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/changelog` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogCommandEnabled=false）。",
      );
      return { ok: true, message: "changelog command ignored by policy" };
    }
    if (changelogCommand.apply && !policy.changelogAllowApply) {
      const context = await collectGitLabMergeRequestContext({
        payload: mergePayload,
        gitlabToken,
        baseUrl: process.env.GITLAB_BASE_URL,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        context,
        "`/changelog --apply` 在当前仓库已被禁用（.mr-agent.yml -> review.changelogAllowApply=false）。",
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

  const command = parseReviewCommand(body);
  if (!command.matched) {
    return { ok: true, message: "ignored note content" };
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
    throwOnError = false,
  } = params;
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:ask:${trigger}:${question.trim().replace(/\s+/g, " ").slice(0, 120)}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    return;
  }

  const gitlabToken = requireGitLabToken(headers);
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
    const answer = await answerPullRequestQuestion(collected.input, question);
    await publishGitLabGeneralComment(
      gitlabToken,
      collected,
      [
        `## ${commentTitle}`,
        "",
        `**Q:** ${(displayQuestion ?? question).trim()}`,
        "",
        `**A:** ${answer}`,
      ].join("\n"),
    );
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
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:describe:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    return;
  }

  const gitlabToken = requireGitLabToken(headers);
  try {
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
    });
    const result = await analyzePullRequest(collected.input);
    const description = buildMergeRequestDescriptionDraft(collected, result);

    if (apply) {
      await updateGitLabMergeRequestDescription({
        gitlabToken,
        collected,
        description,
      });
      await publishGitLabGeneralComment(
        gitlabToken,
        collected,
        "## AI MR 描述已更新\n\n已根据当前 diff 自动生成并写入 MR 描述。",
      );
      return;
    }

    await publishGitLabGeneralComment(
      gitlabToken,
      collected,
      [
        "## AI 生成 MR 描述草稿",
        "",
        "```markdown",
        description,
        "```",
        "",
        "如需自动写入 MR 描述，请使用：`/describe --apply`",
      ].join("\n"),
    );
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
  const requestKey = [
    `gitlab:${payload.project.id}#${payload.object_attributes.iid}:changelog:${trigger}:${apply ? "apply" : "draft"}`,
    dedupeSuffix,
  ]
    .filter(Boolean)
    .join(":");
  if (isDuplicateRequest(requestKey, DEFAULT_DEDUPE_TTL_MS)) {
    return;
  }

  const gitlabToken = requireGitLabToken(headers);
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
      await answerPullRequestQuestion(collected.input, buildChangelogQuestion(focus))
    ).trim();

    if (!apply) {
      await publishGitLabGeneralComment(
        gitlabToken,
        collected,
        [
          "## AI Changelog Draft",
          "",
          draft,
          "",
          "如需自动写入仓库 CHANGELOG，请使用：`/changelog --apply`。",
        ].join("\n"),
      );
      return;
    }

    const applyResult = await applyGitLabChangelogUpdate({
      gitlabToken,
      collected,
      pullNumber: collected.mrId,
      draft,
    });
    await publishGitLabGeneralComment(
      gitlabToken,
      collected,
      ["## AI Changelog 已更新", "", applyResult.message, "", "```markdown", draft, "```"].join(
        "\n",
      ),
    );
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
  let totalPatchChars = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const change of sourceChanges) {
    if (files.length >= MAX_FILES || totalPatchChars >= MAX_TOTAL_PATCH_CHARS) {
      break;
    }

    if (!isReviewTargetFile(change.new_path, "gitlab")) {
      continue;
    }

    const rawPatch = change.diff ?? "(binary / patch omitted)";
    const trimmedPatch =
      rawPatch.length > MAX_PATCH_CHARS_PER_FILE
        ? `${rawPatch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n... [patch truncated]`
        : rawPatch;

    if (totalPatchChars + trimmedPatch.length > MAX_TOTAL_PATCH_CHARS) {
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

    const body = buildIssueCommentMarkdown(review, { platform: "gitlab" });
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
  collected: GitLabCollectedContext,
  body: string,
): Promise<void> {
  const response = await fetchWithRetry(
    `${collected.baseUrl}/api/v4/projects/${encodeURIComponent(collected.projectId)}/merge_requests/${collected.mrId}/notes`,
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
  const fromEnv = baseUrlFromEnv?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }

  try {
    const parsed = new URL(projectWebUrl);
    return parsed.origin;
  } catch {
    throw new Error("Missing GITLAB_BASE_URL and cannot infer from project.web_url");
  }
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
  const cached = guidelineCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
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
  const cached = incrementalHeadCache.get(reviewMrKey);
  if (!cached || cached.expiresAt <= now) {
    return undefined;
  }

  return cached.value;
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
  return feedbackSignalCache.get(key)?.value ?? [];
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
  const cached = gitlabPolicyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
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

function parseGitLabReviewPolicyConfig(raw: string): GitLabReviewPolicy {
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
      policy.mode = valueRaw.toLowerCase() === "comment" ? "comment" : "report";
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
  const normalized = raw.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
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

function buildMergeRequestPayloadFromNote(payload: GitLabNoteWebhookBody): GitLabMrWebhookBody {
  const iid = Number(payload.merge_request?.iid ?? 0);
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

  return data.slice(0, 50).map((item) => ({
    name: item.name?.trim() || "unknown-check",
    status: item.status?.trim() || "unknown",
    conclusion: item.status?.trim() || "unknown",
    detailsUrl: item.target_url ?? undefined,
    summary: item.description ?? undefined,
  }));
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

function buildGitLabSecretWarningComment(findings: SecretFinding[]): string {
  const rows = findings
    .slice(0, 10)
    .map(
      (item) =>
        `- \`${item.path}:${item.line}\` (${item.kind}) 片段: \`${item.sample}\``,
    )
    .join("\n");
  return [
    "## 安全提醒：疑似密钥泄露",
    "",
    "以下变更行可能包含敏感信息，请尽快轮换并移除：",
    rows || "- (none)",
    "",
    "建议：启用 GitLab Secret Detection 作为长期防线。",
  ].join("\n");
}

function inferMergeRequestLabels(params: {
  title: string;
  files: DiffFileContext[];
  reviewResult: PullRequestReviewResult;
  hasSecretFinding: boolean;
}): string[] {
  const labels = new Set<string>();
  const title = params.title.toLowerCase();
  if (/\bfix|bug|hotfix\b/.test(title)) {
    labels.add("bugfix");
  }
  if (/\bfeat|feature\b/.test(title)) {
    labels.add("feature");
  }
  if (/\brefactor\b/.test(title)) {
    labels.add("refactor");
  }
  if (/\bdoc|readme\b/.test(title)) {
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

async function tryAddGitLabMergeRequestLabels(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  labels: string[];
  logger: LoggerLike;
}): Promise<void> {
  if (params.labels.length === 0) {
    return;
  }

  try {
    await fetchWithRetry(
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

function buildMergeRequestDescriptionDraft(
  collected: GitLabCollectedContext,
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
    `- Base -> Head: \`${collected.targetBranch}\` -> \`${collected.sourceBranch}\``,
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
  ].join("\n");
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

function buildChangelogQuestion(focus: string | undefined): string {
  if (focus && focus.trim()) {
    return `请根据当前 MR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格），重点覆盖：${focus.trim()}。仅输出 changelog 内容本体，不要额外说明。`;
  }

  return "请根据当前 MR 改动生成可直接放入 CHANGELOG.md 的 Markdown 条目（Keep a Changelog 风格）。仅输出 changelog 内容本体，不要额外说明。";
}

async function applyGitLabChangelogUpdate(params: {
  gitlabToken: string;
  collected: GitLabCollectedContext;
  pullNumber: number;
  draft: string;
}): Promise<{ message: string }> {
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

  const merged = mergeChangelogContent(
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
    message: `已写入 \`${path}\`（branch: \`${params.collected.sourceBranch}\`）。`,
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
