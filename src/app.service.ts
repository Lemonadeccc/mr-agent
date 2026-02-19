import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  getHealth(): { ok: boolean; name: string; mode: string } {
    return { ok: true, name: "mr-agent", mode: "nest" };
  }
}
