import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetAiConcurrencyForTests,
  __withAiConcurrencyLimitForTests,
} from "../src/review/ai-reviewer.ts";

test("ai concurrency limiter respects AI_MAX_CONCURRENCY", async () => {
  const originalLimit = process.env.AI_MAX_CONCURRENCY;
  process.env.AI_MAX_CONCURRENCY = "1";
  __resetAiConcurrencyForTests();

  let active = 0;
  let maxActive = 0;
  const runTask = async (label: string) =>
    __withAiConcurrencyLimitForTests(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return label;
    });

  try {
    const results = await Promise.all([runTask("a"), runTask("b"), runTask("c")]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.equal(maxActive, 1);
  } finally {
    process.env.AI_MAX_CONCURRENCY = originalLimit;
    __resetAiConcurrencyForTests();
  }
});
