import { pruneExpiredCache, trimCache, type ExpiringCacheEntry } from "./cache.js";
import { readNumberEnv } from "./env.js";

export interface AskConversationTurn {
  question: string;
  answer: string;
}

const DEFAULT_ASK_SESSION_TTL_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_ASK_SESSION_MAX_TURNS = 6;
const DEFAULT_ASK_SESSION_MAX_ENTRIES = 2_000;

type AskConversationCacheEntry = ExpiringCacheEntry<AskConversationTurn[]>;

const askConversationCache = new Map<string, AskConversationCacheEntry>();

export function loadAskConversationTurns(sessionKey: string): AskConversationTurn[] {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return [];
  }

  const now = Date.now();
  pruneExpiredCache(askConversationCache, now);
  const turns = askConversationCache.get(key)?.value ?? [];
  return turns.map((turn) => ({ ...turn }));
}

export function rememberAskConversationTurn(params: {
  sessionKey: string;
  question: string;
  answer: string;
}): void {
  const key = normalizeSessionKey(params.sessionKey);
  const question = params.question.trim();
  const answer = params.answer.trim();
  if (!key || !question || !answer) {
    return;
  }

  const now = Date.now();
  pruneExpiredCache(askConversationCache, now);
  const ttlMs = Math.max(1, readNumberEnv("ASK_SESSION_TTL_MS", DEFAULT_ASK_SESSION_TTL_MS));
  const maxTurns = Math.max(1, readNumberEnv("ASK_SESSION_MAX_TURNS", DEFAULT_ASK_SESSION_MAX_TURNS));
  const maxEntries = Math.max(
    1,
    readNumberEnv("ASK_SESSION_MAX_ENTRIES", DEFAULT_ASK_SESSION_MAX_ENTRIES),
  );

  const current = askConversationCache.get(key)?.value ?? [];
  const next = [...current, { question, answer }];
  const trimmed = next.slice(Math.max(0, next.length - maxTurns));

  askConversationCache.set(key, {
    value: trimmed,
    expiresAt: now + ttlMs,
  });
  trimCache(askConversationCache, maxEntries);
}

function normalizeSessionKey(raw: string): string {
  return raw.trim().slice(0, 200);
}

export function __clearAskConversationCacheForTests(): void {
  askConversationCache.clear();
}
