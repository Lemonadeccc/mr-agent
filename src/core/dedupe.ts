import {
  clearRuntimeStateScope,
  deleteRuntimeStateValue,
  loadRuntimeStateValue,
  saveRuntimeStateValue,
} from "./runtime-state.js";

interface RequestRecord {
  timestamp: number;
  timeout: ReturnType<typeof setTimeout>;
}

const requestRecords = new Map<string, RequestRecord>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEDUPE_STATE_SCOPE = "dedupe-requests";
const MAX_DEDUPE_STATE_ENTRIES = 20_000;

export function isDuplicateRequest(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): boolean {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const previous = requestRecords.get(key);

  if (previous && now - previous.timestamp < ttlMs) {
    return true;
  }

  const persisted = loadRuntimeStateValue<{ timestamp: number }>(
    DEDUPE_STATE_SCOPE,
    key,
    now,
  );
  if (persisted && now - persisted.timestamp < ttlMs) {
    return true;
  }

  if (previous) {
    clearTimeout(previous.timeout);
  }

  const timeout = setTimeout(() => {
    const current = requestRecords.get(key);
    if (current?.timeout === timeout) {
      requestRecords.delete(key);
      deleteRuntimeStateValue(DEDUPE_STATE_SCOPE, key);
    }
  }, ttlMs);
  timeout.unref?.();

  requestRecords.set(key, {
    timestamp: now,
    timeout,
  });
  saveRuntimeStateValue({
    scope: DEDUPE_STATE_SCOPE,
    key,
    value: {
      timestamp: now,
    },
    expiresAt,
    maxEntries: MAX_DEDUPE_STATE_ENTRIES,
  });

  return false;
}

export function clearDuplicateRecord(key: string): void {
  const record = requestRecords.get(key);
  if (record) {
    clearTimeout(record.timeout);
  }
  requestRecords.delete(key);
  deleteRuntimeStateValue(DEDUPE_STATE_SCOPE, key);
}

export function __clearDuplicateRequestStateForTests(): void {
  for (const record of requestRecords.values()) {
    clearTimeout(record.timeout);
  }
  requestRecords.clear();
  clearRuntimeStateScope(DEDUPE_STATE_SCOPE);
}
