import assert from "node:assert/strict";
import test from "node:test";

import { handleGitHubIssueCommentCommand } from "../src/integrations/github/github-webhook.ts";

test("github /similar_issue command posts ranked similar issues", async () => {
  let postedBody = "";
  const result = await handleGitHubIssueCommentCommand({
    context: {
      repo: () => ({ owner: "acme", repo: "demo" }),
      log: {
        info: () => undefined,
        error: () => undefined,
      },
      octokit: {
        pulls: {
          get: async () => ({
            data: {
              title: "feat: auth token refresh timeout",
              body: "",
              user: { login: "alice" },
              base: { ref: "main", sha: "base" },
              head: { ref: "feat/x", sha: "head" },
              additions: 1,
              deletions: 1,
              changed_files: 1,
              html_url: "https://github.com/acme/demo/pull/12",
            },
          }),
          listFiles: async () => ({ data: [] }),
          createReviewComment: async () => ({}),
          update: async () => ({}),
        },
        repos: {
          getContent: async () => ({
            data: {
              type: "file",
              path: ".mr-agent.yml",
              encoding: "utf-8",
              content: "review:\n  askCommandEnabled: true\n",
            },
          }),
        },
        issues: {
          listForRepo: async () => ({
            data: [
              {
                number: 101,
                title: "auth token refresh timeout",
                body: "gateway refresh timeout",
                state: "open",
                html_url: "https://github.com/acme/demo/issues/101",
              },
              {
                number: 102,
                title: "docs update",
                body: "unrelated",
                state: "closed",
                html_url: "https://github.com/acme/demo/issues/102",
              },
            ],
          }),
          createComment: async (params) => {
            postedBody = params.body;
            return { data: { id: 1 } };
          },
          updateComment: async () => ({}),
        },
        paginate: async () => [],
      },
    } as never,
    owner: "acme",
    repo: "demo",
    issueNumber: 12,
    body: "/similar_issue auth token refresh",
    rateLimitPlatform: "github-webhook",
    throwOnError: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, "similar_issue command triggered");
  assert.match(postedBody, /AI Similar Issue Finder/);
  assert.match(postedBody, /issues\/101/);
});
