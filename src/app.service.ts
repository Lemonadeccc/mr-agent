import { Injectable } from "@nestjs/common";
import { buildHealthStatus, type HealthStatus } from "./modules/webhook/health.js";

@Injectable()
export class AppService {
  getHealth(params?: { mode?: string; deep?: boolean }): Promise<HealthStatus> {
    return buildHealthStatus({
      mode: params?.mode ?? "nest",
      deep: Boolean(params?.deep),
    });
  }
}
