import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Express, RequestHandler } from "express";
import { createNodeMiddleware, createProbot } from "probot";

import { app as githubApp } from "../../app.js";

@Injectable()
export class GithubAppBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GithubAppBootstrapService.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) {
      return;
    }

    const expressApp = httpAdapter.getInstance() as Express;
    if (!isGitHubAppEnabled()) {
      this.logger.warn(
        "GitHub App mode disabled (missing APP_ID/PRIVATE_KEY/WEBHOOK_SECRET). Plain webhook mode is still available.",
      );
      return;
    }

    const probot = createProbot();
    const middleware = createNodeMiddleware(githubApp, {
      probot,
      webhooksPath: "/api/github/webhooks",
    });

    const expressMiddleware: RequestHandler = (
      request,
      response,
      next,
    ) => {
      void (middleware as (...args: unknown[]) => unknown)(
        request,
        response,
        next,
      );
    };
    expressApp.use(expressMiddleware);
    this.logger.log("GitHub App webhook mounted at /api/github/webhooks");
  }
}

function isGitHubAppEnabled(): boolean {
  const appId = process.env.APP_ID?.trim();
  const privateKey = process.env.PRIVATE_KEY?.trim();
  const privateKeyPath = process.env.PRIVATE_KEY_PATH?.trim();
  const webhookSecret = process.env.WEBHOOK_SECRET?.trim();

  return Boolean(appId && (privateKey || privateKeyPath) && webhookSecret);
}
