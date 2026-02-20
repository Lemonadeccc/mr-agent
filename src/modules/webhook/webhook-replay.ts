import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";

import { BadWebhookRequestError, WebhookAuthError, readNumberEnv } from "#core";
import { incrementMetricCounter } from "./metrics.js";

export type ReplayPlatform = "github" | "gitlab";

export interface StoredWebhookEvent {
  id: string;
  platform: ReplayPlatform;
  eventName: string;
  receivedAt: string;
  headers: Record<string, string>;
  payload?: unknown;
  rawBody?: string;
}

export interface StoredWebhookEventSummary {
  id: string;
  platform: ReplayPlatform;
  eventName: string;
  receivedAt: string;
  hasPayload: boolean;
  payloadSizeBytes: number;
}

const DEFAULT_WEBHOOK_EVENT_STORE_FILE = ".mr-agent-webhook-events.ndjson";
const DEFAULT_WEBHOOK_EVENT_STORE_MAX_ENTRIES = 2_000;
const DEFAULT_WEBHOOK_EVENT_STORE_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_WEBHOOK_EVENT_LIST_LIMIT = 20;
const MAX_WEBHOOK_EVENT_LIST_LIMIT = 200;
const TRIM_STORE_INTERVAL_WRITES = 20;

let writesSinceLastTrim = 0;

export function recordWebhookEvent(params: {
  platform: ReplayPlatform;
  eventName: string;
  headers: Record<string, string | string[] | undefined>;
  payload?: unknown;
  rawBody?: string;
}): string | undefined {
  if (!isWebhookEventStoreEnabled()) {
    return undefined;
  }

  const id = buildStoredWebhookEventId(params.platform);
  const rawBody = buildStoredRawBody(params.rawBody, params.payload);
  const stored: StoredWebhookEvent = {
    id,
    platform: params.platform,
    eventName: params.eventName.trim().toLowerCase() || "unknown",
    receivedAt: new Date().toISOString(),
    headers: sanitizeHeaders(params.headers),
    payload: params.payload,
    rawBody,
  };

  try {
    persistStoredWebhookEvent(stored);
    incrementMetricCounter("mr_agent_webhook_store_writes_total", {
      platform: params.platform,
    });

    writesSinceLastTrim += 1;
    if (writesSinceLastTrim >= TRIM_STORE_INTERVAL_WRITES) {
      writesSinceLastTrim = 0;
      trimStoredWebhookEvents();
    }
  } catch {
    // Best-effort debug storage. Runtime behavior should never fail on replay storage errors.
  }

  return id;
}

export function listStoredWebhookEvents(params?: {
  platform?: ReplayPlatform;
  limit?: number;
}): StoredWebhookEventSummary[] {
  if (!isWebhookEventStoreEnabled()) {
    return [];
  }

  const limit = resolveWebhookEventListLimit(params?.limit);
  const events = readStoredWebhookEvents();
  const selected: StoredWebhookEventSummary[] = [];

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (!item) {
      continue;
    }
    if (params?.platform && item.platform !== params.platform) {
      continue;
    }

    const payloadText =
      typeof item.rawBody === "string"
        ? item.rawBody
        : typeof item.payload === "undefined"
          ? ""
          : safeJsonStringify(item.payload);

    selected.push({
      id: item.id,
      platform: item.platform,
      eventName: item.eventName,
      receivedAt: item.receivedAt,
      hasPayload: Boolean(item.rawBody) || typeof item.payload !== "undefined",
      payloadSizeBytes: Buffer.byteLength(payloadText, "utf8"),
    });

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

export function getStoredWebhookEventById(params: {
  id: string;
  platform?: ReplayPlatform;
}): StoredWebhookEvent | undefined {
  if (!isWebhookEventStoreEnabled()) {
    return undefined;
  }

  const targetId = params.id.trim();
  if (!targetId) {
    return undefined;
  }

  const events = readStoredWebhookEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (!item || item.id !== targetId) {
      continue;
    }
    if (params.platform && item.platform !== params.platform) {
      continue;
    }
    return item;
  }

  return undefined;
}

export function resolveStoredWebhookReplayPayload(event: StoredWebhookEvent): unknown {
  if (typeof event.payload !== "undefined") {
    return event.payload;
  }

  if (typeof event.rawBody !== "string" || !event.rawBody.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(event.rawBody) as unknown;
  } catch {
    return undefined;
  }
}

export function isWebhookReplayEnabled(
  rawValue: string | undefined = process.env.WEBHOOK_REPLAY_ENABLED,
): boolean {
  return parseBooleanEnv(rawValue);
}

export function assertWebhookReplayAuthorized(
  headers: Record<string, string | string[] | undefined>,
): void {
  if (!isWebhookReplayEnabled()) {
    throw new BadWebhookRequestError(
      "webhook replay endpoint is disabled; set WEBHOOK_REPLAY_ENABLED=true to enable",
    );
  }

  const expected = process.env.WEBHOOK_REPLAY_TOKEN?.trim();
  if (!expected) {
    throw new BadWebhookRequestError(
      "WEBHOOK_REPLAY_TOKEN must be configured when WEBHOOK_REPLAY_ENABLED=true",
    );
  }

  const actual = readHeaderValue(headers, "x-mr-agent-replay-token")?.trim();
  if (!actual) {
    throw new WebhookAuthError("invalid replay token", 403);
  }

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new WebhookAuthError("invalid replay token", 403);
  }
}

export function resolveWebhookEventListLimit(rawLimit: number | string | undefined): number {
  const parsed = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WEBHOOK_EVENT_LIST_LIMIT;
  }

  const normalized = Math.floor(parsed);
  if (normalized < 1) {
    return 1;
  }

  return Math.min(MAX_WEBHOOK_EVENT_LIST_LIMIT, normalized);
}

function isWebhookEventStoreEnabled(
  rawValue: string | undefined = process.env.WEBHOOK_EVENT_STORE_ENABLED,
): boolean {
  return parseBooleanEnv(rawValue);
}

function parseBooleanEnv(rawValue: string | undefined): boolean {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function buildStoredWebhookEventId(platform: ReplayPlatform): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${platform}-${timestamp}-${random}`;
}

function buildStoredRawBody(rawBody: string | undefined, payload: unknown): string | undefined {
  const maxBodyBytes = Math.max(
    1,
    readNumberEnv(
      "WEBHOOK_EVENT_STORE_MAX_BODY_BYTES",
      DEFAULT_WEBHOOK_EVENT_STORE_MAX_BODY_BYTES,
    ),
  );

  const source =
    typeof rawBody === "string"
      ? rawBody
      : typeof payload === "undefined"
        ? ""
        : safeJsonStringify(payload);
  if (!source) {
    return undefined;
  }

  const sourceBuffer = Buffer.from(source, "utf8");
  if (sourceBuffer.length <= maxBodyBytes) {
    return source;
  }

  return sourceBuffer.subarray(0, maxBodyBytes).toString("utf8");
}

function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const includeSensitive = parseBooleanEnv(process.env.WEBHOOK_EVENT_STORE_INCLUDE_SENSITIVE_HEADERS);
  const sanitized: Record<string, string> = {};
  const allowedKeys = new Set([
    "x-github-event",
    "x-github-delivery",
    "x-gitlab-event",
    "x-gitlab-delivery",
    "x-gitlab-instance",
    "content-type",
    "user-agent",
  ]);

  for (const [keyRaw, valueRaw] of Object.entries(headers)) {
    const key = keyRaw.trim().toLowerCase();
    const value = Array.isArray(valueRaw) ? valueRaw[0] : valueRaw;
    if (!value) {
      continue;
    }

    const isSensitiveHeader =
      key === "x-hub-signature-256" ||
      key === "x-gitlab-token" ||
      key === "x-gitlab-api-token" ||
      key === "authorization";

    if (!includeSensitive) {
      if (!allowedKeys.has(key) || isSensitiveHeader) {
        continue;
      }
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function persistStoredWebhookEvent(event: StoredWebhookEvent): void {
  const filePath = resolveWebhookEventStoreFile();
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${safeJsonStringify(event)}\n`, "utf8");
}

function trimStoredWebhookEvents(): void {
  const events = readStoredWebhookEvents();
  const maxEntries = Math.max(
    1,
    readNumberEnv(
      "WEBHOOK_EVENT_STORE_MAX_ENTRIES",
      DEFAULT_WEBHOOK_EVENT_STORE_MAX_ENTRIES,
    ),
  );

  if (events.length <= maxEntries) {
    return;
  }

  const kept = events.slice(events.length - maxEntries);
  const filePath = resolveWebhookEventStoreFile();
  writeFileSync(
    filePath,
    `${kept.map((event) => safeJsonStringify(event)).join("\n")}\n`,
    "utf8",
  );
  incrementMetricCounter("mr_agent_webhook_store_trim_total", {
    result: "trimmed",
  });
}

function readStoredWebhookEvents(): StoredWebhookEvent[] {
  const filePath = resolveWebhookEventStoreFile();
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const events: StoredWebhookEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        const normalized = normalizeStoredWebhookEvent(parsed);
        if (normalized) {
          events.push(normalized);
        }
      } catch {
        continue;
      }
    }
    return events;
  } catch {
    return [];
  }
}

function normalizeStoredWebhookEvent(input: unknown): StoredWebhookEvent | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const root = input as {
    id?: unknown;
    platform?: unknown;
    eventName?: unknown;
    receivedAt?: unknown;
    headers?: unknown;
    payload?: unknown;
    rawBody?: unknown;
  };

  if (typeof root.id !== "string" || typeof root.receivedAt !== "string") {
    return undefined;
  }
  if (root.platform !== "github" && root.platform !== "gitlab") {
    return undefined;
  }

  const headers: Record<string, string> = {};
  if (root.headers && typeof root.headers === "object" && !Array.isArray(root.headers)) {
    for (const [key, value] of Object.entries(root.headers as Record<string, unknown>)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
  }

  return {
    id: root.id,
    platform: root.platform,
    eventName:
      typeof root.eventName === "string" ? root.eventName.trim().toLowerCase() : "unknown",
    receivedAt: root.receivedAt,
    headers,
    payload: root.payload,
    rawBody: typeof root.rawBody === "string" ? root.rawBody : undefined,
  };
}

function resolveWebhookEventStoreFile(): string {
  const raw = process.env.WEBHOOK_EVENT_STORE_FILE?.trim();
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_WEBHOOK_EVENT_STORE_FILE);
  }
  return resolve(raw);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "null";
  }
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const direct = headers[key];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    return direct[0];
  }

  const target = key.toLowerCase();
  for (const [headerKey, headerValue] of Object.entries(headers)) {
    if (headerKey.toLowerCase() !== target) {
      continue;
    }
    if (typeof headerValue === "string") {
      return headerValue;
    }
    if (Array.isArray(headerValue)) {
      return headerValue[0];
    }
  }

  return undefined;
}
