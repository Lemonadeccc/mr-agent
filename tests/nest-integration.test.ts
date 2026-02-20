import assert from "node:assert/strict";
import test from "node:test";
import "reflect-metadata";

import { AppController } from "../src/app.controller.js";
import { AppModule } from "../src/app.module.js";
import { AppService } from "../src/app.service.js";
import { HttpErrorFilter } from "../src/common/filters/http-error.filter.js";
import { BadWebhookRequestError } from "../src/core/errors.js";
import { GithubWebhookController } from "../src/modules/github/github.webhook.controller.js";
import { GithubWebhookService } from "../src/modules/github/github.webhook.service.js";
import { GitlabWebhookController } from "../src/modules/gitlab/gitlab.webhook.controller.js";
import { GitlabWebhookService } from "../src/modules/gitlab/gitlab.webhook.service.js";
import { __resetMetricsForTests } from "../src/modules/webhook/metrics.js";

interface MockResponse {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => void;
}

test("nestjs module metadata declares expected imports/controllers/providers", () => {
  const imports = (Reflect.getMetadata("imports", AppModule) as unknown[]) ?? [];
  const controllers =
    (Reflect.getMetadata("controllers", AppModule) as unknown[]) ?? [];
  const providers = (Reflect.getMetadata("providers", AppModule) as unknown[]) ?? [];

  assert.ok(imports.length >= 2);
  assert.ok(controllers.includes(AppController));
  assert.ok(providers.includes(AppService));
});

test("nestjs controllers expose health/metrics and validate webhook payloads", async () => {
  __resetMetricsForTests();
  const appController = new AppController(new AppService());
  const githubController = new GithubWebhookController(new GithubWebhookService());
  const gitlabController = new GitlabWebhookController(new GitlabWebhookService());

  const health = await appController.health();
  assert.equal(health.ok, true);

  const metrics = appController.metrics();
  assert.match(metrics, /mr_agent_process_uptime_seconds/);

  const githubHealth = await githubController.health();
  assert.equal(githubHealth.ok, true);

  const gitlabHealth = await gitlabController.health();
  assert.equal(gitlabHealth.ok, true);

  await assert.rejects(
    () =>
      githubController.trigger(
        {
          body: {},
          rawBody: "{}",
        } as never,
        {
          "content-type": "application/json",
        },
      ),
    /missing x-github-event header/i,
  );

  await assert.rejects(
    () =>
      gitlabController.trigger(
        {
          body: {},
        } as never,
        {
          "content-type": "application/json",
        },
      ),
    /invalid gitlab payload/i,
  );
});

test("http error filter serializes webhook errors consistently", () => {
  const filter = new HttpErrorFilter();
  const response = createMockResponse();
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        originalUrl: "/github/trigger",
        method: "POST",
      }),
    }),
  };

  filter.catch(new BadWebhookRequestError("invalid webhook payload"), host as never);

  assert.equal(response.statusCode, 400);
  const body = response.body as {
    ok?: boolean;
    type?: string;
    path?: string;
    method?: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.type, "BadWebhookRequestError");
  assert.equal(body.path, "/github/trigger");
  assert.equal(body.method, "POST");
});

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    body: undefined,
    status(code: number): MockResponse {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown): void {
      response.body = payload;
    },
  };
  return response;
}
