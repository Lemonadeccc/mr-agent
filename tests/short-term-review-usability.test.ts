import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearGitHubFeedbackSignalCacheForTests,
  __readGitHubFeedbackSignalsForTests,
  appendGitHubFilesTruncatedWarning,
  maybeAppendGitHubFilesTruncatedWarning,
  buildManagedCommandCommentKey,
  buildGitHubChangelogQuestion,
  isLikelyPlaceholder,
  buildGitHubDescribeQuestion,
  mergeChangelogContent,
  postGitHubCommandComment,
  publishGitHubNoDiffStatus,
  recordGitHubFeedbackSignal,
  resolveGitHubPatchCharLimits,
  runGitHubReview,
  shouldSkipGitHubReviewForDraft,
  upsertGitHubManagedIssueComment,
} from "../src/integrations/github/github-review.ts";
import {
  createRestBackedOctokit,
  handleGitHubIssueCommentCommand,
  handlePlainGitHubWebhook,
  isGitHubBotCommentUser,
  isGitHubCommandRateLimited,
  isWebhookSignatureValid,
} from "../src/integrations/github/github-webhook.ts";
import {
  GitlabWebhookService,
  isGitLabWebhookTokenValid,
  shouldRequireGitLabWebhookSecret,
} from "../src/modules/gitlab/gitlab.webhook.service.ts";
import {
  buildGitLabManagedCommandCommentKey,
  buildGitLabChangelogQuestion,
  buildGitLabDescribeQuestion,
  isGitLabBotUserName,
  runGitLabWebhook,
  runGitLabReview,
  resolveGitLabPatchCharLimits,
  shouldSkipGitLabReviewForDraft,
  upsertGitLabManagedComment,
} from "../src/integrations/gitlab/gitlab-review.ts";
import {
  __clearOpenAIClientCacheForTests,
  buildAskPrompt,
  buildUserPrompt,
  getOpenAIClientFromCache,
  normalizeAskResultForSchema,
  normalizeReviewResultForSchema,
  openAIClientCacheKey,
  buildGeminiGenerationConfig,
  isModelResponseNotJsonError,
  parseAnthropicJsonPayload,
  shouldFallbackToJsonObject,
  shouldRetryAnthropicWithoutTools,
  shouldRetryGeminiWithoutSchema,
} from "../src/review/ai-reviewer.ts";
import {
  __clearRateLimitStateForTests,
  __getRateLimitRecordCountForTests,
  isRateLimited,
} from "../src/core/rate-limit.ts";
import {
  __clearAskConversationCacheForTests,
  loadAskConversationTurns,
  rememberAskConversationTurn,
} from "../src/core/ask-session.ts";
import { resolveUiLocale } from "../src/core/i18n.ts";
import {
  buildIssueCommentMarkdown,
  buildReportCommentMarkdown,
} from "../src/review/report-renderer.ts";

test("github no-diff status updates progress comment only when progressCommentId is present", async () => {
  let createCalls = 0;
  let updateCalls = 0;

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      issues: {
        createComment: async () => {
          createCalls += 1;
          return { data: { id: 1 } };
        },
        updateComment: async () => {
          updateCalls += 1;
          return {};
        },
      },
    },
  };

  await publishGitHubNoDiffStatus({
    context: context as never,
    owner: "acme",
    repo: "demo",
    pullNumber: 12,
    progressCommentId: 99,
    markerKey: "review-no-diff",
  });

  assert.equal(updateCalls, 1);
  assert.equal(createCalls, 0);
});

test("github no-diff status keeps progress comment updated when custom warning body is provided", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  let updatedBody = "";

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      issues: {
        createComment: async () => {
          createCalls += 1;
          return { data: { id: 1 } };
        },
        updateComment: async (params: { body: string }) => {
          updateCalls += 1;
          updatedBody = params.body;
          return {};
        },
      },
    },
  };

  await publishGitHubNoDiffStatus({
    context: context as never,
    owner: "acme",
    repo: "demo",
    pullNumber: 12,
    progressCommentId: 99,
    markerKey: "review-no-diff",
    body: "`AI Review` 未发现可评审的文本改动。\n\n⚠️ 结果可能不完整。",
  });

  assert.equal(updateCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(
    updatedBody,
    "`AI Review` 未发现可评审的文本改动。\n\n⚠️ 结果可能不完整。\n\n<!-- mr-agent:review-no-diff -->",
  );
});

test("github managed review comment updates existing marker comment", async () => {
  let createCalls = 0;
  let updateCalls = 0;

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      issues: {
        listComments: async () => ({
          data: [
            {
              id: 321,
              body: "existing\n\n<!-- mr-agent:review-report -->",
            },
          ],
        }),
        createComment: async () => {
          createCalls += 1;
          return { data: { id: 2 } };
        },
        updateComment: async () => {
          updateCalls += 1;
          return {};
        },
      },
    },
  };

  await upsertGitHubManagedIssueComment({
    context: context as never,
    owner: "acme",
    repo: "demo",
    issueNumber: 12,
    markerKey: "review-report",
    body: "new body",
  });

  assert.equal(updateCalls, 1);
  assert.equal(createCalls, 0);
});

test("github managed review comment scans multiple pages before creating", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  const listedPages: number[] = [];

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      issues: {
        listComments: async (params: { page?: number }) => {
          const page = Number(params.page ?? 1);
          listedPages.push(page);
          if (page === 1) {
            return {
              data: Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                body: `noise-${index + 1}`,
              })),
            };
          }
          if (page === 2) {
            return {
              data: [
                {
                  id: 999,
                  body: "existing\n\n<!-- mr-agent:review-report -->",
                },
              ],
            };
          }
          return { data: [] };
        },
        createComment: async () => {
          createCalls += 1;
          return { data: { id: 2 } };
        },
        updateComment: async () => {
          updateCalls += 1;
          return {};
        },
      },
    },
  };

  await upsertGitHubManagedIssueComment({
    context: context as never,
    owner: "acme",
    repo: "demo",
    issueNumber: 12,
    markerKey: "review-report",
    body: "new body",
  });

  assert.deepEqual(listedPages, [1, 2]);
  assert.equal(updateCalls, 1);
  assert.equal(createCalls, 0);
});

test("draft auto-review skip only applies to auto triggers", () => {
  assert.equal(shouldSkipGitHubReviewForDraft("pr-opened", true), true);
  assert.equal(shouldSkipGitHubReviewForDraft("pr-edited", true), true);
  assert.equal(shouldSkipGitHubReviewForDraft("pr-synchronize", true), true);
  assert.equal(shouldSkipGitHubReviewForDraft("comment-command", true), false);
  assert.equal(shouldSkipGitHubReviewForDraft("pr-opened", false), false);

  assert.equal(shouldSkipGitLabReviewForDraft("pr-opened", true), true);
  assert.equal(shouldSkipGitLabReviewForDraft("comment-command", true), false);
  assert.equal(shouldSkipGitLabReviewForDraft("pr-synchronize", false), false);
});

test("openai client cache reuses instance for same config", () => {
  const a = getOpenAIClientFromCache({
    apiKey: "k1",
    baseURL: "https://example-openai.local",
    timeout: 10_000,
    maxRetries: 2,
  });
  const b = getOpenAIClientFromCache({
    apiKey: "k1",
    baseURL: "https://example-openai.local",
    timeout: 10_000,
    maxRetries: 2,
  });
  const c = getOpenAIClientFromCache({
    apiKey: "k2",
    baseURL: "https://example-openai.local",
    timeout: 10_000,
    maxRetries: 2,
  });

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("openai client cache key does not expose raw api key", () => {
  const key = openAIClientCacheKey({
    apiKey: "sk-secret-key-value",
    baseURL: "https://example-openai.local",
    timeout: 10_000,
    maxRetries: 2,
  });

  assert.equal(key.includes("sk-secret-key-value"), false);
  assert.match(key, /^[0-9a-f]{64}\|/);
});

test("openai client cache evicts oldest entry when exceeding max size", () => {
  const originalLimit = process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES;
  process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES = "2";
  __clearOpenAIClientCacheForTests();

  try {
    const first = getOpenAIClientFromCache({
      apiKey: "k1",
      baseURL: "https://example-openai.local",
      timeout: 10_000,
      maxRetries: 2,
    });
    const second = getOpenAIClientFromCache({
      apiKey: "k2",
      baseURL: "https://example-openai.local",
      timeout: 10_000,
      maxRetries: 2,
    });
    getOpenAIClientFromCache({
      apiKey: "k3",
      baseURL: "https://example-openai.local",
      timeout: 10_000,
      maxRetries: 2,
    });

    const secondStillCached = getOpenAIClientFromCache({
      apiKey: "k2",
      baseURL: "https://example-openai.local",
      timeout: 10_000,
      maxRetries: 2,
    });
    const firstAfterEviction = getOpenAIClientFromCache({
      apiKey: "k1",
      baseURL: "https://example-openai.local",
      timeout: 10_000,
      maxRetries: 2,
    });

    assert.equal(second, secondStillCached);
    assert.notEqual(first, firstAfterEviction);
  } finally {
    process.env.MAX_OPENAI_CLIENT_CACHE_ENTRIES = originalLimit;
    __clearOpenAIClientCacheForTests();
  }
});

test("openai-compatible fallback only for unsupported json_schema style 400 errors", () => {
  assert.equal(
    shouldFallbackToJsonObject({
      status: 400,
      error: {
        message: "response_format type json_schema is not supported",
      },
    }),
    true,
  );

  assert.equal(
    shouldFallbackToJsonObject({
      status: 400,
      error: {
        message: "Unsupported response_format=json_schema for this model",
      },
    }),
    true,
  );

  assert.equal(
    shouldFallbackToJsonObject({
      status: 400,
      error: {
        message: "不合法的response_format",
      },
    }),
    true,
  );
});

test("openai-compatible fallback does not swallow auth/rate-limit/network errors", () => {
  assert.equal(
    shouldFallbackToJsonObject({
      status: 401,
      error: { message: "invalid api key" },
    }),
    false,
  );
  assert.equal(
    shouldFallbackToJsonObject({
      status: 429,
      error: { message: "rate limit exceeded" },
    }),
    false,
  );
  assert.equal(
    shouldFallbackToJsonObject(new Error("connect ETIMEDOUT 1.2.3.4:443")),
    false,
  );
  assert.equal(
    shouldFallbackToJsonObject({
      status: 400,
      error: { message: "invalid_request_error: unrelated bad request" },
    }),
    false,
  );
});

test("model-response parse error detector only matches local parse errors", () => {
  assert.equal(
    isModelResponseNotJsonError(new Error("Model response is not valid JSON")),
    true,
  );
  assert.equal(
    isModelResponseNotJsonError(new Error("Model returned empty text")),
    true,
  );
  assert.equal(
    isModelResponseNotJsonError(new Error("401 invalid api key")),
    false,
  );
});

test("review result normalizer fills required fields when model omits keys", () => {
  const normalized = normalizeReviewResultForSchema({
    reviews: [
      {
        severity: "high",
        newPath: "src/app.ts",
        oldPath: "src/app.ts",
        type: "new",
        startLine: 10,
        endLine: 10,
        issueHeader: "Null check",
        issueContent: "Add a null guard before dereference.",
      },
    ],
  });

  assert.equal(typeof normalized.summary, "string");
  assert.equal(normalized.summary.length > 0, true);
  assert.equal(normalized.riskLevel, "high");
  assert.deepEqual(normalized.positives, []);
  assert.deepEqual(normalized.actionItems, []);
  assert.equal(normalized.reviews.length, 1);
});

test("ask result normalizer returns fallback answer when model omits answer key", () => {
  const normalized = normalizeAskResultForSchema({
    note: "missing answer",
  });

  assert.equal(typeof normalized.answer, "string");
  assert.equal(normalized.answer.length > 0, true);
});

test("managed command comment key is deterministic and seed-sensitive", () => {
  const g1 = buildManagedCommandCommentKey("ask", "How to fix flaky test?");
  const g2 = buildManagedCommandCommentKey("ask", "How to fix flaky test?");
  const g3 = buildManagedCommandCommentKey("ask", "How to fix timeout?");
  assert.equal(g1, g2);
  assert.notEqual(g1, g3);

  const l1 = buildGitLabManagedCommandCommentKey("ask", "How to fix flaky test?");
  const l2 = buildGitLabManagedCommandCommentKey("ask", "How to fix flaky test?");
  const l3 = buildGitLabManagedCommandCommentKey("ask", "How to fix timeout?");
  assert.equal(l1, l2);
  assert.notEqual(l1, l3);
});

test("github command comment helper uses managed upsert when key exists", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      issues: {
        listComments: async () => ({
          data: [
            {
              id: 777,
              body: "old body\n\n<!-- mr-agent:cmd-ask:abcd -->",
            },
          ],
        }),
        createComment: async () => {
          createCalls += 1;
          return { data: { id: 101 } };
        },
        updateComment: async () => {
          updateCalls += 1;
          return {};
        },
      },
    },
  };

  await postGitHubCommandComment({
    context: context as never,
    owner: "acme",
    repo: "demo",
    issueNumber: 12,
    body: "next answer",
    managedCommentKey: "cmd-ask:abcd",
  });

  assert.equal(updateCalls, 1);
  assert.equal(createCalls, 0);
});

test("bot comment user detection supports both user.type and [bot] login suffix", () => {
  assert.equal(isGitHubBotCommentUser({ type: "Bot", login: "mr-agent[bot]" }), true);
  assert.equal(isGitHubBotCommentUser({ type: "User", login: "github-actions[bot]" }), true);
  assert.equal(isGitHubBotCommentUser({ type: "User", login: "alice" }), false);
  assert.equal(isGitHubBotCommentUser(undefined), false);
});

test("gitlab bot user detection supports common bot username patterns", () => {
  assert.equal(isGitLabBotUserName("mr-agent[bot]"), true);
  assert.equal(isGitLabBotUserName("project_123_bot"), true);
  assert.equal(isGitLabBotUserName("gitlab-bot"), true);
  assert.equal(isGitLabBotUserName("gitlab_ci_bot"), true);
  assert.equal(isGitLabBotUserName("alice"), false);
  assert.equal(isGitLabBotUserName(undefined), false);
});

test("gitlab note webhook ignores bot user comments before command handling", async () => {
  const result = await runGitLabWebhook({
    payload: {
      object_kind: "note",
      project: {
        id: 1,
        name: "demo",
        web_url: "https://gitlab.example.com/acme/demo",
      },
      user: {
        username: "project_123_bot",
      },
      object_attributes: {
        action: "create",
        noteable_type: "MergeRequest",
        note: "/ask should be ignored",
      },
    } as never,
    headers: {},
    logger: {
      info: () => undefined,
      error: () => undefined,
    },
  });

  assert.deepEqual(result, { ok: true, message: "ignored note from bot user" });
});

test("gitlab pr-edited skips review when head sha is unchanged after dedupe ttl", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;

  let changesCalls = 0;
  const allRequests: string[] = [];

  globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    allRequests.push(`${method} ${url}`);

    if (url.includes("/merge_requests/12/changes")) {
      changesCalls += 1;
      return new Response(
        JSON.stringify({
          changes: [],
          diff_refs: {
            base_sha: "base-sha",
            head_sha: "same-head-sha",
            start_sha: "start-sha",
          },
        }),
        { status: 200 },
      );
    }

    if (url.includes("/merge_requests/12/notes?per_page=100&page=1")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    if (url.endsWith("/merge_requests/12/notes") && method === "POST") {
      return new Response("{}", { status: 201 });
    }

    return new Response("not found", { status: 404 });
  };

  const payload = {
    object_kind: "merge_request",
    project: {
      id: 1,
      name: "demo",
      web_url: "https://gitlab.example.com/acme/demo",
      path_with_namespace: "acme/demo",
    },
    user: {
      username: "alice",
    },
    object_attributes: {
      action: "update",
      iid: 12,
      url: "https://gitlab.example.com/acme/demo/-/merge_requests/12",
      title: "title",
      source_branch: "feat",
      target_branch: "main",
      last_commit: {
        id: "same-head-sha",
      },
    },
  };

  try {
    await runGitLabReview({
      payload: payload as never,
      headers: { "x-gitlab-api-token": "token" },
      logger: {
        info: () => undefined,
        error: () => undefined,
      },
      mode: "report",
      trigger: "pr-edited",
      dedupeSuffix: "same-head-sha",
      includeCiChecks: false,
      enableSecretScan: false,
      enableAutoLabel: false,
      throwOnError: true,
    });

    now += 5 * 60 * 1_000 + 1;

    await runGitLabReview({
      payload: payload as never,
      headers: { "x-gitlab-api-token": "token" },
      logger: {
        info: () => undefined,
        error: () => undefined,
      },
      mode: "report",
      trigger: "pr-edited",
      dedupeSuffix: "same-head-sha",
      includeCiChecks: false,
      enableSecretScan: false,
      enableAutoLabel: false,
      throwOnError: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }

  assert.equal(changesCalls, 1);
  assert.equal(
    allRequests.filter((line) => line.includes("/merge_requests/12/changes")).length,
    1,
  );
});

test("shared issue_comment command handler ignores bot users", async () => {
  let createCalls = 0;
  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      issues: {
        createComment: async () => {
          createCalls += 1;
          return { data: { id: 1 } };
        },
        updateComment: async () => ({}),
      },
      pulls: {
        get: async () => ({
          data: {
            title: "x",
            body: "",
            user: { login: "a" },
            base: { ref: "main", sha: "b" },
            head: { ref: "feat", sha: "h" },
            additions: 1,
            deletions: 1,
            changed_files: 1,
            html_url: "",
          },
        }),
        listFiles: async () => ({ data: [] }),
        createReviewComment: async () => ({}),
        update: async () => ({}),
      },
      repos: {
        getContent: async () => ({ data: [] }),
      },
      paginate: async () => [],
      __getLastListFilesTruncated: () => false,
    },
  };

  const result = await handleGitHubIssueCommentCommand({
    context: context as never,
    owner: "acme",
    repo: "demo",
    issueNumber: 7,
    body: "/ai-review report",
    commentUser: { type: "Bot", login: "mr-agent[bot]" },
    rateLimitPlatform: "github-app",
    throwOnError: true,
  });

  assert.deepEqual(result, { ok: true, message: "ignored issue_comment from bot" });
  assert.equal(createCalls, 0);
});

test("github auto review reuses preloaded pull metadata and avoids duplicate pulls.get", async () => {
  let pullGetCalls = 0;

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      error: () => undefined,
    },
    octokit: {
      repos: {
        getContent: async () => ({ data: [] }),
      },
      pulls: {
        get: async () => {
          pullGetCalls += 1;
          return {
            data: {
              title: "feat: sample",
              body: "desc",
              user: { login: "alice" },
              draft: false,
              base: { ref: "main", sha: "base-sha" },
              head: { ref: "feat", sha: "head-sha" },
              additions: 1,
              deletions: 1,
              changed_files: 1,
              html_url: "https://github.com/acme/demo/pull/12",
            },
          };
        },
        listFiles: async () => ({ data: [] }),
        createReviewComment: async () => ({}),
        update: async () => ({}),
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: { id: 1 } }),
        updateComment: async () => ({}),
      },
      paginate: async () => [],
      __getLastListFilesTruncated: () => false,
    },
  };

  await runGitHubReview({
    context: context as never,
    pullNumber: 12,
    mode: "report",
    trigger: "pr-opened",
    throwOnError: true,
    includeCiChecks: false,
    enableSecretScan: false,
    enableAutoLabel: false,
  });

  assert.equal(pullGetCalls, 1);
});

test("github pr-edited skips review when head sha is unchanged after dedupe ttl", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  let pullGetCalls = 0;
  let paginateCalls = 0;

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      error: () => undefined,
    },
    octokit: {
      repos: {
        getContent: async () => ({ data: [] }),
      },
      pulls: {
        get: async () => {
          pullGetCalls += 1;
          return {
            data: {
              title: "chore: metadata update",
              body: "desc",
              user: { login: "alice" },
              draft: false,
              base: { ref: "main", sha: "base-sha" },
              head: { ref: "feat", sha: "same-head-sha" },
              additions: 0,
              deletions: 0,
              changed_files: 0,
              html_url: "https://github.com/acme/demo/pull/12",
            },
          };
        },
        listFiles: async () => ({ data: [] }),
        createReviewComment: async () => ({}),
        update: async () => ({}),
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: { id: 1 } }),
        updateComment: async () => ({}),
      },
      paginate: async () => {
        paginateCalls += 1;
        return [];
      },
      __getLastListFilesTruncated: () => false,
    },
  };

  try {
    await runGitHubReview({
      context: context as never,
      pullNumber: 12,
      mode: "report",
      trigger: "pr-edited",
      dedupeSuffix: "same-head-sha",
      throwOnError: true,
      includeCiChecks: false,
      enableSecretScan: false,
      enableAutoLabel: false,
    });

    // Beyond default 5-minute dedupe ttl.
    now += 5 * 60 * 1_000 + 1;

    await runGitHubReview({
      context: context as never,
      pullNumber: 12,
      mode: "report",
      trigger: "pr-edited",
      dedupeSuffix: "same-head-sha",
      throwOnError: true,
      includeCiChecks: false,
      enableSecretScan: false,
      enableAutoLabel: false,
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(pullGetCalls, 2);
  assert.equal(paginateCalls, 1);
});

test("plain github webhook ignores bot issue_comment commands", async () => {
  const originalSkip = process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
  const originalToken = process.env.GITHUB_WEBHOOK_TOKEN;
  const originalMaxBody = process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES;
  process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = "true";
  process.env.GITHUB_WEBHOOK_TOKEN = "test-token";
  process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES = "1048576";

  try {
    const result = await handlePlainGitHubWebhook({
      payload: {
        action: "created",
        repository: {
          name: "demo",
          owner: { login: "acme" },
        },
        issue: {
          number: 42,
          pull_request: {},
        },
        comment: {
          body: "/ask should be ignored",
          user: { type: "Bot", login: "mr-agent[bot]" },
        },
      },
      rawBody: "{}",
      headers: {
        "x-github-event": "issue_comment",
      },
      logger: {
        info: () => undefined,
        error: () => undefined,
      },
    });

    assert.deepEqual(result, {
      ok: true,
      message: "ignored issue_comment from bot",
    });
  } finally {
    process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = originalSkip;
    process.env.GITHUB_WEBHOOK_TOKEN = originalToken;
    process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES = originalMaxBody;
  }
});

test("plain github webhook rejects oversized payload body", async () => {
  const originalSkip = process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
  const originalToken = process.env.GITHUB_WEBHOOK_TOKEN;
  const originalMaxBody = process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES;
  process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = "true";
  process.env.GITHUB_WEBHOOK_TOKEN = "test-token";
  process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES = "16";

  try {
    await assert.rejects(
      handlePlainGitHubWebhook({
        payload: {
          action: "created",
          repository: {
            name: "demo",
            owner: { login: "acme" },
          },
          issue: {
            number: 42,
            pull_request: {},
          },
          comment: {
            body: "/ai-review report",
            user: { type: "User", login: "alice" },
          },
        },
        rawBody: "x".repeat(17),
        headers: {
          "x-github-event": "issue_comment",
        },
        logger: {
          info: () => undefined,
          error: () => undefined,
        },
      }),
      /webhook payload too large/i,
    );
  } finally {
    process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = originalSkip;
    process.env.GITHUB_WEBHOOK_TOKEN = originalToken;
    process.env.GITHUB_WEBHOOK_MAX_BODY_BYTES = originalMaxBody;
  }
});

test("github command policy-disabled comment is localized in english", async () => {
  const originalLocale = process.env.MR_AGENT_LOCALE;
  process.env.MR_AGENT_LOCALE = "en";
  const yaml = ["review:", "  askCommandEnabled: false"].join("\n");
  const encoded = Buffer.from(yaml, "utf8").toString("base64");
  const postedBodies: string[] = [];

  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      repos: {
        getContent: async () => ({
          data: {
            type: "file",
            content: encoded,
            encoding: "base64",
          },
        }),
      },
      issues: {
        createComment: async (params: { body: string }) => {
          postedBodies.push(params.body);
          return { data: { id: postedBodies.length } };
        },
      },
    },
  };

  try {
    const result = await handleGitHubIssueCommentCommand({
      context: context as never,
      owner: "acme",
      repo: "demo",
      issueNumber: 12,
      body: "/ask why failed?",
      commentUser: { type: "User", login: "alice" },
      rateLimitPlatform: "github-webhook",
      throwOnError: true,
    });

    assert.equal(result.message, "ask command ignored by policy");
    assert.match(
      postedBodies[0] ?? "",
      /`\/ask` is disabled for this repository/i,
    );
  } finally {
    process.env.MR_AGENT_LOCALE = originalLocale;
  }
});

test("github command rate limit comment is localized in english", async () => {
  const originalLocale = process.env.MR_AGENT_LOCALE;
  const originalMax = process.env.COMMAND_RATE_LIMIT_MAX;
  const originalWindow = process.env.COMMAND_RATE_LIMIT_WINDOW_MS;
  process.env.MR_AGENT_LOCALE = "en";
  process.env.COMMAND_RATE_LIMIT_MAX = "1";
  process.env.COMMAND_RATE_LIMIT_WINDOW_MS = "3600000";
  __clearRateLimitStateForTests();

  const postedBodies: string[] = [];
  const context = {
    repo: () => ({ owner: "acme", repo: "demo" }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    octokit: {
      repos: {
        getContent: async () => {
          throw new Error("no policy file");
        },
      },
      issues: {
        createComment: async (params: { body: string }) => {
          postedBodies.push(params.body);
          return { data: { id: postedBodies.length } };
        },
      },
    },
  };

  try {
    await handleGitHubIssueCommentCommand({
      context: context as never,
      owner: "acme",
      repo: "demo",
      issueNumber: 12,
      body: "/feedback resolved",
      commentUser: { type: "User", login: "alice" },
      rateLimitPlatform: "github-webhook",
      throwOnError: true,
    });
    await handleGitHubIssueCommentCommand({
      context: context as never,
      owner: "acme",
      repo: "demo",
      issueNumber: 12,
      body: "/feedback resolved",
      commentUser: { type: "User", login: "alice" },
      rateLimitPlatform: "github-webhook",
      throwOnError: true,
    });

    const rateLimitBody = postedBodies[postedBodies.length - 1] ?? "";
    assert.match(
      rateLimitBody,
      /Command triggered too frequently\. Please retry later/i,
    );
  } finally {
    process.env.MR_AGENT_LOCALE = originalLocale;
    process.env.COMMAND_RATE_LIMIT_MAX = originalMax;
    process.env.COMMAND_RATE_LIMIT_WINDOW_MS = originalWindow;
    __clearRateLimitStateForTests();
  }
});

test("gitlab webhook service rejects oversized payload body", async () => {
  const originalMaxBody = process.env.GITLAB_WEBHOOK_MAX_BODY_BYTES;
  process.env.GITLAB_WEBHOOK_MAX_BODY_BYTES = "16";

  try {
    const service = new GitlabWebhookService();
    await assert.rejects(
      service.handleTrigger({
        payload: {
          object_kind: "note",
          event_type: "note",
          project: {
            id: 1,
            name: "demo",
            web_url: "https://gitlab.example.com/acme/demo",
          },
          object_attributes: {
            note: "x".repeat(64),
          },
        } as never,
        headers: {},
      }),
      /gitlab webhook payload too large/i,
    );
  } finally {
    process.env.GITLAB_WEBHOOK_MAX_BODY_BYTES = originalMaxBody;
  }
});

test("rate limiter blocks within window and resets outside window", () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  __clearRateLimitStateForTests();

  try {
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 2, 1_000), false);
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 2, 1_000), false);
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 2, 1_000), true);

    now += 1_001;
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 2, 1_000), false);
  } finally {
    Date.now = originalNow;
    __clearRateLimitStateForTests();
  }
});

test("rate limiter separates different keys", () => {
  __clearRateLimitStateForTests();
  try {
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 1, 60_000), false);
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 1, 60_000), true);

    assert.equal(isRateLimited("github:repo:1:user:b:cmd:ask", 1, 60_000), false);
    assert.equal(isRateLimited("github:repo:2:user:a:cmd:ask", 1, 60_000), false);
  } finally {
    __clearRateLimitStateForTests();
  }
});

test("rate limiter prunes stale keys after long idle period", () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  __clearRateLimitStateForTests();

  try {
    assert.equal(isRateLimited("github:repo:1:user:a:cmd:ask", 1, 1_000), false);
    assert.equal(__getRateLimitRecordCountForTests(), 1);

    now += 24 * 60 * 60 * 1_000 + 1;
    assert.equal(isRateLimited("github:repo:1:user:b:cmd:ask", 1, 1_000), false);
    assert.equal(__getRateLimitRecordCountForTests(), 1);
  } finally {
    Date.now = originalNow;
    __clearRateLimitStateForTests();
  }
});

test("github feedback signals are pr-scoped with repository fallback", () => {
  __clearGitHubFeedbackSignalCacheForTests();
  try {
    recordGitHubFeedbackSignal({
      owner: "acme",
      repo: "demo",
      signal: "repo-default",
    });
    recordGitHubFeedbackSignal({
      owner: "acme",
      repo: "demo",
      pullNumber: 101,
      signal: "pr-101-signal",
    });
    recordGitHubFeedbackSignal({
      owner: "acme",
      repo: "demo",
      pullNumber: 102,
      signal: "pr-102-signal",
    });

    assert.deepEqual(__readGitHubFeedbackSignalsForTests("acme", "demo", 101), [
      "pr-101-signal",
      "repo-default",
    ]);
    assert.deepEqual(__readGitHubFeedbackSignalsForTests("acme", "demo", 102), [
      "pr-102-signal",
      "repo-default",
    ]);
    assert.deepEqual(__readGitHubFeedbackSignalsForTests("acme", "demo", 999), [
      "repo-default",
    ]);
    assert.deepEqual(__readGitHubFeedbackSignalsForTests("acme", "demo"), [
      "repo-default",
    ]);
  } finally {
    __clearGitHubFeedbackSignalCacheForTests();
  }
});

test("github/gitlab patch char limits support env overrides with sane lower bounds", () => {
  const originalGithubPerFile = process.env.GITHUB_MAX_PATCH_CHARS_PER_FILE;
  const originalGithubTotal = process.env.GITHUB_MAX_TOTAL_PATCH_CHARS;
  const originalGitlabPerFile = process.env.GITLAB_MAX_PATCH_CHARS_PER_FILE;
  const originalGitlabTotal = process.env.GITLAB_MAX_TOTAL_PATCH_CHARS;

  try {
    process.env.GITHUB_MAX_PATCH_CHARS_PER_FILE = "128";
    process.env.GITHUB_MAX_TOTAL_PATCH_CHARS = "1024";
    process.env.GITLAB_MAX_PATCH_CHARS_PER_FILE = "256";
    process.env.GITLAB_MAX_TOTAL_PATCH_CHARS = "2048";

    assert.deepEqual(resolveGitHubPatchCharLimits(), {
      maxPatchCharsPerFile: 128,
      maxTotalPatchChars: 1024,
    });
    assert.deepEqual(resolveGitLabPatchCharLimits(), {
      maxPatchCharsPerFile: 256,
      maxTotalPatchChars: 2048,
    });

    process.env.GITHUB_MAX_PATCH_CHARS_PER_FILE = "0";
    process.env.GITHUB_MAX_TOTAL_PATCH_CHARS = "0";
    process.env.GITLAB_MAX_PATCH_CHARS_PER_FILE = "0";
    process.env.GITLAB_MAX_TOTAL_PATCH_CHARS = "0";

    assert.deepEqual(resolveGitHubPatchCharLimits(), {
      maxPatchCharsPerFile: 1,
      maxTotalPatchChars: 1,
    });
    assert.deepEqual(resolveGitLabPatchCharLimits(), {
      maxPatchCharsPerFile: 1,
      maxTotalPatchChars: 1,
    });
  } finally {
    process.env.GITHUB_MAX_PATCH_CHARS_PER_FILE = originalGithubPerFile;
    process.env.GITHUB_MAX_TOTAL_PATCH_CHARS = originalGithubTotal;
    process.env.GITLAB_MAX_PATCH_CHARS_PER_FILE = originalGitlabPerFile;
    process.env.GITLAB_MAX_TOTAL_PATCH_CHARS = originalGitlabTotal;
  }
});

test("github command rate limit key includes user/pr/command dimensions", () => {
  const originalMax = process.env.COMMAND_RATE_LIMIT_MAX;
  const originalWindow = process.env.COMMAND_RATE_LIMIT_WINDOW_MS;
  process.env.COMMAND_RATE_LIMIT_MAX = "1";
  process.env.COMMAND_RATE_LIMIT_WINDOW_MS = "3600000";
  __clearRateLimitStateForTests();

  try {
    assert.equal(
      isGitHubCommandRateLimited({
        platform: "github-webhook",
        owner: "acme",
        repo: "demo",
        pullNumber: 7,
        userLogin: "alice",
        command: "ask",
      }),
      false,
    );
    assert.equal(
      isGitHubCommandRateLimited({
        platform: "github-webhook",
        owner: "acme",
        repo: "demo",
        pullNumber: 7,
        userLogin: "alice",
        command: "ask",
      }),
      true,
    );
    assert.equal(
      isGitHubCommandRateLimited({
        platform: "github-webhook",
        owner: "acme",
        repo: "demo",
        pullNumber: 7,
        userLogin: "bob",
        command: "ask",
      }),
      false,
    );
    assert.equal(
      isGitHubCommandRateLimited({
        platform: "github-webhook",
        owner: "acme",
        repo: "demo",
        pullNumber: 8,
        userLogin: "alice",
        command: "ask",
      }),
      false,
    );
    assert.equal(
      isGitHubCommandRateLimited({
        platform: "github-webhook",
        owner: "acme",
        repo: "demo",
        pullNumber: 7,
        userLogin: "alice",
        command: "checks",
      }),
      false,
    );
  } finally {
    process.env.COMMAND_RATE_LIMIT_MAX = originalMax;
    process.env.COMMAND_RATE_LIMIT_WINDOW_MS = originalWindow;
    __clearRateLimitStateForTests();
  }
});

test("github pull files pagination marks truncated at 20 full pages and appends warning", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/files")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      requestedPages.push(page);

      const files = Array.from({ length: perPage }, (_, index) => ({
        filename: `src/file-${page}-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-a\n+b",
      }));
      return new Response(JSON.stringify(files), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const octokit = createRestBackedOctokit({
      token: "test-token",
      baseUrl: "https://api.github.com",
    });
    const files = await octokit.paginate(octokit.pulls.listFiles, {
      owner: "acme",
      repo: "demo",
      pull_number: 1,
      per_page: 100,
    });
    const truncated = octokit.__getLastListFilesTruncated?.() ?? false;

    assert.equal(requestedPages.length, 20);
    assert.equal(files.length, 2_000);
    assert.equal(truncated, true);

    const body = maybeAppendGitHubFilesTruncatedWarning("## report", truncated);
    assert.match(body, /2000/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mergeChangelogContent is idempotent for the same PR title", () => {
  const existing = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "### PR #123",
    "",
    "- Added API timeout guard",
    "",
    "## 1.0.0",
    "",
    "- Initial release",
    "",
  ].join("\n");

  const merged = mergeChangelogContent(existing, "- Added API timeout guard", "PR #123");
  const matches = merged.match(/### PR #123/g) ?? [];
  assert.equal(matches.length, 1);
});

test("placeholder detector catches common placeholder variants", () => {
  assert.equal(isLikelyPlaceholder("change_me"), true);
  assert.equal(isLikelyPlaceholder("your_api_key_here"), true);
  assert.equal(isLikelyPlaceholder("fill_in_your_token"), true);
  assert.equal(isLikelyPlaceholder("<your-token>"), true);
  assert.equal(isLikelyPlaceholder("xxx"), true);
  assert.equal(isLikelyPlaceholder("TODO: replace before release"), true);
  assert.equal(isLikelyPlaceholder("production-secret-abc123"), false);
});

test("webhook signature checker validates match and mismatch", () => {
  assert.equal(
    isWebhookSignatureValid("sha256=abcdef123456", "sha256=abcdef123456"),
    true,
  );
  assert.equal(
    isWebhookSignatureValid("sha256=abcdef123456", "sha256=abcdef123457"),
    false,
  );
  assert.equal(
    isWebhookSignatureValid("sha256=abcdef123456", "sha256=short"),
    false,
  );
});

test("gitlab webhook token checker validates match and mismatch", () => {
  assert.equal(isGitLabWebhookTokenValid("my-shared-secret", "my-shared-secret"), true);
  assert.equal(isGitLabWebhookTokenValid("my-shared-secret", "my-shared-secret-x"), false);
  assert.equal(isGitLabWebhookTokenValid("my-shared-secret", "short"), false);
});

test("gitlab webhook secret requirement flag parses common true/false env forms", () => {
  assert.equal(shouldRequireGitLabWebhookSecret("true"), true);
  assert.equal(shouldRequireGitLabWebhookSecret("TRUE"), true);
  assert.equal(shouldRequireGitLabWebhookSecret("1"), true);
  assert.equal(shouldRequireGitLabWebhookSecret("yes"), true);
  assert.equal(shouldRequireGitLabWebhookSecret("on"), true);

  assert.equal(shouldRequireGitLabWebhookSecret("false"), false);
  assert.equal(shouldRequireGitLabWebhookSecret("0"), false);
  assert.equal(shouldRequireGitLabWebhookSecret("no"), false);
  assert.equal(shouldRequireGitLabWebhookSecret("off"), false);
  assert.equal(shouldRequireGitLabWebhookSecret(""), false);
  assert.equal(shouldRequireGitLabWebhookSecret(undefined), false);
});

test("gemini generation config optionally includes responseSchema", () => {
  const withSchema = buildGeminiGenerationConfig({
    type: "object",
    properties: {
      answer: { type: "string" },
    },
  });
  assert.equal(withSchema.responseMimeType, "application/json");
  assert.deepEqual(withSchema.responseSchema, {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
  });

  const withoutSchema = buildGeminiGenerationConfig();
  assert.equal(withoutSchema.responseMimeType, "application/json");
  assert.equal("responseSchema" in withoutSchema, false);
});

test("gemini schema fallback only triggers for schema-related 400 responses", () => {
  assert.equal(
    shouldRetryGeminiWithoutSchema(
      400,
      "Invalid JSON payload received. Unknown name \"responseSchema\" at 'generation_config'",
    ),
    true,
  );
  assert.equal(
    shouldRetryGeminiWithoutSchema(
      400,
      "response_schema is not supported for this model",
    ),
    true,
  );
  assert.equal(
    shouldRetryGeminiWithoutSchema(401, "responseSchema not supported"),
    false,
  );
  assert.equal(
    shouldRetryGeminiWithoutSchema(400, "invalid API key"),
    false,
  );
});

test("anthropic tools fallback only triggers for tools-related 400 responses", () => {
  assert.equal(
    shouldRetryAnthropicWithoutTools(
      400,
      "invalid_request_error: tool_choice is not supported for this model",
    ),
    true,
  );
  assert.equal(
    shouldRetryAnthropicWithoutTools(
      400,
      "unknown parameter: tools[0].input_schema",
    ),
    true,
  );
  assert.equal(
    shouldRetryAnthropicWithoutTools(401, "tool_choice is not supported"),
    false,
  );
  assert.equal(
    shouldRetryAnthropicWithoutTools(400, "invalid API key"),
    false,
  );
});

test("anthropic payload parser prefers tool_use input over text", () => {
  const parsed = parseAnthropicJsonPayload({
    content: [
      {
        type: "text",
        text: "{\"answer\":\"from-text\"}",
      },
      {
        type: "tool_use",
        input: { answer: "from-tool" },
      },
    ],
  });
  assert.deepEqual(parsed, { answer: "from-tool" });
});

test("anthropic payload parser falls back to text json and errors on empty payload", () => {
  const parsed = parseAnthropicJsonPayload({
    content: [
      {
        type: "text",
        text: "{\"answer\":\"ok\"}",
      },
    ],
  });
  assert.deepEqual(parsed, { answer: "ok" });

  assert.throws(
    () => parseAnthropicJsonPayload({ content: [{ type: "text", text: "" }] }),
    /no text or tool_use/i,
  );
});

test("describe question template requests markdown-only PR draft with required sections", () => {
  const question = buildGitHubDescribeQuestion();
  assert.match(question, /markdown/i);
  assert.match(question, /## Summary/);
  assert.match(question, /## Change Overview/);
  assert.match(question, /## File Walkthrough/);
  assert.match(question, /## Test Plan/);
  assert.match(question, /## Related Issue/);
});

test("describe question template supports english locale for github", () => {
  const question = buildGitHubDescribeQuestion("en");
  assert.match(question, /Based on current PR changes/i);
  assert.match(question, /Output requirement: return Markdown body only/i);
  assert.match(question, /## Summary/);
  assert.match(question, /## Related Issue/);
});

test("gitlab describe question template requests markdown-only MR draft", () => {
  const question = buildGitLabDescribeQuestion();
  assert.match(question, /markdown/i);
  assert.match(question, /MR/i);
  assert.match(question, /## Summary/);
  assert.match(question, /## Change Overview/);
  assert.match(question, /## File Walkthrough/);
  assert.match(question, /## Test Plan/);
});

test("describe question template supports english locale for gitlab", () => {
  const question = buildGitLabDescribeQuestion("en");
  assert.match(question, /Based on current MR changes/i);
  assert.match(question, /Output requirement: return Markdown body only/i);
  assert.match(question, /## Summary/);
  assert.doesNotMatch(question, /## Related Issue/);
});

test("github changelog question template supports english locale and focus", () => {
  const withFocus = buildGitHubChangelogQuestion("database migration", "en");
  const withoutFocus = buildGitHubChangelogQuestion("", "en");
  assert.match(withFocus, /current PR changes/i);
  assert.match(withFocus, /database migration/);
  assert.match(withFocus, /Output only the changelog content body/i);
  assert.match(withoutFocus, /current PR changes/i);
});

test("gitlab changelog question template supports english locale and focus", () => {
  const withFocus = buildGitLabChangelogQuestion("pipeline stability", "en");
  const withoutFocus = buildGitLabChangelogQuestion(undefined, "en");
  assert.match(withFocus, /current MR changes/i);
  assert.match(withFocus, /pipeline stability/);
  assert.match(withFocus, /Output only the changelog content body/i);
  assert.match(withoutFocus, /current MR changes/i);
});

test("ask prompt keeps shared context and limits diff section to first 40 files", () => {
  const changedFiles = Array.from({ length: 45 }, (_, index) => ({
    newPath: `src/file-${index + 1}.ts`,
    oldPath: `src/file-${index + 1}.ts`,
    status: "modified",
    additions: 1,
    deletions: 1,
    extendedDiff: `@@ -1,1 +1,1 @@\n-old-${index + 1}\n+new-${index + 1}`,
  }));
  const prompt = buildAskPrompt(
    {
      platform: "github",
      repository: "acme/demo",
      number: 42,
      title: "Refactor prompt builder",
      body: "Body",
      author: "alice",
      baseBranch: "main",
      headBranch: "feat/refactor",
      additions: 45,
      deletions: 45,
      changedFilesCount: 45,
      changedFiles,
      customRules: ["avoid breaking changes"],
      feedbackSignals: ["prefer actionable suggestions"],
      ciChecks: [
        {
          name: "lint",
          status: "completed",
          conclusion: "failed",
          detailsUrl: "https://ci.example/lint",
          summary: "1 error",
        },
      ],
      processGuidelines: [
        {
          path: ".github/pull_request_template.md",
          content: "Template content",
        },
      ],
    },
    "  why this failed?  ",
  );

  assert.match(prompt, /### File 40/);
  assert.doesNotMatch(prompt, /### File 41/);
  assert.match(prompt, /CI checks on current head:/);
  assert.match(
    prompt,
    /- lint \(status=completed, conclusion=failed, url=https:\/\/ci\.example\/lint\)\n  summary=1 error/,
  );
  assert.match(prompt, /用户问题：\nwhy this failed\?/);
});

test("ask prompt includes previous q&a conversation context", () => {
  const prompt = buildAskPrompt(
    {
      platform: "github",
      repository: "acme/demo",
      number: 10,
      title: "Use conversation context",
      body: "Body",
      author: "alice",
      baseBranch: "main",
      headBranch: "feat/ask",
      additions: 1,
      deletions: 1,
      changedFilesCount: 1,
      changedFiles: [
        {
          newPath: "src/app.ts",
          oldPath: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          extendedDiff: "@@ -1 +1 @@\n-a\n+b",
        },
      ],
      customRules: [],
      feedbackSignals: [],
      ciChecks: [],
      processGuidelines: [],
    },
    "what changed?",
    [
      {
        question: "why was this needed?",
        answer: "to fix flaky tests",
      },
    ],
  );

  assert.match(prompt, /Previous Q&A context:/);
  assert.match(prompt, /### Turn 1/);
  assert.match(prompt, /Q: why was this needed\?/);
  assert.match(prompt, /A: to fix flaky tests/);
});

test("ask prompt excludes process/template section while review prompt includes it", () => {
  const input = {
    platform: "github" as const,
    repository: "acme/demo",
    number: 7,
    title: "Refactor prompt sections",
    body: "Body",
    author: "alice",
    baseBranch: "main",
    headBranch: "feat/prompts",
    additions: 1,
    deletions: 1,
    changedFilesCount: 1,
    changedFiles: [
      {
        newPath: ".github/workflows/review.yml",
        oldPath: ".github/workflows/review.yml",
        status: "modified",
        additions: 1,
        deletions: 1,
        extendedDiff: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    customRules: [],
    feedbackSignals: [],
    ciChecks: [],
    processGuidelines: [],
  };

  const askPrompt = buildAskPrompt(input, "what changed?");
  const reviewPrompt = buildUserPrompt(input);

  assert.doesNotMatch(askPrompt, /Process\/template files in this change:/);
  assert.match(reviewPrompt, /Process\/template files in this change:/);
});

test("ui locale resolver supports en variants and defaults to en", () => {
  assert.equal(resolveUiLocale("en"), "en");
  assert.equal(resolveUiLocale("EN-us"), "en");
  assert.equal(resolveUiLocale("english"), "en");
  assert.equal(resolveUiLocale("zh"), "zh");
  assert.equal(resolveUiLocale(undefined), "en");
  assert.equal(resolveUiLocale(""), "en");
});

test("github truncated warning supports english locale", () => {
  const body = appendGitHubFilesTruncatedWarning("## report", "en");
  assert.match(body, /File listing reached the hard limit/i);
  assert.match(body, /2000 files/i);
});

test("issue comment markdown localizes table headers and risk label in english", () => {
  const markdown = buildIssueCommentMarkdown(
    {
      newPath: "src/app.ts",
      oldPath: "src/app.ts",
      type: "new",
      severity: "high",
      startLine: 10,
      endLine: 12,
      issueHeader: "Null guard missing",
      issueContent: "Add a null guard before dereference.",
    },
    { platform: "github", locale: "en" },
  );

  assert.match(markdown, /<strong>Issue<\/strong>/);
  assert.match(markdown, /<strong>Description<\/strong>/);
  assert.match(markdown, /\[High\] Null guard missing/);
});

test("report markdown localizes section headers and risk label in english", () => {
  const markdown = buildReportCommentMarkdown(
    {
      summary: "This change is mostly safe.",
      riskLevel: "medium",
      positives: ["Improved validation coverage"],
      actionItems: ["Add one regression test"],
      reviews: [],
    },
    [],
    {
      platform: "github",
      owner: "acme",
      repo: "demo",
      baseSha: "base",
      headSha: "head",
    },
    { locale: "en" },
  );

  assert.match(markdown, /## AI Code Review Report/);
  assert.match(markdown, /Risk level: \*\*Medium\*\*/);
  assert.match(markdown, /### Summary/);
  assert.match(markdown, /### Findings/);
  assert.match(markdown, /No concrete issues found\./);
  assert.match(markdown, /### Positive Notes/);
  assert.match(markdown, /### Recommended Next Actions/);
});

test("ask conversation cache stores per-session turns and trims to max turns", () => {
  const originalMaxTurns = process.env.ASK_SESSION_MAX_TURNS;
  const originalTtl = process.env.ASK_SESSION_TTL_MS;
  process.env.ASK_SESSION_MAX_TURNS = "2";
  process.env.ASK_SESSION_TTL_MS = "60000";
  __clearAskConversationCacheForTests();

  try {
    rememberAskConversationTurn({
      sessionKey: "github:acme/demo#1",
      question: "q1",
      answer: "a1",
    });
    rememberAskConversationTurn({
      sessionKey: "github:acme/demo#1",
      question: "q2",
      answer: "a2",
    });
    rememberAskConversationTurn({
      sessionKey: "github:acme/demo#1",
      question: "q3",
      answer: "a3",
    });
    rememberAskConversationTurn({
      sessionKey: "github:acme/demo#2",
      question: "q-other",
      answer: "a-other",
    });

    assert.deepEqual(loadAskConversationTurns("github:acme/demo#1"), [
      { question: "q2", answer: "a2" },
      { question: "q3", answer: "a3" },
    ]);
    assert.deepEqual(loadAskConversationTurns("github:acme/demo#2"), [
      { question: "q-other", answer: "a-other" },
    ]);
  } finally {
    process.env.ASK_SESSION_MAX_TURNS = originalMaxTurns;
    process.env.ASK_SESSION_TTL_MS = originalTtl;
    __clearAskConversationCacheForTests();
  }
});

test("user prompt includes process file summary and full diff list", () => {
  const prompt = buildUserPrompt({
    platform: "github",
    repository: "acme/demo",
    number: 99,
    title: "Update workflow and code",
    body: "Body",
    author: "bob",
    baseBranch: "main",
    headBranch: "feat/workflow",
    additions: 3,
    deletions: 1,
    changedFilesCount: 2,
    changedFiles: [
      {
        newPath: ".github/workflows/ci.yml",
        oldPath: ".github/workflows/ci.yml",
        status: "modified",
        additions: 1,
        deletions: 0,
        extendedDiff: "@@ -1,1 +1,2 @@\n-name: CI\n+name: CI\n+on: [push]",
      },
      {
        newPath: "src/main.ts",
        oldPath: "src/main.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        extendedDiff: "@@ -1,2 +1,3 @@\n-old\n+new\n+more",
      },
    ],
    processGuidelines: [],
  });

  assert.match(prompt, /Process\/template files in this change:/);
  assert.match(prompt, /- \.github\/workflows\/ci\.yml \(status=modified\)/);
  assert.match(prompt, /### File 2/);
});

test("gitlab issue suggestion uses native suggestion block and escapes inner fences", () => {
  const markdown = buildIssueCommentMarkdown(
    {
      severity: "medium",
      newPath: "src/a.ts",
      oldPath: "src/a.ts",
      type: "new",
      startLine: 1,
      endLine: 1,
      issueHeader: "Use safer code",
      issueContent: "Please apply suggestion",
      suggestion: "```ts\nconst a = 1;\n```",
    },
    { platform: "gitlab" },
  );

  assert.match(markdown, /```suggestion/);
  assert.doesNotMatch(markdown, /\n```ts/);
});

test("gitlab managed comment scans multiple pages before updating existing marker note", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let createCalls = 0;

  globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    requests.push(`${method} ${url}`);

    if (url.includes("/notes?per_page=100&page=1")) {
      const data = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        body: `noise-${index + 1}`,
      }));
      return new Response(JSON.stringify(data), { status: 200 });
    }

    if (url.includes("/notes?per_page=100&page=2")) {
      const data = [
        {
          id: 777,
          body: "existing\n\n<!-- mr-agent:cmd-ask:abcd -->",
        },
      ];
      return new Response(JSON.stringify(data), { status: 200 });
    }

    if (url.endsWith("/notes/777") && method === "PUT") {
      return new Response("{}", { status: 200 });
    }

    if (url.endsWith("/notes") && method === "POST") {
      createCalls += 1;
      return new Response("{}", { status: 201 });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    await upsertGitLabManagedComment({
      gitlabToken: "token",
      target: {
        baseUrl: "https://gitlab.example.com",
        projectId: 123,
        mrId: 9,
      } as never,
      markerKey: "cmd-ask:abcd",
      body: "new body",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    requests.some((line) => line.includes("/notes?per_page=100&page=2")),
  );
  assert.ok(requests.some((line) => line.includes("PUT https://gitlab.example.com")));
  assert.equal(createCalls, 0);
});

test("gitlab managed comment logs and falls back to create on upsert failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  process.env.GITLAB_HTTP_RETRIES = "0";

  let createCalls = 0;
  let logErrorCalls = 0;

  globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);

    if (url.includes("/notes?per_page=100&page=1")) {
      throw new Error("network down");
    }
    if (url.endsWith("/notes") && method === "POST") {
      createCalls += 1;
      return new Response("{}", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    await upsertGitLabManagedComment({
      gitlabToken: "token",
      target: {
        baseUrl: "https://gitlab.example.com",
        projectId: 123,
        mrId: 9,
      } as never,
      markerKey: "cmd-ask:abcd",
      body: "new body",
      logger: {
        info: () => undefined,
        error: () => {
          logErrorCalls += 1;
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
  }

  assert.equal(logErrorCalls, 1);
  assert.equal(createCalls, 1);
});
