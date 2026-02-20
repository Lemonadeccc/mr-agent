import assert from "node:assert/strict";
import test from "node:test";

import { prioritizePatchHunks } from "../src/review/patch.ts";

test("prioritizePatchHunks keeps higher-risk hunks when patch exceeds limit", () => {
  const patch = [
    "@@ -1,4 +1,6 @@",
    "-const x = 1;",
    "+const x = 2;",
    "+const note = 'minor';",
    "@@ -20,4 +20,8 @@",
    "-const token = process.env.API_TOKEN;",
    "+const token = process.env.API_TOKEN;",
    "+if (!token) throw new Error('missing token');",
    "+await refreshAuthToken(token);",
  ].join("\n");

  const result = prioritizePatchHunks(patch, 140);
  assert.match(result, /missing token|refreshAuthToken/);
  assert.match(result, /\[hunks prioritized\]|\[patch truncated\]/);
});
