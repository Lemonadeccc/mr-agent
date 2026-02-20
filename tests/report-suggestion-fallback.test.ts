import assert from "node:assert/strict";
import test from "node:test";

import { buildIssueCommentMarkdown } from "../src/review/report-renderer.ts";

test("old-line suggestion is rendered as fallback text block instead of being dropped", () => {
  const markdown = buildIssueCommentMarkdown(
    {
      severity: "medium",
      newPath: "src/a.ts",
      oldPath: "src/a.ts",
      type: "old",
      startLine: 8,
      endLine: 8,
      issueHeader: "Deletion looks risky",
      issueContent: "Consider keeping this guard.",
      suggestion: "if (!input) return;",
    },
    { platform: "github", locale: "en" },
  );

  assert.doesNotMatch(markdown, /```suggestion/);
  assert.match(markdown, /Suggested fix/i);
  assert.match(markdown, /```text/);
  assert.match(markdown, /if \(!input\) return;/);
});
