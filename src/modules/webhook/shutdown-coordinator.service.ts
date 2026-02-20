import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";

import { beginHttpShutdown } from "#core";
import { beginAiShutdown, drainAiRequests } from "#review";

@Injectable()
export class ShutdownCoordinatorService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownCoordinatorService.name);

  async onApplicationShutdown(signal?: string): Promise<void> {
    beginHttpShutdown();
    beginAiShutdown();
    const drained = await drainAiRequests();
    if (!drained) {
      this.logger.warn(
        `Application shutdown (${signal ?? "unknown"}): timed out while draining AI requests`,
      );
      return;
    }

    this.logger.log(
      `Application shutdown (${signal ?? "unknown"}): AI requests drained`,
    );
  }
}
