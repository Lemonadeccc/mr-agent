import assert from "node:assert/strict";
import test from "node:test";

import { AppService } from "../src/app.service.ts";

test("health endpoint returns static status when deep check is disabled", async () => {
  const service = new AppService();
  const result = await service.getHealth({
    mode: "nest",
    deep: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "nest");
  assert.equal(result.checks, undefined);
});

test("health deep check includes ai probe details", async () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;

  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  try {
    const service = new AppService();
    const result = await service.getHealth({
      mode: "nest",
      deep: true,
    });

    assert.equal(result.checks?.ai.provider, "openai");
    assert.equal(result.checks?.ai.ok, true);
    assert.equal(typeof result.checks?.ai.latencyMs, "number");
  } finally {
    process.env.AI_PROVIDER = originalProvider;
    process.env.OPENAI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
  }
});
