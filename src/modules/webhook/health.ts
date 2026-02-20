import { readNumberEnv } from "#core";
import { probeAiProviderConnectivity, type AiProviderProbeResult } from "#review";

export interface WebhookHealthCheck {
  name: string;
  configured: boolean;
}

export interface HealthStatus {
  ok: boolean;
  name: string;
  mode: string;
  checks?: {
    ai: AiProviderProbeResult;
    webhook?: WebhookHealthCheck;
  };
}

export function isDeepHealthQuery(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on" ||
    normalized === "deep"
  );
}

export async function buildHealthStatus(params: {
  mode: string;
  deep: boolean;
  webhook?: WebhookHealthCheck;
}): Promise<HealthStatus> {
  const base: HealthStatus = {
    ok: true,
    name: "mr-agent",
    mode: params.mode,
  };

  if (!params.deep) {
    return base;
  }

  const ai = await probeAiProviderConnectivity({
    timeoutMs: readNumberEnv("HEALTHCHECK_AI_TIMEOUT_MS", 5_000),
  });

  const checks: HealthStatus["checks"] = {
    ai,
  };
  if (params.webhook) {
    checks.webhook = params.webhook;
  }

  const webhookOk = params.webhook ? params.webhook.configured : true;
  return {
    ...base,
    ok: ai.ok && webhookOk,
    checks,
  };
}
