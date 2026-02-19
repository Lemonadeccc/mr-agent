import { Injectable, Logger } from "@nestjs/common";

import { BadWebhookRequestError } from "#core";
import {
  type LoggerLike,
  handlePlainGitHubWebhook,
} from "#integrations/github";
import {
  formatLogMessage,
  normalizeHeaderRecord,
} from "../webhook/webhook.utils.js";

@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger(GithubWebhookService.name);

  private readonly serviceLogger: LoggerLike = {
    info: (metadata, message) => {
      this.logger.log(formatLogMessage(message, metadata));
    },
    error: (metadata, message) => {
      this.logger.error(formatLogMessage(message, metadata));
    },
  };

  async handleTrigger(params: {
    payload: unknown;
    rawBody?: Buffer | string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ ok: boolean; message: string }> {
    const normalizedHeaders = normalizeHeaderRecord(params.headers);
    const rawBody =
      readRawBody(params.rawBody) ??
      buildFallbackRawBodyForSignatureSkip(params.payload);

    if (!rawBody) {
      throw new BadWebhookRequestError(
        "missing raw body for signature check",
      );
    }

    return handlePlainGitHubWebhook({
      payload: params.payload,
      rawBody,
      headers: normalizedHeaders,
      logger: this.serviceLogger,
    });
  }
}

function readRawBody(rawBody: Buffer | string | undefined): string | undefined {
  if (typeof rawBody === "string") {
    return rawBody;
  }

  if (Buffer.isBuffer(rawBody)) {
    return rawBody.toString("utf8");
  }

  return undefined;
}

function buildFallbackRawBodyForSignatureSkip(
  body: unknown,
): string | undefined {
  const skipSignature =
    (process.env.GITHUB_WEBHOOK_SKIP_SIGNATURE ?? "").toLowerCase() === "true";
  if (!skipSignature || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}
