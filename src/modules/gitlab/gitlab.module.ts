import { Module } from "@nestjs/common";

import { GitlabWebhookController } from "./gitlab.webhook.controller.js";
import { GitlabWebhookService } from "./gitlab.webhook.service.js";

@Module({
  controllers: [GitlabWebhookController],
  providers: [GitlabWebhookService],
})
export class GitlabModule {}
