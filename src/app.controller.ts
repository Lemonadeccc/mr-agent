import { Controller, Get, Query } from "@nestjs/common";

import { AppService } from "./app.service.js";
import { isDeepHealthQuery, type HealthStatus } from "./modules/webhook/health.js";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  health(@Query("deep") deep?: string): Promise<HealthStatus> {
    return this.appService.getHealth({
      mode: "nest",
      deep: isDeepHealthQuery(deep),
    });
  }
}
