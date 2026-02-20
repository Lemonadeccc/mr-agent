import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetHttpShutdownForTests,
  beginHttpShutdown,
  computeRetryDelayMs,
  fetchWithRetry,
} from "../src/core/http.ts";

test("http retry delay grows exponentially by attempt", () => {
  assert.equal(computeRetryDelayMs(0, 400, 0), 400);
  assert.equal(computeRetryDelayMs(1, 400, 0), 800);
  assert.equal(computeRetryDelayMs(2, 400, 0), 1600);
});

test("http retry jitter stays within 0~20% of base backoff", () => {
  const base = computeRetryDelayMs(1, 500, 0);
  const middle = computeRetryDelayMs(1, 500, 0.5);
  const nearMax = computeRetryDelayMs(1, 500, 0.999999);

  assert.equal(base, 1000);
  assert.ok(middle >= 1000 && middle <= 1100);
  assert.ok(nearMax >= 1000 && nearMax <= 1100);
});

test("fetchWithRetry retries retryable status and keeps success behavior", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response("temporary", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  };

  try {
    const response = await fetchWithRetry("https://example.test/retryable", {}, {
      retries: 2,
      backoffMs: 1,
      timeoutMs: 1000,
      retryOnStatuses: [500],
    });
    assert.equal(response.status, 200);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry does not retry non-retryable status", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response("bad request", { status: 400 });
  };

  try {
    const response = await fetchWithRetry("https://example.test/non-retryable", {}, {
      retries: 3,
      backoffMs: 1,
      timeoutMs: 1000,
      retryOnStatuses: [500],
    });
    assert.equal(response.status, 400);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry aborts immediately after http shutdown starts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  try {
    __resetHttpShutdownForTests();
    beginHttpShutdown();
    await assert.rejects(
      () =>
        fetchWithRetry("https://example.test/shutdown", {}, {
          retries: 0,
          timeoutMs: 1000,
        }),
      /http client is shutting down/i,
    );
  } finally {
    __resetHttpShutdownForTests();
    globalThis.fetch = originalFetch;
  }
});
