import assert from "node:assert/strict";
import test from "node:test";

import { findSimilarIssues } from "../src/review/similar-issue.ts";

test("findSimilarIssues ranks candidates by keyword overlap and phrase hits", () => {
  const matches = findSimilarIssues({
    query: "auth token refresh timeout",
    candidates: [
      {
        id: 1,
        title: "Fix auth token refresh timeout in gateway",
        body: "timeout while refreshing oauth tokens",
        url: "https://example.com/issues/1",
        state: "open",
      },
      {
        id: 2,
        title: "Update README for deployment",
        body: "documentation only",
        url: "https://example.com/issues/2",
        state: "closed",
      },
      {
        id: 3,
        title: "Cache cleanup task",
        body: "memory pressure and stale cache",
        url: "https://example.com/issues/3",
        state: "open",
      },
    ],
  });

  assert.equal(matches.length >= 1, true);
  assert.equal(matches[0]?.id, 1);
  assert.equal(matches.some((item) => item.id === 2), false);
});
