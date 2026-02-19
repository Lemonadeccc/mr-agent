export interface ExpiringCacheEntry<T> {
  expiresAt: number;
  value: T;
}

export function pruneExpiredCache<T>(
  cache: Map<string, ExpiringCacheEntry<T>>,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
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
