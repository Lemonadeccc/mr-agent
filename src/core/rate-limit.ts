import {
  __getRuntimeStateScopeEntryCountForTests,
  clearRuntimeStateScope,
  loadRuntimeStateValue,
  saveRuntimeStateValue,
} from "./runtime-state.js";

const MAX_RATE_LIMIT_KEYS = 5_000;
const MAX_RATE_LIMIT_KEY_IDLE_MS = 24 * 60 * 60 * 1_000;
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
  const safeKey = key.trim().slice(0, 240);
  if (!safeKey) {
    return false;
  }

  const safeLimit = Math.max(1, Math.floor(limit));
  const safeWindowMs = Math.max(1, Math.floor(windowMs));
  const now = Date.now();
  const windowStart = now - safeWindowMs;

  const existing =
    loadRuntimeStateValue<number[]>(RATE_LIMIT_STATE_SCOPE, safeKey, now) ?? [];
  const recent = existing
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > windowStart)
    .map((timestamp) => Math.floor(timestamp));

  if (recent.length >= safeLimit) {
    touchRateLimitRecord(safeKey, recent);
    return true;
  }

  recent.push(now);
  touchRateLimitRecord(safeKey, recent);
  return false;
}

function touchRateLimitRecord(key: string, timestamps: number[]): void {
  const latest = timestamps[timestamps.length - 1] ?? Date.now();
  saveRuntimeStateValue({
    scope: RATE_LIMIT_STATE_SCOPE,
    key,
    value: timestamps,
    expiresAt: latest + MAX_RATE_LIMIT_KEY_IDLE_MS,
    maxEntries: MAX_RATE_LIMIT_KEYS,
  });
}

export function __clearRateLimitStateForTests(): void {
  clearRuntimeStateScope(RATE_LIMIT_STATE_SCOPE);
}

export function __getRateLimitRecordCountForTests(): number {
  return __getRuntimeStateScopeEntryCountForTests(RATE_LIMIT_STATE_SCOPE);
}
