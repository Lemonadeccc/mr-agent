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
import type { GitLabWebhookBody } from "#integrations/gitlab";
import {
  GitlabWebhookService,
  shouldRequireGitLabWebhookSecret,
} from "./gitlab.webhook.service.js";
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

@Controller("gitlab")
export class GitlabWebhookController {
  constructor(private readonly gitlabWebhookService: GitlabWebhookService) {}

  @Get("health")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    const requiresSecret = shouldRequireGitLabWebhookSecret();
    const webhookConfigured =
      !requiresSecret || Boolean(process.env.GITLAB_WEBHOOK_SECRET?.trim());
    return buildHealthStatus({
      mode: "gitlab-webhook",
      deep: isDeepHealthQuery(deep),
      webhook: {
        name: "gitlab-webhook-secret",
        configured: webhookConfigured,
      },
    });
  }

  @Post("trigger")
  async trigger(
    @Req() request: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    const eventName = (readHeaderValue(headers, "x-gitlab-event") ?? "unknown").toLowerCase();
    incrementMetricCounter("mr_agent_webhook_requests_total", {
      platform: "gitlab",
      event: eventName,
    });
    recordWebhookEvent({
      platform: "gitlab",
      eventName,
      headers,
      payload: request.body as GitLabWebhookBody | undefined,
      rawBody:
        typeof request.body === "undefined" ? undefined : safeJsonStringify(request.body),
    });

    try {
      const result = await this.gitlabWebhookService.handleTrigger({
        payload: request.body as GitLabWebhookBody | undefined,
        headers,
      });
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "gitlab",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_results_total", {
        platform: "gitlab",
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
      platform: "gitlab",
    });
    if (!event) {
      throw new BadWebhookRequestError(`webhook replay event not found: ${eventId}`);
    }

    const payload = resolveStoredWebhookReplayPayload(event);
    if (!payload || typeof payload !== "object") {
      throw new BadWebhookRequestError(`replay payload is invalid for event: ${eventId}`);
    }

    const replayHeaders: Record<string, string> = {
      ...event.headers,
      "x-gitlab-event": event.eventName,
    };
    const overrideApiToken = readHeaderValue(headers, "x-gitlab-api-token");
    if (overrideApiToken) {
      replayHeaders["x-gitlab-api-token"] = overrideApiToken;
    }
    const overrideWebhookToken = readHeaderValue(headers, "x-gitlab-token");
    if (overrideWebhookToken) {
      replayHeaders["x-gitlab-token"] = overrideWebhookToken;
    }

    try {
      const result = await this.gitlabWebhookService.handleTrigger({
        payload: payload as GitLabWebhookBody,
        headers: replayHeaders,
        trustReplay: true,
      });
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "gitlab",
        result: "ok",
      });
      return result;
    } catch (error) {
      incrementMetricCounter("mr_agent_webhook_replay_total", {
        platform: "gitlab",
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

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
