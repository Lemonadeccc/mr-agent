export interface ExpiringCacheEntry<T> {
  expiresAt: number;
  value: T;
}

const DEFAULT_CACHE_PRUNE_INTERVAL_MS = 1_000;
const cacheLastPruneAt = new WeakMap<object, number>();

export function pruneExpiredCache<T>(
  cache: Map<string, ExpiringCacheEntry<T>>,
  now: number,
): void {
  const lastPruneAt = cacheLastPruneAt.get(cache as object) ?? 0;
  if (now - lastPruneAt < DEFAULT_CACHE_PRUNE_INTERVAL_MS) {
    return;
  }
  cacheLastPruneAt.set(cache as object, now);

  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

export function getFreshCacheValue<T>(
  cache: Map<string, ExpiringCacheEntry<T>>,
  key: string,
  now: number,
): T | undefined {
  const cached = cache.get(key);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return cached.value;
}

export function trimCache(cache: Map<string, unknown>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const first = cache.keys().next();
    if (first.done) {
      break;
    }

    cache.delete(first.value);
  }
}
