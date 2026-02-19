import { readNumberEnv } from "./env.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BACKOFF_MS = 400;

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
  const timeoutMs = options.timeoutMs ?? readNumberEnv("HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const retries = options.retries ?? readNumberEnv("HTTP_RETRIES", DEFAULT_RETRY_COUNT);
  const backoffMs =
    options.backoffMs ?? readNumberEnv("HTTP_RETRY_BACKOFF_MS", DEFAULT_RETRY_BACKOFF_MS);
  const retryOnStatuses =
    options.retryOnStatuses ?? [408, 409, 425, 429, 500, 502, 503, 504];

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
    const signal = mergeAbortSignals(controller.signal, init.signal);

    try {
      const response = await fetch(input, {
        ...init,
        signal,
      });
      clearTimeout(timeout);

      if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
        return response;
      }

      await wait(backoffMs * (attempt + 1));
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt === retries) {
        break;
      }

      await wait(backoffMs * (attempt + 1));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("request failed after retries");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeAbortSignals(
  timeoutSignal: AbortSignal,
  inputSignal: AbortSignal | null | undefined,
): AbortSignal {
  if (!inputSignal) {
    return timeoutSignal;
  }

  return AbortSignal.any([timeoutSignal, inputSignal]);
}
