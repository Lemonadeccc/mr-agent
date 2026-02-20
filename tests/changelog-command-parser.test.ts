import assert from "node:assert/strict";
import test from "node:test";

import { parseChangelogCommand } from "../src/review/report-renderer.ts";

test("parseChangelogCommand supports --apply before focus", () => {
  const parsed = parseChangelogCommand("/changelog --apply optimize startup");
  assert.equal(parsed.matched, true);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.focus, "optimize startup");
});

test("parseChangelogCommand supports --apply after focus", () => {
  const parsed = parseChangelogCommand("/changelog optimize startup --apply");
  assert.equal(parsed.matched, true);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.focus, "optimize startup");
});

test("parseChangelogCommand supports ai-review alias", () => {
  const parsed = parseChangelogCommand(
    "/ai-review changelog --apply auth flow and changelog wording",
  );
  assert.equal(parsed.matched, true);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.focus, "auth flow and changelog wording");
});
