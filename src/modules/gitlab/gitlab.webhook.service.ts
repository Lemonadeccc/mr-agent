import { Injectable, Logger } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { BadWebhookRequestError, WebhookAuthError } from "#core";
import {
  runGitLabReview,
  type GitLabMrWebhookBody,
} from "#integrations/gitlab";
import {
  formatLogMessage,
  normalizeHeaderRecord,
} from "../webhook/webhook.utils.js";

const gitlabWebhookPayloadSchema = z.object({
  object_kind: z.string().optional(),
  user: z
    .object({
      username: z.string().optional(),
    })
    .optional(),
  project: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    web_url: z.string().min(1),
    path_with_namespace: z.string().optional(),
  }),
  object_attributes: z.object({
    action: z.string().optional(),
    state: z.string().optional(),
    iid: z.number().int().positive(),
    url: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    source_branch: z.string().min(1),
    target_branch: z.string().min(1),
  }),
});

@Injectable()
export class GitlabWebhookService {
  private readonly logger = new Logger(GitlabWebhookService.name);

  private readonly serviceLogger = {
    info: (metadata: unknown, message: string) => {
      this.logger.log(formatLogMessage(message, metadata));
    },
    error: (metadata: unknown, message: string) => {
      this.logger.error(formatLogMessage(message, metadata));
    },
  };

  async handleTrigger(params: {
    payload: GitLabMrWebhookBody | undefined;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ ok: boolean; message: string }> {
    const payload = parseGitLabPayload(params.payload);

    const normalizedHeaders = normalizeHeaderRecord(params.headers);
    verifyGitLabWebhookToken(normalizedHeaders);

    // Backward compatibility: if webhook secret is not enabled,
    // keep accepting x-gitlab-token as API token.
    if (
      !normalizedHeaders["x-gitlab-api-token"] &&
      !process.env.GITLAB_WEBHOOK_SECRET &&
      normalizedHeaders["x-gitlab-token"]
    ) {
      normalizedHeaders["x-gitlab-api-token"] = normalizedHeaders["x-gitlab-token"];
    }

    return runGitLabReview({
      payload,
      headers: normalizedHeaders,
      logger: this.serviceLogger,
    });
  }
}

function parseGitLabPayload(payload: unknown): GitLabMrWebhookBody {
  const parsed = gitlabWebhookPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data as GitLabMrWebhookBody;
  }

  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join(".") || "payload";
  throw new BadWebhookRequestError(
    `invalid gitlab payload: ${issuePath} ${firstIssue?.message ?? "schema validation failed"}`,
  );
}

function verifyGitLabWebhookToken(
  headers: Record<string, string | undefined>,
): void {
  const expected = process.env.GITLAB_WEBHOOK_SECRET?.trim();
  if (!expected) {
    return;
  }

  const actual = headers["x-gitlab-token"]?.trim();
  if (!actual) {
    throw new WebhookAuthError("invalid gitlab webhook token", 403);
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new WebhookAuthError("invalid gitlab webhook token", 403);
  }
}
