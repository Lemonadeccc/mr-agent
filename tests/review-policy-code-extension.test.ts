import assert from "node:assert/strict";
import test from "node:test";

import { isCodeFile } from "../src/review/review-policy.ts";

test("isCodeFile only matches real extensions instead of full extensionless filename", () => {
  const original = process.env.REVIEW_CODE_EXTENSIONS;
  process.env.REVIEW_CODE_EXTENSIONS = "ts,makefile";

  try {
    assert.equal(isCodeFile("src/index.ts"), true);
    assert.equal(isCodeFile("Makefile"), false);
    assert.equal(isCodeFile("build/Makefile"), false);
  } finally {
    process.env.REVIEW_CODE_EXTENSIONS = original;
  }
});
