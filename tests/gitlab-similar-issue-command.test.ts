import assert from "node:assert/strict";
import test from "node:test";

import { runGitLabWebhook } from "../src/integrations/gitlab/gitlab-review.ts";

test("gitlab /similar_issue command posts ranked similar issues", async () => {
  const originalFetch = globalThis.fetch;
  const originalRetries = process.env.GITLAB_HTTP_RETRIES;
  process.env.GITLAB_HTTP_RETRIES = "0";

  let noteBody = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/repository/files/") && url.includes("/raw?ref=main")) {
      return new Response("review:\n  askCommandEnabled: true\n", { status: 200 });
    }
    if (url.includes("/issues?state=all")) {
      return new Response(
        JSON.stringify([
          {
            iid: 201,
            title: "auth token refresh timeout",
            description: "gateway timeout on token refresh",
            state: "opened",
            web_url: "https://gitlab.example.com/acme/demo/-/issues/201",
          },
          {
            iid: 202,
            title: "update readme",
            description: "docs only",
            state: "closed",
            web_url: "https://gitlab.example.com/acme/demo/-/issues/202",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/merge_requests/12/notes")) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
      noteBody = payload.body ?? "";
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
          note: "/similar_issue auth token refresh",
          noteable_type: "MergeRequest",
          url: "https://gitlab.example.com/acme/demo/-/merge_requests/12#note_1",
        },
        merge_request: {
          iid: 12,
          title: "feat: add endpoint",
          description: "",
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
    assert.equal(result.message, "similar_issue command triggered");
    assert.match(noteBody, /AI Similar Issue Finder/);
    assert.match(noteBody, /issues\/201/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITLAB_HTTP_RETRIES = originalRetries;
  }
});
