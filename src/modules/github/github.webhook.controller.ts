import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import { BadWebhookRequestError } from "#core";
import { GithubWebhookService } from "./github.webhook.service.js";
import {
  buildHealthStatus,
  isDeepHealthQuery,
  type HealthStatus,
} from "../webhook/health.js";
import { incrementMetricCounter } from "../webhook/metrics.js";
import {
  assertWebhookReplayAuthorized,
  getStoredWebhookEventById,
  recordWebhookEvent,
  resolveStoredWebhookReplayPayload,
} from "../webhook/webhook-replay.js";

interface RawBodyRequest extends Request {
  rawBody?: Buffer | string;
}

@Controller("github")
export class GithubWebhookController {
  constructor(private readonly githubWebhookService: GithubWebhookService) {}

  @Get("health")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    const webhookConfigured = Boolean(
      (process.env.GITHUB_WEBHOOK_SECRET ?? process.env.WEBHOOK_SECRET)?.trim(),
    );
    return buildHealthStatus({
      mode: "github-webhook",
      deep: isDeepHealthQuery(deep),
      webhook: {
        name: "github-webhook-secret",
        configured: webhookConfigured,
      },
    });
  }

  @Post("trigger")
  async trigger(
    @Req() request: RawBodyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    const eventName = (readHeaderValue(headers, "x-github-event") ?? "unknown").toLowerCase();
    incrementMetricCounter("mr_agent_webhook_requests_total", {
      platform: "github",
      event: eventName,
    });
    recordWebhookEvent({
      platform: "github",
      eventName,
      headers,
      payload: request.body,
      rawBody: readRawBody(request.rawBody),
    });

    try {
      const result = await this.githubWebhookService.handleTrigger({
        payload: request.body,
        rawBody: request.rawBody,
        headers,
      });
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "github",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "github",
        result: "error",
      });
      throw error;
    }
  }

  @Post("replay/:eventId")
  async replay(
    @Param("eventId") eventId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    assertWebhookReplayAuthorized(headers);
    const event = getStoredWebhookEventById({
      id: eventId,
      platform: "github",
    });
    if (!event) {
      throw new BadWebhookRequestError(`webhook replay event not found: ${eventId}`);
    }

    const payload = resolveStoredWebhookReplayPayload(event);
    if (typeof payload === "undefined") {
      throw new BadWebhookRequestError(`replay payload is empty for event: ${eventId}`);
    }

    try {
      const result = await this.githubWebhookService.handleTrigger({
        payload,
        rawBody: event.rawBody,
        headers: {
          ...event.headers,
          "x-github-event": event.eventName,
        },
        trustReplay: true,
      });
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "github",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "github",
        result: "error",
      });
      throw error;
    }
  }
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  targetKey: string,
): string | undefined {
  const direct = headers[targetKey];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    return direct[0];
  }

  const target = targetKey.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value[0];
    }
  }
  return undefined;
}

function readRawBody(rawBody: Buffer | string | undefined): string | undefined {
  if (typeof rawBody === "string") {
    return rawBody;
  }
  if (Buffer.isBuffer(rawBody)) {
    return rawBody.toString("utf8");
  }
  return undefined;
}
