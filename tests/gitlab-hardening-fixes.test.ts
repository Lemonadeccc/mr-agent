import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubReview } from "../src/integrations/github/github-review.ts";
import { handlePlainGitHubWebhook } from "../src/integrations/github/github-webhook.ts";
import {
  mergeGitLabChangelogContent,
  parseGitLabReviewPolicyConfig,
  runGitLabReview,
  runGitLabWebhook,
  tryAddGitLabMergeRequestLabels,
} from "../src/integrations/gitlab/gitlab-review.ts";

test("gitlab policy parser accepts quoted mode/boolean values", () => {
  const policy = parseGitLabReviewPolicyConfig(
    [
      "review:",
      '  mode: "comment"',
      "  ask_command_enabled: 'off'",
    ].join("\n"),
  );

  assert.equal(policy.mode, "comment");
  assert.equal(policy.askCommandEnabled, false);
});

test("gitlab ask-disabled command should not load MR changes context", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  process.env.GITLAB_HTTP_RETRIES = "0";

  let changesCalled = false;
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("/repository/files/") && url.includes("/raw?ref=main")) {
      return new Response("review:\n  askCommandEnabled: false\n", { status: 200 });
    }

    if (url.includes("/merge_requests/12/changes")) {
      changesCalled = true;
      return new Response("changes endpoint should not be called", { status: 500 });
    }

    if (url.includes("/merge_requests/12/notes")) {
      return new Response("{}", { status: 201 });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const result = await runGitLabWebhook({
      payload: {
        object_kind: "note",
        project: {
          id: 1,
          name: "demo",
          web_url: "https://gitlab.example.com/acme/demo",
        },
        object_attributes: {
          action: "create",
          note: "/ask 为什么?",
          noteable_type: "MergeRequest",
          url: "https://gitlab.example.com/acme/demo/-/merge_requests/12#note_1",
        },
        merge_request: {
          iid: 12,
          title: "feat: add endpoint",
          source_branch: "feat/x",
          target_branch: "main",
          url: "https://gitlab.example.com/acme/demo/-/merge_requests/12",
        },
        user: {
          username: "alice",
        },
      },
      headers: {
        "x-gitlab-api-token": "token",
      },
      logger: {
        info: () => undefined,
        error: () => undefined,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.message, "ask command ignored by policy");
    assert.equal(changesCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
  }
});

test("gitlab changelog merge is idempotent for the same merge request title", () => {
  const once = mergeGitLabChangelogContent("", "- Added feature", "MR !12");
  const twice = mergeGitLabChangelogContent(once, "- Added feature", "MR !12");

  assert.equal(twice, once);
});

test("gitlab auto-label helper logs error when labels API returns non-2xx", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  process.env.GITLAB_HTTP_RETRIES = "0";

  let errorCalls = 0;
  globalThis.fetch = async () => new Response("server-error", { status: 500 });

  try {
    await tryAddGitLabMergeRequestLabels({
      gitlabToken: "token",
      collected: {
        baseUrl: "https://gitlab.example.com",
        projectId: 1,
        mrId: 12,
      } as never,
      labels: ["security"],
      logger: {
        info: () => undefined,
        error: () => {
          errorCalls += 1;
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
  }

  assert.equal(errorCalls, 1);
});

test("github failure notification uses sanitized public error message", async () => {
  const originalFetch = globalThis.fetch;
  const originalPushUrl = process.env.GITHUB_PUSH_URL;
  process.env.GITHUB_PUSH_URL = "https://notify.example.com/hook";

  let notified = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://notify.example.com/hook") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        markdown?: { content?: string };
      };
      notified = payload.markdown?.content ?? "";
      return new Response("{}", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    await runGitHubReview({
      context: {
        repo: () => ({ owner: "acme", repo: "demo" }),
        log: {
          info: () => undefined,
          error: () => undefined,
        },
        octokit: {
          pulls: {
            get: async () => {
              throw new Error("upstream failure: sk-test-secret");
            },
          },
          issues: {
            createComment: async () => ({ data: { id: 1 } }),
            updateComment: async () => ({}),
          },
        },
      } as never,
      pullNumber: 901,
      mode: "report",
      trigger: "comment-command",
      throwOnError: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITHUB_PUSH_URL = originalPushUrl;
  }

  assert.equal(notified.includes("sk-test-secret"), false);
});

test("gitlab failure notification uses sanitized public error message", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  process.env.GITLAB_HTTP_RETRIES = "0";

  let notified = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/merge_requests/77/changes")) {
      return new Response("remote failure: sk-gitlab-secret", { status: 500 });
    }
    if (url === "https://notify.example.com/hook") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        markdown?: { content?: string };
      };
      notified = payload.markdown?.content ?? "";
      return new Response("{}", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await runGitLabReview({
      payload: {
        object_kind: "merge_request",
        project: {
          id: 1,
          name: "demo",
          web_url: "https://gitlab.example.com/acme/demo",
          path_with_namespace: "acme/demo",
        },
        object_attributes: {
          action: "update",
          iid: 77,
          url: "https://gitlab.example.com/acme/demo/-/merge_requests/77",
          title: "feat: demo",
          source_branch: "feat/x",
          target_branch: "main",
        },
        user: {
          username: "alice",
        },
      },
      headers: {
        "x-gitlab-api-token": "token",
        "x-push-url": "https://notify.example.com/hook",
      },
      logger: {
        info: () => undefined,
        error: () => undefined,
      },
      throwOnError: false,
    });

    assert.equal(result.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
  }

  assert.equal(notified.includes("sk-gitlab-secret"), false);
});

test("plain github webhook forbids signature-skip mode in production", async () => {
  const originalSkip = process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalToken = process.env.GITHUB_WEBHOOK_TOKEN;
  process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = "true";
  process.env.NODE_ENV = "production";
  process.env.GITHUB_WEBHOOK_TOKEN = "token";

  try {
    await assert.rejects(
      handlePlainGitHubWebhook({
        payload: {},
        rawBody: "{}",
        headers: {
          "x-github-event": "issues",
        },
        logger: {
          info: () => undefined,
          error: () => undefined,
        },
      }),
      /GITHUB_WEBHOOK_SKIP_SIGNATURE.*production/i,
    );
  } finally {
    process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE = originalSkip;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.GITHUB_WEBHOOK_TOKEN = originalToken;
  }
});

test("gitlab webhook rejects insecure http base url by default", async () => {
  const originalBaseUrl = process.env.GITLAB_BASE_URL;
  const originalAllowInsecure = process.env.ALLOW_INSECURE_GITLAB_HTTP;
  process.env.GITLAB_BASE_URL = "http://gitlab.example.com";
  delete process.env.ALLOW_INSECURE_GITLAB_HTTP;

  try {
    await assert.rejects(
      runGitLabWebhook({
        payload: {
          object_kind: "merge_request",
          project: {
            id: 1,
            name: "demo",
            web_url: "https://gitlab.example.com/acme/demo",
          },
          object_attributes: {
            action: "update",
            iid: 12,
            source_branch: "feat/x",
            target_branch: "main",
          },
          user: {
            username: "alice",
          },
        },
        headers: {
          "x-gitlab-api-token": "token",
        },
        logger: {
          info: () => undefined,
          error: () => undefined,
        },
      }),
      /insecure.*http.*gitlab/i,
    );
  } finally {
    process.env.GITLAB_BASE_URL = originalBaseUrl;
    process.env.ALLOW_INSECURE_GITLAB_HTTP = originalAllowInsecure;
  }
});
