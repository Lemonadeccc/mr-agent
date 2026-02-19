import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { AppController } from "./app.controller.js";
import { AppService } from "./app.service.js";
import { HttpErrorFilter } from "./common/filters/http-error.filter.js";
import { GithubAppModule } from "./modules/github-app/github-app.module.js";
import { GithubModule } from "./modules/github/github.module.js";
import { GitlabModule } from "./modules/gitlab/gitlab.module.js";

@Module({
  imports: [GithubModule, GitlabModule, GithubAppModule],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: HttpErrorFilter,
    },
  ],
})
export class AppModule {}
