import assert from "node:assert/strict";
import test from "node:test";

import { __clearDuplicateRequestStateForTests } from "../src/core/dedupe.ts";
import { runGitHubIssuePolicyCheck } from "../src/integrations/github/github-policy.ts";

test("github policy reminder uses english by default when locale is not configured", async () => {
  __clearDuplicateRequestStateForTests();
  const originalLocale = process.env.MR_AGENT_LOCALE;
  delete process.env.MR_AGENT_LOCALE;

  let commentBody = "";
  try {
    await runGitHubIssuePolicyCheck({
      context: {
        repo: () => ({ owner: "acme", repo: "demo" }),
        octokit: {
          repos: {
            getContent: async () => {
              throw new Error("not found");
            },
          },
          pulls: {
            get: async () => ({ data: {} as never }),
            listFiles: async () => ({ data: [] }),
            createReviewComment: async () => ({}),
            update: async () => ({}),
          },
          issues: {
            createComment: async (params) => {
              commentBody = params.body;
              return { data: { id: 1 } };
            },
          },
          paginate: async () => [],
        },
        log: {
          info: () => undefined,
          error: () => undefined,
        },
      },
      issueNumber: 1,
      title: "",
      body: "",
    });
  } finally {
    process.env.MR_AGENT_LOCALE = originalLocale;
  }

  assert.match(commentBody, /Issue title is required/i);
  assert.match(commentBody, /Issue body is required/i);
});
