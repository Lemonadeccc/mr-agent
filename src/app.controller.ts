import { Controller, Get, Header, Headers, Query } from "@nestjs/common";

import { AppService } from "./app.service.js";
import { isDeepHealthQuery, type HealthStatus } from "./modules/webhook/health.js";
import { renderPrometheusMetrics } from "./modules/webhook/metrics.js";
import {
  assertWebhookReplayAuthorized,
  listStoredWebhookEvents,
  resolveWebhookEventListLimit,
  type ReplayPlatform,
  type StoredWebhookEventSummary,
} from "./modules/webhook/webhook-replay.js";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    return this.appService.getHealth({
      mode: "nest",
      deep: isDeepHealthQuery(deep),
    });
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  metrics(): string {
    return renderPrometheusMetrics();
  }

  @Get("webhook/events")
  webhookEvents(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query("platform") platformRaw?: string,
    @Query("limit") limitRaw?: string,
  ): StoredWebhookEventSummary[] {
    assertWebhookReplayAuthorized(headers);
    const platform = normalizeReplayPlatform(platformRaw);
    const limit = resolveWebhookEventListLimit(limitRaw);
    return listStoredWebhookEvents({ platform, limit });
  }
}

function normalizeReplayPlatform(value: string | undefined): ReplayPlatform | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "github" || normalized === "gitlab") {
    return normalized;
  }
  return undefined;
}
