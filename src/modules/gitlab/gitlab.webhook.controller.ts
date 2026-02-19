import { Controller, Get, Headers, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import type { GitLabMrWebhookBody } from "#integrations/gitlab";
import { GitlabWebhookService } from "./gitlab.webhook.service.js";

@Controller("gitlab")
export class GitlabWebhookController {
  constructor(private readonly gitlabWebhookService: GitlabWebhookService) {}

  @Get("health")
  health(): { ok: boolean; name: string; mode: string } {
    return { ok: true, name: "mr-agent", mode: "gitlab-webhook" };
  }

  @Post("trigger")
  async trigger(
    @Req() request: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: boolean; message: string }> {
    return this.gitlabWebhookService.handleTrigger({
      payload: request.body as GitLabMrWebhookBody | undefined,
      headers,
    });
  }
}
