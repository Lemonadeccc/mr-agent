import { Controller, Get, Headers, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";

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
    return this.gitlabWebhookService.handleTrigger({
      payload: request.body as GitLabWebhookBody | undefined,
      headers,
    });
  }
}
