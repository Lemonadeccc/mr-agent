import assert from "node:assert/strict";
import test from "node:test";

import { decodeGitHubFileContent } from "../src/integrations/github/github-content.ts";

test("decodeGitHubFileContent decodes base64 payload with line breaks", () => {
  const encoded = "aGVsbG8K\nd29ybGQ=";
  assert.equal(decodeGitHubFileContent(encoded, "base64"), "hello\nworld");
});

test("decodeGitHubFileContent returns raw content for non-base64 encoding", () => {
  assert.equal(decodeGitHubFileContent("plain-text", "utf-8"), "plain-text");
  assert.equal(decodeGitHubFileContent("plain-text", undefined), "plain-text");
});
