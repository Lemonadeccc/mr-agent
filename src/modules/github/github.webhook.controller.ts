import { Controller, Get, Headers, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";

import { GithubWebhookService } from "./github.webhook.service.js";
import {
  buildHealthStatus,
  isDeepHealthQuery,
  type HealthStatus,
} from "../webhook/health.js";

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
    return this.githubWebhookService.handleTrigger({
      payload: request.body,
      rawBody: request.rawBody,
      headers,
    });
  }
}
