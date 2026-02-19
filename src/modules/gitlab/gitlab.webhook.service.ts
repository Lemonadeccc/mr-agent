import { Injectable, Logger } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { BadWebhookRequestError, WebhookAuthError, readNumberEnv } from "#core";
import {
  runGitLabWebhook,
  type GitLabWebhookBody,
} from "#integrations/gitlab";
import {
  formatLogMessage,
  normalizeHeaderRecord,
} from "../webhook/webhook.utils.js";

const gitlabWebhookPayloadSchema = z.object({
  object_kind: z.string().optional(),
  event_type: z.string().optional(),
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
  object_attributes: z.record(z.unknown()),
  merge_request: z.record(z.unknown()).optional(),
});

let hasWarnedMissingGitLabWebhookSecret = false;
const DEFAULT_GITLAB_WEBHOOK_MAX_BODY_BYTES = 10 * 1024 * 1024;

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
    payload: GitLabWebhookBody | undefined;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ ok: boolean; message: string }> {
    verifyGitLabWebhookPayloadSize(params.payload);
    const payload = parseGitLabPayload(params.payload);

    const normalizedHeaders = normalizeHeaderRecord(params.headers);
    verifyGitLabWebhookToken(normalizedHeaders, this.logger);

    // Backward compatibility: if webhook secret is not enabled,
    // keep accepting x-gitlab-token as API token.
    if (
      !normalizedHeaders["x-gitlab-api-token"] &&
      !process.env.GITLAB_WEBHOOK_SECRET &&
      normalizedHeaders["x-gitlab-token"]
    ) {
      normalizedHeaders["x-gitlab-api-token"] = normalizedHeaders["x-gitlab-token"];
    }

    return runGitLabWebhook({
      payload,
      headers: normalizedHeaders,
      logger: this.serviceLogger,
    });
  }
}

function verifyGitLabWebhookPayloadSize(payload: unknown): void {
  const maxBodyBytes = Math.max(
    1,
    readNumberEnv(
      "GITLAB_WEBHOOK_MAX_BODY_BYTES",
      DEFAULT_GITLAB_WEBHOOK_MAX_BODY_BYTES,
    ),
  );
  const payloadBytes = estimatePayloadSizeBytes(payload);
  if (payloadBytes <= maxBodyBytes) {
    return;
  }

  throw new BadWebhookRequestError(
    `gitlab webhook payload too large: ${payloadBytes} bytes exceeds GITLAB_WEBHOOK_MAX_BODY_BYTES=${maxBodyBytes}`,
  );
}

function estimatePayloadSizeBytes(payload: unknown): number {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  if (payload === null || payload === undefined) {
    return 0;
  }

  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") {
      return 0;
    }
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return 0;
  }
}

function parseGitLabPayload(payload: unknown): GitLabWebhookBody {
  const parsed = gitlabWebhookPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data as GitLabWebhookBody;
  }

  const firstIssue = parsed.error.issues[0];
  const issuePath = firstIssue?.path.join(".") || "payload";
  throw new BadWebhookRequestError(
    `invalid gitlab payload: ${issuePath} ${firstIssue?.message ?? "schema validation failed"}`,
  );
}

function verifyGitLabWebhookToken(
  headers: Record<string, string | undefined>,
  logger?: Pick<Logger, "warn">,
): void {
  const expected = process.env.GITLAB_WEBHOOK_SECRET?.trim();
  if (!expected) {
    if (shouldRequireGitLabWebhookSecret()) {
      throw new BadWebhookRequestError(
        "GITLAB_WEBHOOK_SECRET is required when GITLAB_REQUIRE_WEBHOOK_SECRET=true",
      );
    }
    if (!hasWarnedMissingGitLabWebhookSecret) {
      hasWarnedMissingGitLabWebhookSecret = true;
      logger?.warn(
        "GITLAB_WEBHOOK_SECRET is not configured; GitLab webhook signature verification is disabled.",
      );
    }
    return;
  }

  const actual = headers["x-gitlab-token"]?.trim();
  if (!actual) {
    throw new WebhookAuthError("invalid gitlab webhook token", 403);
  }

  if (!isGitLabWebhookTokenValid(expected, actual)) {
    throw new WebhookAuthError("invalid gitlab webhook token", 403);
  }
}

export function shouldRequireGitLabWebhookSecret(
  rawValue: string | undefined = process.env.GITLAB_REQUIRE_WEBHOOK_SECRET,
): boolean {
  const normalized = (rawValue ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export function isGitLabWebhookTokenValid(
  expected: string,
  actual: string,
): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}
