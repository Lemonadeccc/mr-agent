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
  buildIssueCommentMarkdown,
  buildReportCommentMarkdown,
  countPatchChanges,
  findFileForReview,
  GITLAB_GUIDELINE_DIRECTORIES,
  GITLAB_GUIDELINE_FILE_PATHS,
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
} from "#review";

const MAX_FILES = 40;
const MAX_PATCH_CHARS_PER_FILE = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
const DEFAULT_GUIDELINE_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_GUIDELINES = 20;
const MAX_GUIDELINES_PER_DIRECTORY = 8;
const MAX_GUIDELINE_CACHE_ENTRIES = 500;

type ProcessGuideline = { path: string; content: string };

type ProcessGuidelineCacheEntry = ExpiringCacheEntry<ProcessGuideline[]>;

const guidelineCache = new Map<string, ProcessGuidelineCacheEntry>();

interface LoggerLike {
  info(metadata: unknown, message: string): void;
  error(metadata: unknown, message: string): void;
}

export interface GitLabMrWebhookBody {
  object_kind?: string;
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
  };
}

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

export async function runGitLabReview(params: {
  payload: GitLabMrWebhookBody;
  headers: Record<string, string | undefined>;
  logger: LoggerLike;
}): Promise<{ ok: boolean; message: string }> {
  const { payload, headers, logger } = params;
  if (payload.object_kind && payload.object_kind !== "merge_request") {
    return { ok: true, message: `ignored object_kind=${payload.object_kind}` };
  }

  const action = payload.object_attributes.action?.toLowerCase();
  if (action === "close" || action === "closed") {
    return { ok: true, message: "ignored closed merge request event" };
  }

  const mode = parseMode(headers["x-ai-mode"]);
  const requestKey = `gitlab:${payload.object_attributes.url}:${mode}`;

  if (isDuplicateRequest(requestKey)) {
    return { ok: true, message: "duplicate request ignored" };
  }

  const gitlabToken = headers["x-gitlab-api-token"] ?? process.env.GITLAB_TOKEN;
  if (!gitlabToken) {
    clearDuplicateRecord(requestKey);
    throw new BadWebhookRequestError(
      "gitlab api token 不能为空（x-gitlab-api-token 或 GITLAB_TOKEN）",
    );
  }

  try {
    const collected = await collectGitLabMergeRequestContext({
      payload,
      gitlabToken,
      baseUrl: process.env.GITLAB_BASE_URL,
    });

    logger.info(
      {
        projectId: collected.projectId,
        mrId: collected.mrId,
        mode,
      },
      "Starting GitLab AI review",
    );

    const result = await analyzePullRequest(collected.input);
    if (mode === "comment") {
      await publishGitLabLineComments(gitlabToken, collected, result, logger);
    } else {
      const markdown = buildReportCommentMarkdown(result, collected.files, {
        platform: "gitlab",
        webUrl: collected.webUrl,
        sourceBranch: collected.sourceBranch,
        targetBranch: collected.targetBranch,
      });
      await publishGitLabGeneralComment(gitlabToken, collected, markdown);
    }

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

    throw originalError;
  }
}

async function collectGitLabMergeRequestContext(params: {
  payload: GitLabMrWebhookBody;
  gitlabToken: string;
  baseUrl?: string;
}): Promise<GitLabCollectedContext> {
  const { payload, gitlabToken } = params;
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
  const files: DiffFileContext[] = [];
  let totalPatchChars = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const change of changesResponse.changes) {
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
    changedFilesCount: changesResponse.changes.length,
    changedFiles: files.map((file) => ({
      newPath: file.newPath,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      extendedDiff: file.extendedDiff,
    })),
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

function parseMode(modeRaw: string | undefined): ReviewMode {
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
