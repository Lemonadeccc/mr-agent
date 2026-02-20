import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

type RuntimeStateBackend = "memory" | "file" | "fs" | "sqlite";

interface SqliteStatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close?(): void;
}

interface SqliteModuleLike {
  DatabaseSync: new (filename: string) => SqliteDatabaseLike;
}

interface SqliteStatements {
  load: SqliteStatementLike;
  save: SqliteStatementLike;
  delete: SqliteStatementLike;
  clearScope: SqliteStatementLike;
  clearAll: SqliteStatementLike;
  pruneExpiredScope: SqliteStatementLike;
  countScope: SqliteStatementLike;
  trimScope: SqliteStatementLike;
}

const DEFAULT_RUNTIME_STATE_VERSION = 1 as const;
const DEFAULT_RUNTIME_STATE_FILE = ".mr-agent-runtime-state.json";
const DEFAULT_RUNTIME_STATE_SQLITE_FILE = ".mr-agent-runtime-state.sqlite3";
const DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS = 1_000;
const DEFAULT_RUNTIME_STATE_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const scopeLastPruneAt = new Map<string, number>();
const require = createRequire(import.meta.url);

let loaded = false;
let runtimeState: RuntimeStateSnapshot = {
  version: DEFAULT_RUNTIME_STATE_VERSION,
  scopes: {},
};
let sqliteInitialized = false;
let sqliteDb: SqliteDatabaseLike | undefined;
let sqliteStatements: SqliteStatements | undefined;

export function resolveRuntimeStateBackend(
  rawValue: string | undefined = process.env.RUNTIME_STATE_BACKEND,
): RuntimeStateBackend {
  const backend = (rawValue ?? "memory").trim().toLowerCase();
  if (backend === "file" || backend === "fs") {
    return backend;
  }
  if (backend === "sqlite" || backend === "sqlite3") {
    return "sqlite";
  }
  return "memory";
}

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
  if (resolveRuntimeStateBackend() === "sqlite") {
    return loadRuntimeStateValueFromSqlite<T>(scopeName, stateKey, now);
  }

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
  if (resolveRuntimeStateBackend() === "sqlite") {
    saveRuntimeStateValueToSqlite({
      scope: scopeName,
      key: stateKey,
      value: params.value,
      expiresAt: params.expiresAt,
      maxEntries: params.maxEntries,
    });
    return;
  }

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
  if (resolveRuntimeStateBackend() === "sqlite") {
    sqliteStatements?.delete.run(scopeName, stateKey);
    return;
  }

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
  if (resolveRuntimeStateBackend() === "sqlite") {
    sqliteStatements?.clearScope.run(scopeName);
    scopeLastPruneAt.delete(scopeName);
    return;
  }

  if (!(scopeName in runtimeState.scopes)) {
    return;
  }
  delete runtimeState.scopes[scopeName];
  scopeLastPruneAt.delete(scopeName);
  persistRuntimeState();
}

export function __clearRuntimeStateForTests(): void {
  scopeLastPruneAt.clear();

  if (resolveRuntimeStateBackend() === "sqlite") {
    ensureSqliteInitialized();
    sqliteStatements?.clearAll.run();
    sqliteDb?.close?.();
    sqliteDb = undefined;
    sqliteStatements = undefined;
    sqliteInitialized = false;
  }

  loaded = true;
  runtimeState = {
    version: DEFAULT_RUNTIME_STATE_VERSION,
    scopes: {},
  };
  persistRuntimeState();
}

export function __getRuntimeStateScopeEntryCountForTests(scope: string): number {
  const scopeName = normalizeScope(scope);
  if (!scopeName) {
    return 0;
  }

  ensureRuntimeStateLoaded();
  if (resolveRuntimeStateBackend() === "sqlite") {
    const row = sqliteStatements?.countScope.get(scopeName) as
      | {
          count?: unknown;
        }
      | undefined;
    return toSafeInteger(row?.count);
  }

  return Object.keys(runtimeState.scopes[scopeName] ?? {}).length;
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

  const backend = resolveRuntimeStateBackend();
  if (backend === "sqlite") {
    ensureSqliteInitialized();
    return;
  }

  if (backend !== "file" && backend !== "fs") {
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

function ensureSqliteInitialized(): void {
  if (sqliteInitialized) {
    return;
  }
  sqliteInitialized = true;

  try {
    const sqliteModule = require("node:sqlite") as SqliteModuleLike;
    const filePath = resolveRuntimeStateSqliteFile();
    mkdirSync(dirname(filePath), { recursive: true });

    const db = new sqliteModule.DatabaseSync(filePath);
    const busyTimeoutMs = Math.max(
      1,
      toSafeInteger(
        process.env.RUNTIME_STATE_SQLITE_BUSY_TIMEOUT_MS,
        DEFAULT_RUNTIME_STATE_SQLITE_BUSY_TIMEOUT_MS,
      ),
    );

    db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = ${busyTimeoutMs};
CREATE TABLE IF NOT EXISTS runtime_state (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, key)
);
CREATE INDEX IF NOT EXISTS idx_runtime_state_scope_updated
  ON runtime_state(scope, updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_runtime_state_scope_expires
  ON runtime_state(scope, expires_at ASC);
`);

    sqliteDb = db;
    sqliteStatements = {
      load: db.prepare(
        "SELECT value, expires_at AS expiresAt, updated_at AS updatedAt FROM runtime_state WHERE scope = ? AND key = ?",
      ),
      save: db.prepare(
        "INSERT INTO runtime_state(scope, key, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
      ),
      delete: db.prepare("DELETE FROM runtime_state WHERE scope = ? AND key = ?"),
      clearScope: db.prepare("DELETE FROM runtime_state WHERE scope = ?"),
      clearAll: db.prepare("DELETE FROM runtime_state"),
      pruneExpiredScope: db.prepare(
        "DELETE FROM runtime_state WHERE scope = ? AND expires_at <= ?",
      ),
      countScope: db.prepare("SELECT COUNT(*) AS count FROM runtime_state WHERE scope = ?"),
      trimScope: db.prepare(
        "DELETE FROM runtime_state WHERE rowid IN (SELECT rowid FROM runtime_state WHERE scope = ? ORDER BY updated_at ASC LIMIT ?)",
      ),
    };
  } catch {
    sqliteDb = undefined;
    sqliteStatements = undefined;
  }
}

function loadRuntimeStateValueFromSqlite<T>(
  scope: string,
  key: string,
  now: number,
): T | undefined {
  ensureSqliteInitialized();
  if (!sqliteStatements) {
    return undefined;
  }

  pruneSqliteScope(scope, now);

  const row = sqliteStatements.load.get(scope, key) as
    | {
        value?: unknown;
        expiresAt?: unknown;
      }
    | undefined;
  if (!row) {
    return undefined;
  }

  const expiresAt = toSafeInteger(row.expiresAt);
  if (expiresAt <= now) {
    sqliteStatements.delete.run(scope, key);
    return undefined;
  }

  if (typeof row.value !== "string") {
    sqliteStatements.delete.run(scope, key);
    return undefined;
  }

  try {
    return JSON.parse(row.value) as T;
  } catch {
    sqliteStatements.delete.run(scope, key);
    return undefined;
  }
}

function saveRuntimeStateValueToSqlite<T>(params: {
  scope: string;
  key: string;
  value: T;
  expiresAt: number;
  maxEntries?: number;
}): void {
  ensureSqliteInitialized();
  if (!sqliteStatements) {
    return;
  }

  const now = Date.now();
  let serializedValue = "";
  try {
    serializedValue = JSON.stringify(params.value);
  } catch {
    return;
  }

  sqliteStatements.save.run(
    params.scope,
    params.key,
    serializedValue,
    Math.max(0, Math.floor(params.expiresAt)),
    now,
  );

  pruneSqliteScope(params.scope, now);
  trimSqliteScope(params.scope, params.maxEntries);
}

function pruneSqliteScope(scope: string, now: number): void {
  if (!sqliteStatements) {
    return;
  }

  const lastPruneAt = scopeLastPruneAt.get(scope) ?? 0;
  if (now - lastPruneAt < DEFAULT_RUNTIME_STATE_PRUNE_INTERVAL_MS) {
    return;
  }
  scopeLastPruneAt.set(scope, now);

  sqliteStatements.pruneExpiredScope.run(scope, now);
}

function trimSqliteScope(scope: string, maxEntriesRaw: number | undefined): void {
  if (!sqliteStatements) {
    return;
  }

  const maxEntries = Math.max(1, Math.floor(maxEntriesRaw ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(maxEntries)) {
    return;
  }

  const row = sqliteStatements.countScope.get(scope) as
    | {
        count?: unknown;
      }
    | undefined;
  const count = toSafeInteger(row?.count);
  const overflow = Math.max(0, count - maxEntries);
  if (overflow <= 0) {
    return;
  }

  sqliteStatements.trimScope.run(scope, overflow);
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
  const backend = resolveRuntimeStateBackend();
  if (backend !== "file" && backend !== "fs") {
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

function resolveRuntimeStateFile(): string {
  const raw = process.env.RUNTIME_STATE_FILE?.trim();
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_RUNTIME_STATE_FILE);
  }
  return resolve(raw);
}

function resolveRuntimeStateSqliteFile(): string {
  const raw = process.env.RUNTIME_STATE_SQLITE_FILE?.trim();
  if (!raw) {
    return resolve(process.cwd(), DEFAULT_RUNTIME_STATE_SQLITE_FILE);
  }
  return resolve(raw);
}

function normalizeScope(scope: string): string {
  return scope.trim().slice(0, 80);
}

function normalizeKey(key: string): string {
  return key.trim().slice(0, 240);
}

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number.MIN_SAFE_INTEGER;
    }
    return Number(value);
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}
