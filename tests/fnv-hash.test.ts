import assert from "node:assert/strict";
import test from "node:test";

import { fnv1a32Hex } from "../src/core/fnv.ts";
import { buildManagedCommandCommentKey } from "../src/integrations/github/github-review.ts";
import { buildGitLabManagedCommandCommentKey } from "../src/integrations/gitlab/gitlab-review.ts";

test("fnv1a32Hex returns stable 32-bit hex digest", () => {
  assert.equal(fnv1a32Hex("abc"), "1a47e90b");
  assert.equal(fnv1a32Hex("hello"), "4f9f2cab");
  assert.equal(fnv1a32Hex("x".repeat(10_000)).length, 8);
});

test("managed comment keys reuse shared fnv hash implementation", () => {
  const seed = "How to fix flaky test?";
  const normalizedSeed = seed.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240);
  const hash = fnv1a32Hex(normalizedSeed);

  const githubKey = buildManagedCommandCommentKey("ask", seed);
  const gitlabKey = buildGitLabManagedCommandCommentKey("ask", seed);

  assert.match(githubKey, new RegExp(`${hash}$`));
  assert.match(gitlabKey, new RegExp(`${hash}$`));
});
