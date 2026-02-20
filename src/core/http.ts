import { readNumberEnv } from "./env.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BACKOFF_MS = 400;
const HTTP_SHUTDOWN_ERROR_MESSAGE = "http client is shutting down";

let httpShutdownRequested = false;
let httpShutdownController = new AbortController();

export interface FetchRetryOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  retryOnStatuses?: number[];
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  if (httpShutdownRequested) {
    throw new Error(HTTP_SHUTDOWN_ERROR_MESSAGE);
  }

  const timeoutMs = options.timeoutMs ?? readNumberEnv("HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const retries = options.retries ?? readNumberEnv("HTTP_RETRIES", DEFAULT_RETRY_COUNT);
  const backoffMs =
    options.backoffMs ?? readNumberEnv("HTTP_RETRY_BACKOFF_MS", DEFAULT_RETRY_BACKOFF_MS);
  const retryOnStatuses =
    options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504];

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (httpShutdownRequested) {
      throw new Error(HTTP_SHUTDOWN_ERROR_MESSAGE);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
    const signal = mergeAbortSignals([
      controller.signal,
      init.signal,
      httpShutdownController.signal,
    ]);

    try {
      const response = await fetch(input, {
        ...init,
        signal,
      });
      clearTimeout(timeout);

      if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
        return response;
      }

      await wait(computeRetryDelayMs(attempt, backoffMs));
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (httpShutdownRequested) {
        throw new Error(HTTP_SHUTDOWN_ERROR_MESSAGE);
      }

      if (attempt === retries) {
        break;
      }

      await wait(computeRetryDelayMs(attempt, backoffMs));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("request failed after retries");
}

export function beginHttpShutdown(): void {
  if (httpShutdownRequested) {
    return;
  }
  httpShutdownRequested = true;
  httpShutdownController.abort(new Error(HTTP_SHUTDOWN_ERROR_MESSAGE));
}

export function isHttpShutdownRequested(): boolean {
  return httpShutdownRequested;
}

export function getHttpShutdownSignal(): AbortSignal {
  return httpShutdownController.signal;
}

export function __resetHttpShutdownForTests(): void {
  httpShutdownRequested = false;
  httpShutdownController = new AbortController();
}

export function computeRetryDelayMs(
  attempt: number,
  backoffMs: number,
  randomValue = Math.random(),
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const safeBackoffMs = Math.max(0, Math.floor(backoffMs));
  const baseDelay = safeBackoffMs * 2 ** safeAttempt;
  const jitterMax = safeBackoffMs * 0.2;
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  const jitter = Math.floor(jitterMax * normalizedRandom);
  return Math.floor(baseDelay + jitter);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return new AbortController().signal;
  }

  if (active.length === 1) {
    return active[0] ?? new AbortController().signal;
  }

  return AbortSignal.any(active);
}
