const MAX_RATE_LIMIT_KEYS = 5_000;
const MAX_RATE_LIMIT_KEY_IDLE_MS = 24 * 60 * 60 * 1_000;
const rateLimitRecords = new Map<string, number[]>();

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
  const existing = rateLimitRecords.get(key) ?? [];
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
}

function pruneStaleRateLimitRecords(now: number): void {
  const staleCutoff = now - MAX_RATE_LIMIT_KEY_IDLE_MS;
  for (const [key, timestamps] of rateLimitRecords.entries()) {
    const latest = timestamps[timestamps.length - 1] ?? 0;
    if (latest <= staleCutoff) {
      rateLimitRecords.delete(key);
    }
  }
}

function trimRateLimitRecords(): void {
  while (rateLimitRecords.size > MAX_RATE_LIMIT_KEYS) {
    const first = rateLimitRecords.keys().next();
    if (first.done) {
      break;
    }
    rateLimitRecords.delete(first.value);
  }
}

export function __clearRateLimitStateForTests(): void {
  rateLimitRecords.clear();
}

export function __getRateLimitRecordCountForTests(): number {
  return rateLimitRecords.size;
}
