import {
  clearRuntimeStateScope,
  deleteRuntimeStateValue,
  loadRuntimeStateValue,
  saveRuntimeStateValue,
} from "./runtime-state.js";

const MAX_RATE_LIMIT_KEYS = 5_000;
const MAX_RATE_LIMIT_KEY_IDLE_MS = 24 * 60 * 60 * 1_000;
const rateLimitRecords = new Map<string, number[]>();
const RATE_LIMIT_STATE_SCOPE = "rate-limit-records";

export function normalizeRateLimitPart(
  raw: string | undefined,
  fallback: string,
): string {
  const normalized = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return normalized || fallback;
}

export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindowMs = Math.max(1, Math.floor(windowMs));
  const now = Date.now();
  const windowStart = now - safeWindowMs;

  pruneStaleRateLimitRecords(now);
  const persisted =
    loadRuntimeStateValue<number[]>(RATE_LIMIT_STATE_SCOPE, key, now) ?? [];
  const existing = rateLimitRecords.get(key) ?? persisted;
  const recent = existing.filter((timestamp) => timestamp > windowStart);

  if (recent.length >= safeLimit) {
    touchRateLimitRecord(key, recent);
    return true;
  }

  recent.push(now);
  touchRateLimitRecord(key, recent);
  trimRateLimitRecords();
  return false;
}

function touchRateLimitRecord(key: string, timestamps: number[]): void {
  rateLimitRecords.delete(key);
  rateLimitRecords.set(key, timestamps);
  const latest = timestamps[timestamps.length - 1] ?? Date.now();
  saveRuntimeStateValue({
    scope: RATE_LIMIT_STATE_SCOPE,
    key,
    value: timestamps,
    expiresAt: latest + MAX_RATE_LIMIT_KEY_IDLE_MS,
    maxEntries: MAX_RATE_LIMIT_KEYS,
  });
}

function pruneStaleRateLimitRecords(now: number): void {
  const staleCutoff = now - MAX_RATE_LIMIT_KEY_IDLE_MS;
  for (const [key, timestamps] of rateLimitRecords.entries()) {
    const latest = timestamps[timestamps.length - 1] ?? 0;
    if (latest <= staleCutoff) {
      rateLimitRecords.delete(key);
      deleteRuntimeStateValue(RATE_LIMIT_STATE_SCOPE, key);
    }
  }
}

function trimRateLimitRecords(): void {
  while (rateLimitRecords.size > MAX_RATE_LIMIT_KEYS) {
    const first = rateLimitRecords.keys().next();
    if (first.done) {
      break;
    }
    const key = first.value;
    rateLimitRecords.delete(key);
    deleteRuntimeStateValue(RATE_LIMIT_STATE_SCOPE, key);
  }
}

export function __clearRateLimitStateForTests(): void {
  rateLimitRecords.clear();
  clearRuntimeStateScope(RATE_LIMIT_STATE_SCOPE);
}

export function __getRateLimitRecordCountForTests(): number {
  return rateLimitRecords.size;
}
