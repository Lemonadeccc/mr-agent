import assert from "node:assert/strict";
import test from "node:test";

import { publishNotification } from "../src/integrations/notify/notification.ts";

test("notification payload supports slack webhook format", async () => {
  const originalFetch = globalThis.fetch;
  const originalFormat = process.env.NOTIFY_WEBHOOK_FORMAT;
  process.env.NOTIFY_WEBHOOK_FORMAT = "slack";

  let postedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    postedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response("{}", { status: 200 });
  };

  try {
    await publishNotification({
      pushUrl: "https://notify.example.com/hook",
      author: "alice",
      repository: "acme/demo",
      sourceBranch: "feat/x",
      targetBranch: "main",
      content: "Code review failed",
      logger: {
        error: () => undefined,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.NOTIFY_WEBHOOK_FORMAT = originalFormat;
  }

  assert.equal(typeof postedBody?.text, "string");
  assert.equal(postedBody?.msgtype, undefined);
});
