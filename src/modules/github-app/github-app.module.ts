import { Module } from "@nestjs/common";

import { GithubAppBootstrapService } from "./github-app.bootstrap.service.js";

@Module({
  providers: [GithubAppBootstrapService],
})
export class GithubAppModule {}
