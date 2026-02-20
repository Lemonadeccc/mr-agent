import assert from "node:assert/strict";
import test from "node:test";

import { createRestBackedOctokit } from "../src/integrations/github/github-webhook.ts";

test("rest octokit tracks list-files truncated flag per pull request", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/files")) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const pullNumber = url.pathname.split("/").at(-2);
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "100");

    if (pullNumber === "1") {
      const files = Array.from({ length: perPage }, (_, index) => ({
        filename: `src/pull-1-${page}-${index}.ts`,
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

    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const octokit = createRestBackedOctokit({
      token: "test-token",
      baseUrl: "https://api.github.com",
    });

    await octokit.paginate(octokit.pulls.listFiles, {
      owner: "acme",
      repo: "demo",
      pull_number: 1,
      per_page: 1,
    });
    await octokit.paginate(octokit.pulls.listFiles, {
      owner: "acme",
      repo: "demo",
      pull_number: 2,
      per_page: 1,
    });

    assert.equal(
      octokit.__getListFilesTruncated?.({
        owner: "acme",
        repo: "demo",
        pull_number: 1,
        per_page: 1,
      }) ?? false,
      true,
    );
    assert.equal(
      octokit.__getListFilesTruncated?.({
        owner: "acme",
        repo: "demo",
        pull_number: 2,
        per_page: 1,
      }) ?? true,
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
