import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface RuntimeStateEntry {
  value: unknown;
  expiresAt: number;
  updatedAt: number;
}

interface RuntimeStateSnapshot {
  version: 1;
  scopes: Record<string, Record<string, RuntimeStateEntry>>;
}

const DEFAULT_RUNTIME_STATE_VERSION = 1 as const;
const DEFAULT_RUNTIME_STATE_FILE = ".mr-agent-runtime-state.json";
const DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS = 1_000;
const scopeLastPruneAt = new Map<string, number>();

let loaded = false;
let runtimeState: RuntimeStateSnapshot = {
  version: DEFAULT_RUNTIME_STATE_VERSION,
  scopes: {},
};

export function loadRuntimeStateValue<T>(
  scope: string,
  key: string,
  now = Date.now(),
): T | undefined {
  const scopeName = normalizeScope(scope);
  const stateKey = normalizeKey(key);
  if (!scopeName || !stateKey) {
    return undefined;
  }

  ensureRuntimeStateLoaded();
  pruneScope(scopeName, now);
  const entry = runtimeState.scopes[scopeName]?.[stateKey];
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    delete runtimeState.scopes[scopeName]?.[stateKey];
    persistRuntimeState();
    return undefined;
  }
  return entry.value as T;
}

export function saveRuntimeStateValue<T>(params: {
  scope: string;
  key: string;
  value: T;
  expiresAt: number;
  maxEntries?: number;
}): void {
  const scopeName = normalizeScope(params.scope);
  const stateKey = normalizeKey(params.key);
  if (!scopeName || !stateKey) {
    return;
  }

  ensureRuntimeStateLoaded();
  const now = Date.now();
  const scopeState = getOrCreateScope(scopeName);
  scopeState[stateKey] = {
    value: params.value,
    expiresAt: params.expiresAt,
    updatedAt: now,
  };

  pruneScope(scopeName, now);
  trimScope(scopeName, params.maxEntries);
  persistRuntimeState();
}

export function deleteRuntimeStateValue(scope: string, key: string): void {
  const scopeName = normalizeScope(scope);
  const stateKey = normalizeKey(key);
  if (!scopeName || !stateKey) {
    return;
  }

  ensureRuntimeStateLoaded();
  const scopeState = runtimeState.scopes[scopeName];
  if (!scopeState || !(stateKey in scopeState)) {
    return;
  }

  delete scopeState[stateKey];
  if (Object.keys(scopeState).length === 0) {
    delete runtimeState.scopes[scopeName];
  }
  persistRuntimeState();
}

export function clearRuntimeStateScope(scope: string): void {
  const scopeName = normalizeScope(scope);
  if (!scopeName) {
    return;
  }

  ensureRuntimeStateLoaded();
  if (!(scopeName in runtimeState.scopes)) {
    return;
  }
  delete runtimeState.scopes[scopeName];
  scopeLastPruneAt.delete(scopeName);
  persistRuntimeState();
}

export function __clearRuntimeStateForTests(): void {
  loaded = true;
  runtimeState = {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes: {},
  };
  scopeLastPruneAt.clear();
  persistRuntimeState();
}

function ensureRuntimeStateLoaded(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  runtimeState = {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes: {},
  };

  if (!isRuntimeStatePersistenceEnabled()) {
    return;
  }

  try {
    const raw = readFileSync(resolveRuntimeStateFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    runtimeState = normalizeRuntimeStateSnapshot(parsed);
  } catch {
    runtimeState = {
      version: DEFAULT_RUNTIME_STATE_VERSION,
      scopes: {},
    };
  }
}

function normalizeRuntimeStateSnapshot(input: unknown): RuntimeStateSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      version: DEFAULT_RUNTIME_STATE_VERSION,
      scopes: {},
    };
  }
  const root = input as {
    version?: unknown;
    scopes?: unknown;
  };
  if (root.version !== DEFAULT_RUNTIME_STATE_VERSION) {
    return {
      version: DEFAULT_RUNTIME_STATE_VERSION,
      scopes: {},
    };
  }

  const scopes: Record<string, Record<string, RuntimeStateEntry>> = {};
  if (!root.scopes || typeof root.scopes !== "object" || Array.isArray(root.scopes)) {
    return {
      version: DEFAULT_RUNTIME_STATE_VERSION,
      scopes,
    };
  }

  for (const [scopeName, rawScope] of Object.entries(root.scopes as Record<string, unknown>)) {
    if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
      continue;
    }

    const scope: Record<string, RuntimeStateEntry> = {};
    for (const [key, rawEntry] of Object.entries(rawScope as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        continue;
      }
      const entry = rawEntry as {
        value?: unknown;
        expiresAt?: unknown;
        updatedAt?: unknown;
      };
      if (
        typeof entry.expiresAt !== "number" ||
        !Number.isFinite(entry.expiresAt) ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt)
      ) {
        continue;
      }
      scope[key] = {
        value: entry.value,
        expiresAt: entry.expiresAt,
        updatedAt: entry.updatedAt,
      };
    }

    if (Object.keys(scope).length > 0) {
      scopes[scopeName] = scope;
    }
  }

  return {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes,
  };
}

function getOrCreateScope(scope: string): Record<string, RuntimeStateEntry> {
  const existing = runtimeState.scopes[scope];
  if (existing) {
    return existing;
  }
  const created: Record<string, RuntimeStateEntry> = {};
  runtimeState.scopes[scope] = created;
  return created;
}

function pruneScope(scope: string, now: number): void {
  const scopeState = runtimeState.scopes[scope];
  if (!scopeState) {
    return;
  }
  const lastPruneAt = scopeLastPruneAt.get(scope) ?? 0;
  if (now - lastPruneAt < DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS) {
    return;
  }
  scopeLastPruneAt.set(scope, now);

  for (const [key, entry] of Object.entries(scopeState)) {
    if (entry.expiresAt <= now) {
      delete scopeState[key];
    }
  }

  if (Object.keys(scopeState).length === 0) {
    delete runtimeState.scopes[scope];
  }
}

function trimScope(scope: string, maxEntriesRaw: number | undefined): void {
  const scopeState = runtimeState.scopes[scope];
  if (!scopeState) {
    return;
  }
  const maxEntries = Math.max(1, Math.floor(maxEntriesRaw ?? Number.POSITIVE_INFINITY));
  const entries = Object.entries(scopeState);
  if (!Number.isFinite(maxEntries) || entries.length <= maxEntries) {
    return;
  }

  entries
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, Math.max(0, entries.length - maxEntries))
    .forEach(([key]) => {
      delete scopeState[key];
    });
}

function persistRuntimeState(): void {
  if (!isRuntimeStatePersistenceEnabled()) {
    return;
  }

  try {
    const filePath = resolveRuntimeStateFile();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(runtimeState), "utf8");
  } catch {
    // Best-effort persistence. Runtime behavior should not fail on storage issues.
  }
}

function isRuntimeStatePersistenceEnabled(): boolean {
  const backend = (process.env.RUNTIME_STATE_BACKEND ?? "memory")
    .trim()
    .toLowerCase();
  return backend === "file" || backend === "fs";
}

function resolveRuntimeStateFile(): string {
  const raw = process.env.RUNTIME_STATE_FILE?.trim();
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_RUNTIME_STATE_FILE);
  }
  return resolve(raw);
}

function normalizeScope(scope: string): string {
  return scope.trim().slice(0, 80);
}

function normalizeKey(key: string): string {
  return key.trim().slice(0, 240);
}
