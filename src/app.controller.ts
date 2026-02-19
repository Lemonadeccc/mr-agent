import { Controller, Get } from "@nestjs/common";

import { AppService } from "./app.service.js";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  health(): { ok: boolean; name: string; mode: string } {
    return this.appService.getHealth();
  }
}
