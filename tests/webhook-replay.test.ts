import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertWebhookReplayAuthorized,
  getStoredWebhookEventById,
  listStoredWebhookEvents,
  recordWebhookEvent,
  resolveStoredWebhookReplayPayload,
} from "../src/modules/webhook/webhook-replay.ts";

const storeFile = join(
  "/tmp",
  `mr-agent-webhook-events-${Date.now()}-${Math.random().toString(16).slice(2)}.ndjson`,
);

test("webhook replay store can persist and read events", () => {
  const originalStoreEnabled = process.env.WEBHOOK_EVENT_STORE_ENABLED;
  const originalStoreFile = process.env.WEBHOOK_EVENT_STORE_FILE;

  process.env.WEBHOOK_EVENT_STORE_ENABLED = "true";
  process.env.WEBHOOK_EVENT_STORE_FILE = storeFile;

  try {
    const eventId = recordWebhookEvent({
      platform: "github",
      eventName: "issue_comment",
      headers: {
        "x-github-event": "issue_comment",
      },
      payload: {
        action: "created",
      },
      rawBody: JSON.stringify({ action: "created" }),
    });

    assert.ok(eventId);

    const listed = listStoredWebhookEvents({
      platform: "github",
      limit: 5,
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, eventId);

    const stored = getStoredWebhookEventById({
      id: eventId ?? "",
      platform: "github",
    });
    assert.equal(stored?.id, eventId);
    assert.equal(stored?.eventName, "issue_comment");

    const replayPayload = stored ? resolveStoredWebhookReplayPayload(stored) : undefined;
    assert.deepEqual(replayPayload, { action: "created" });
  } finally {
    process.env.WEBHOOK_EVENT_STORE_ENABLED = originalStoreEnabled;
    process.env.WEBHOOK_EVENT_STORE_FILE = originalStoreFile;
  }
});

test("webhook replay authorization validates replay token", () => {
  const originalReplayEnabled = process.env.WEBHOOK_REPLAY_ENABLED;
  const originalReplayToken = process.env.WEBHOOK_REPLAY_TOKEN;

  process.env.WEBHOOK_REPLAY_ENABLED = "true";
  process.env.WEBHOOK_REPLAY_TOKEN = "secret-token";

  try {
    assert.throws(
      () =>
        assertWebhookReplayAuthorized({
          "x-mr-agent-replay-token": "wrong-token",
        }),
      /invalid replay token/i,
    );

    assert.doesNotThrow(() =>
      assertWebhookReplayAuthorized({
        "x-mr-agent-replay-token": "secret-token",
      }),
    );
  } finally {
    process.env.WEBHOOK_REPLAY_ENABLED = originalReplayEnabled;
    process.env.WEBHOOK_REPLAY_TOKEN = originalReplayToken;
  }
});

test.after(() => {
  rmSync(storeFile, { force: true });
});
