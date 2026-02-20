import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stateFile = join(
  "/tmp",
  `mr-agent-runtime-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test("dedupe state survives module reload via runtime state backend", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = stateFile;

  try {
    const runtime = await import(`../src/core/runtime-state.ts?runtime_a=${Date.now()}`);
    runtime.__clearRuntimeStateForTests();
    const modA = await import(`../src/core/dedupe.ts?dedupe_a=${Date.now()}`);
    const modB = await import(`../src/core/dedupe.ts?dedupe_b=${Date.now()}`);
    const key = `dedupe-${Date.now()}`;

    assert.equal(modA.isDuplicateRequest(key, 10_000), false);
    assert.equal(modB.isDuplicateRequest(key, 10_000), true);

    modB.clearDuplicateRecord(key);
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
  }
});

test("rate-limit state survives module reload via runtime state backend", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = stateFile;

  try {
    const runtime = await import(`../src/core/runtime-state.ts?runtime_b=${Date.now()}`);
    runtime.__clearRuntimeStateForTests();
    const modA = await import(`../src/core/rate-limit.ts?rate_a=${Date.now()}`);
    const modB = await import(`../src/core/rate-limit.ts?rate_b=${Date.now()}`);
    const key = `rate-${Date.now()}`;

    assert.equal(modA.isRateLimited(key, 1, 60_000), false);
    assert.equal(modB.isRateLimited(key, 1, 60_000), true);

    modA.__clearRateLimitStateForTests();
    modB.__clearRateLimitStateForTests();
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
  }
});

test("ask conversation state survives module reload via runtime state backend", async () => {
  const originalBackend = process.env.RUNTIME_STATE_BACKEND;
  const originalFile = process.env.RUNTIME_STATE_FILE;
  process.env.RUNTIME_STATE_BACKEND = "file";
  process.env.RUNTIME_STATE_FILE = stateFile;

  try {
    const runtime = await import(`../src/core/runtime-state.ts?runtime_c=${Date.now()}`);
    runtime.__clearRuntimeStateForTests();
    const modA = await import(`../src/core/ask-session.ts?ask_a=${Date.now()}`);
    const modB = await import(`../src/core/ask-session.ts?ask_b=${Date.now()}`);
    const sessionKey = `session-${Date.now()}`;

    modA.rememberAskConversationTurn({
      sessionKey,
      question: "What changed?",
      answer: "The error handling path was hardened.",
    });

    const turns = modB.loadAskConversationTurns(sessionKey);
    assert.equal(turns.length, 1);
    assert.match(turns[0]?.answer ?? "", /hardened/i);

    modA.__clearAskConversationCacheForTests();
    modB.__clearAskConversationCacheForTests();
  } finally {
    process.env.RUNTIME_STATE_BACKEND = originalBackend;
    process.env.RUNTIME_STATE_FILE = originalFile;
  }
});

test.after(() => {
  rmSync(stateFile, { force: true });
});
