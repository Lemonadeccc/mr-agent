import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { BadWebhookRequestError, WebhookAuthError } from "#core";
import { incrementMetricCounter } from "../../modules/webhook/metrics.js";

interface ResolvedError {
  status: number;
  message: string;
  type: string;
  details?: unknown;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const resolved = this.resolveError(exception);
    incrementMetricCounter("mr_agent_http_errors_total", {
      type: resolved.type,
      status: `${resolved.status}`,
    });

    const body = {
      ok: false,
      error: resolved.message,
      type: resolved.type,
      status: resolved.status,
      path: request?.originalUrl ?? request?.url ?? "",
      method: request?.method ?? "",
      timestamp: new Date().toISOString(),
      details: resolved.details,
    };

    this.logger.error(
      JSON.stringify({
        ...body,
        exception: this.buildExceptionLog(exception),
      }),
    );

    response.status(resolved.status).json(body);
  }

  private resolveError(exception: unknown): ResolvedError {
    if (
      exception instanceof BadWebhookRequestError ||
      exception instanceof WebhookAuthError
    ) {
      return {
        status: exception.statusCode,
        message: exception.message,
        type: exception.name,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === "string") {
        return {
          status,
          message: payload,
          type: exception.name,
        };
      }

      const payloadMessage = this.extractHttpExceptionMessage(payload);
      return {
        status,
        message: payloadMessage ?? exception.message,
        type: exception.name,
        details: payload && typeof payload === "object" ? payload : undefined,
      };
    }

    if (exception instanceof Error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: exception.message,
        type: exception.name,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "internal server error",
      type: "UnknownError",
    };
  }

  private extractHttpExceptionMessage(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object" || !("message" in payload)) {
      return undefined;
    }

    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }

    if (Array.isArray(message)) {
      return message
        .filter((item): item is string => typeof item === "string")
        .join("; ");
    }

    return undefined;
  }

  private buildExceptionLog(exception: unknown): Record<string, unknown> | undefined {
    if (!(exception instanceof Error)) {
      return undefined;
    }

    return {
      name: exception.name,
      message: exception.message,
      stack:
        (process.env.EXPOSE_ERROR_STACK ?? "").toLowerCase() === "true"
          ? exception.stack
          : undefined,
    };
  }
}
