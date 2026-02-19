import { Module } from "@nestjs/common";

import { GithubWebhookController } from "./github.webhook.controller.js";
import { GithubWebhookService } from "./github.webhook.service.js";

@Module({
  controllers: [GithubWebhookController],
  providers: [GithubWebhookService],
})
export class GithubModule {}
