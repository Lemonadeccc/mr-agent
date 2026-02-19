import { Controller, Get, Headers, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import { GithubWebhookService } from "./github.webhook.service.js";

interface RawBodyRequest extends Request {
  rawBody?: Buffer | string;
}

@Controller("github")
export class GithubWebhookController {
  constructor(private readonly githubWebhookService: GithubWebhookService) {}

  @Get("health")
  health(): { ok: boolean; name: string; mode: string } {
    return { ok: true, name: "mr-agent", mode: "github-webhook" };
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
