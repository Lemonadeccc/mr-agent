interface RequestRecord {
  timestamp: number;
  timeout: ReturnType<typeof setTimeout>;
}

const requestRecords = new Map<string, RequestRecord>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function isDuplicateRequest(
  key: string,
  ttlMs = DEFAULT_TTL_MS,
): boolean {
  const now = Date.now();
  const previous = requestRecords.get(key);

  if (previous && now - previous.timestamp < ttlMs) {
    return true;
  }

  if (previous) {
    clearTimeout(previous.timeout);
  }

  const timeout = setTimeout(() => {
    const current = requestRecords.get(key);
    if (current?.timeout === timeout) {
      requestRecords.delete(key);
    }
  }, ttlMs);

  requestRecords.set(key, {
    timestamp: now,
    timeout,
  });

  return false;
}

export function clearDuplicateRecord(key: string): void {
  const record = requestRecords.get(key);
  if (record) {
    clearTimeout(record.timeout);
  }
  requestRecords.delete(key);
}
