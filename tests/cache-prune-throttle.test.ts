import assert from "node:assert/strict";
import test from "node:test";

import {
  getFreshCacheValue,
  pruneExpiredCache,
  type ExpiringCacheEntry,
} from "../src/core/cache.ts";

test("cache prune is throttled and key reads still drop expired entries", () => {
  const cache = new Map<string, ExpiringCacheEntry<string>>([
    ["alive", { value: "ok", expiresAt: 2_000 }],
    ["expired-1", { value: "x", expiresAt: 1_000 }],
  ]);

  pruneExpiredCache(cache, 1_500);
  assert.equal(cache.has("expired-1"), false);
  assert.equal(cache.has("alive"), true);

  cache.set("expired-2", { value: "y", expiresAt: 1_550 });
  pruneExpiredCache(cache, 1_600);

  assert.equal(cache.has("expired-2"), true);
  assert.equal(getFreshCacheValue(cache, "expired-2", 1_600), undefined);
  assert.equal(cache.has("expired-2"), false);
  assert.equal(getFreshCacheValue(cache, "alive", 1_600), "ok");
});
